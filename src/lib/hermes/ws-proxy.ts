/**
 * src/lib/hermes/ws-proxy.ts
 *
 * Authenticated WebSocket reverse proxy between browser and per-user
 * Hermes bridge (port 18789 inside the user's container).
 *
 * Mirrors `src/lib/openclaw/ws-proxy.ts` semantics:
 *   - Browser authenticates via NextAuth session cookie (JWT)
 *   - Server resolves userId → container (host, port, bridgeToken) from DB
 *   - Browser NEVER sees container address or bridgeToken
 *   - Server performs the `connect` handshake upstream with bridgeToken
 *   - Server forwards every subsequent frame bidirectionally
 *   - Energy gating is enforced INSIDE the bridge (not here) because the
 *     bridge talks directly to the portal /api/users/me/energy endpoint
 *     with the same bridgeToken; this proxy stays a thin pass-through
 *     so the same wire contract works for direct-to-bridge clients (admin
 *     scripts) without re-implementing gates.
 *
 * Wire gotchas preserved:
 *   - G1: Three-thing auth via the `connect` frame sent upstream
 *   - G7: WS close reason ≤120 bytes (truncate on errors)
 */

import { randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import { WebSocketServer, WebSocket as WsWebSocket, type RawData } from "ws";
import { getToken } from "next-auth/jwt";
import { and, eq, isNull } from "drizzle-orm";

import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { resolveAccessState } from "@/lib/billing/trial-resolver";
import { trackEvent } from "@/lib/analytics/track";
import { hermesConfig } from "./config";

const getAuthSecret = () => process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
const getUseSecureCookie = () =>
  !!process.env.AUTH_URL && process.env.AUTH_URL.startsWith("https://");

const PORTAL_CLIENT_INSTANCE = process.env.HOSTNAME ?? "agentbuff-portal";

// Magic string the bridge expects in the connect frame's client.id.
// MUST match docker/hermes-bridge/auth.py EXPECTED_CLIENT_ID.
const BRIDGE_MAGIC_CLIENT_ID = "agentbuff-portal";

// How often an open WS connection re-reads users.suspended to self-kick. Bounds
// the suspend race to <= this interval; one indexed-PK read per connection.
const SUSPEND_WATCH_MS = 5_000;

// In-process dedup for the F2 "first-chat" activation event. After the first
// chat.send per user in this process, the Set short-circuits so we never touch
// the DB again for that user. The DB null->now() flip is the authoritative
// once-per-user guard across process restarts; this Set just avoids re-querying.
const firstChatSeen = new Set<string>();

// Emit the F2 "first-chat" activation event exactly once per user. The atomic
// UPDATE ... WHERE first_chat_at IS NULL returns a row only on the genuine first
// chat, which is what gates trackEvent — reconnects/restarts don't double-count.
// Fully fail-safe: a DB hiccup must never affect chat forwarding.
async function markFirstChat(userId: string): Promise<void> {
  if (firstChatSeen.has(userId)) return;
  firstChatSeen.add(userId);
  try {
    const flipped = await db
      .update(schema.userProfiles)
      .set({ firstChatAt: new Date() })
      .where(
        and(
          eq(schema.userProfiles.userId, userId),
          isNull(schema.userProfiles.firstChatAt),
        ),
      )
      .returning({ userId: schema.userProfiles.userId });
    if (flipped.length > 0) trackEvent("first_chat", { userId });
  } catch {
    // Transient DB error on the genuine first chat: drop the in-memory mark so the
    // NEXT chat.send retries the atomic flip (idempotent via WHERE first_chat_at
    // IS NULL). Without this, the user is suppressed for the whole process.
    firstChatSeen.delete(userId);
  }
}

// Bridge-side scopes mirror operator role from OpenClaw model
const OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];

// Frame ceiling on the portal-facing WS server. Must exceed the bridge's
// own `MAX_WS_MESSAGE_SIZE` (384 MB) so an attachment uploaded by the
// browser can transit portal → bridge without being truncated. Without
// this option, ws defaults to 100 MB.
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 384 * 1024 * 1024, // 384 MB
});

type ClientFrame =
  | { type: "req"; id: string; method: string; params?: unknown }
  | { type: "res"; id: string; ok: boolean; payload?: unknown; error?: unknown }
  | { type: "event"; event: string; payload?: unknown };

interface UpstreamInfo {
  port: number;
  bridgeToken: string;
  containerName: string;
  host: string;
}

async function resolveUserFromRequest(
  req: IncomingMessage,
): Promise<{ userId: string } | null> {
  const AUTH_SECRET = getAuthSecret();
  const USE_SECURE_COOKIE = getUseSecureCookie();
  if (!AUTH_SECRET) {
    console.log("[hermes/ws-proxy] AUTH_SECRET missing");
    return null;
  }

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") headers[k] = v;
    else if (Array.isArray(v)) headers[k] = v.join(", ");
  }

  for (const salt of [
    "authjs.session-token",
    "next-auth.session-token",
    "__Secure-authjs.session-token",
    "__Secure-next-auth.session-token",
  ]) {
    try {
      const token = await getToken({
        req: { headers } as IncomingMessage & { headers: Record<string, string> },
        secret: AUTH_SECRET,
        secureCookie: USE_SECURE_COOKIE,
        salt,
      });
      if (token) {
        const userId =
          (token as { id?: string; sub?: string }).id ??
          (token as { sub?: string }).sub;
        return userId ? { userId } : null;
      }
    } catch {
      // try next salt variant
    }
  }
  return null;
}

async function resolveUpstream(userId: string): Promise<UpstreamInfo | null> {
  const [row] = await db
    .select({
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
      containerName: schema.userContainers.containerName,
      status: schema.userContainers.status,
      suspended: schema.users.suspended,
    })
    .from(schema.userContainers)
    .leftJoin(schema.users, eq(schema.users.id, schema.userContainers.userId))
    .where(eq(schema.userContainers.userId, userId))
    .limit(1);

  if (!row) return null;
  // Suspended-account gate at the WS layer. The admin suspend action fires
  // stopContainer() fire-and-forget, so the container can still be "running"
  // for the seconds it takes Docker to stop. Without this read, a suspended
  // user could reconnect (or keep an open tab) during that race. Block the
  // upstream the moment the DB says suspended. (Already-open tabs are kicked
  // by the periodic suspend-watch in HermesProxyConnection.)
  if (row.suspended) return null;
  if (row.status !== "running") return null;
  if (!row.gatewayToken) return null;

  // Trial-lock enforcement at the WS layer — deterministic, beyond the client
  // overlay + the (eventual) docker-stop. A locked user (trial ended, no active
  // sub) is refused the upstream connection so chat can't bypass the overlay or
  // beat the lifecycle worker's sweep. One extra DB read per connect.
  const access = await resolveAccessState(userId);
  if (access.locked) return null;

  return {
    port: row.port,
    bridgeToken: row.gatewayToken,
    containerName: row.containerName,
    host: hermesConfig.bindHost,
  };
}

function safeJsonParse(raw: RawData): ClientFrame | null {
  try {
    const text =
      typeof raw === "string"
        ? raw
        : Buffer.isBuffer(raw)
          ? raw.toString("utf8")
          : Buffer.concat(raw as Buffer[]).toString("utf8");
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && "type" in parsed) {
      return parsed as ClientFrame;
    }
    return null;
  } catch {
    return null;
  }
}

function sendFrame(ws: WsWebSocket, frame: unknown) {
  if (ws.readyState === WsWebSocket.OPEN) {
    ws.send(JSON.stringify(frame));
  }
}

function replyError(ws: WsWebSocket, id: string, code: string, message: string) {
  sendFrame(ws, { type: "res", id, ok: false, error: { code, message } });
}

class HermesProxyConnection {
  private browser: WsWebSocket;
  private upstream: WsWebSocket | null = null;
  private upstreamReady = false;
  private queued: unknown[] = [];
  private userId: string;
  private info: UpstreamInfo;
  private closed = false;
  private internalConnectId: string | null = null;
  private suspendWatch: ReturnType<typeof setInterval> | null = null;

  constructor(browser: WsWebSocket, userId: string, info: UpstreamInfo) {
    this.browser = browser;
    this.userId = userId;
    this.info = info;

    this.browser.on("message", (raw) => this.onBrowserMessage(raw));
    this.browser.on("close", () => this.close("browser closed"));
    this.browser.on("error", () => this.close("browser error"));

    this.openUpstream();
    this.startSuspendWatch();
  }

  // Kick an already-open tab the moment its account is suspended. resolveUpstream
  // only gates NEW connects; a tab that completed the WS upgrade before the
  // suspend would otherwise keep tunnelling chat.send until the fire-and-forget
  // docker-stop lands (seconds on Docker Desktop). One indexed-PK read every
  // SUSPEND_WATCH_MS bounds that race deterministically. Closes with 4403 so the
  // client can show an "akun disuspend" message instead of a generic drop.
  private startSuspendWatch() {
    this.suspendWatch = setInterval(() => {
      void this.checkSuspendedAndKick();
    }, SUSPEND_WATCH_MS);
  }

  private async checkSuspendedAndKick() {
    if (this.closed) return;
    try {
      const [row] = await db
        .select({ suspended: schema.users.suspended })
        .from(schema.users)
        .where(eq(schema.users.id, this.userId))
        .limit(1);
      if (row?.suspended) this.close("account suspended", 4403);
    } catch {
      // Transient DB hiccup — leave the connection up; resolveUpstream + the
      // docker-stop are the other layers. Never kick on a read failure.
    }
  }

  private openUpstream() {
    const url = `ws://${this.info.host}:${this.info.port}/`;
    const up = new WsWebSocket(url, {
      perMessageDeflate: false,
      // Bridge's auth.py doesn't enforce Origin header for now, but we set
      // a sensible one matching loopback convention.
      origin: `http://${this.info.host}:${this.info.port}`,
      // Must match bridge `MAX_WS_MESSAGE_SIZE` (384 MB) so large
      // attachments (200 MB video + b64 inflation) don't get truncated
      // at the upstream WS boundary. Default 100 MB would cap us short.
      maxPayload: 384 * 1024 * 1024,
    });
    this.upstream = up;

    up.on("message", (raw) => this.onUpstreamMessage(raw));
    up.on("open", () => {
      // Once upstream is open, fire the connect handshake immediately.
      this.sendConnectUpstream();
    });
    up.on("close", (code, reason) =>
      this.close(`upstream closed (${code}) ${reason.toString()}`),
    );
    up.on("error", (err) => {
      console.error("[hermes/ws-proxy] upstream error:", err.message);
    });
  }

  private sendConnectUpstream() {
    const id = randomUUID();
    this.upstream!.send(
      JSON.stringify({
        type: "req",
        id,
        method: "connect",
        params: {
          minProtocol: 3,
          maxProtocol: 3,
          client: {
            id: BRIDGE_MAGIC_CLIENT_ID,
            version: "1",
            platform: "node",
            mode: "backend",
            instanceId: `${PORTAL_CLIENT_INSTANCE}-${this.userId.slice(0, 8)}`,
          },
          role: "operator",
          scopes: OPERATOR_SCOPES,
          caps: ["tool-events"],
          auth: { token: this.info.bridgeToken },
          userAgent: "agentbuff-portal/1.0",
          locale: "id-ID",
          userId: this.userId,
        },
      }),
    );
    this.internalConnectId = id;
  }

  private onUpstreamMessage(raw: RawData) {
    const frame = safeJsonParse(raw);
    if (!frame) return;

    // Our internal connect response — consume; don't forward
    if (
      frame.type === "res" &&
      this.internalConnectId &&
      frame.id === this.internalConnectId
    ) {
      if (frame.ok) {
        this.upstreamReady = true;
        // Emit synthetic proxy.ready event to browser
        const upstreamPayload = (frame.payload ?? {}) as {
          snapshot?: { uptimeMs?: number; authMode?: string; runtimeVersion?: string };
          policy?: { tickIntervalMs?: number };
        };
        sendFrame(this.browser, {
          type: "event",
          event: "proxy.ready",
          payload: {
            user: this.userId,
            container: this.info.containerName,
            snapshot: upstreamPayload.snapshot ?? null,
            policy: upstreamPayload.policy ?? null,
          },
        });
        // Flush queued frames
        for (const f of this.queued) {
          if (this.upstream?.readyState === WsWebSocket.OPEN) {
            this.upstream.send(JSON.stringify(f));
          }
        }
        this.queued = [];
      } else {
        const err = frame.error as { code?: string; message?: string } | undefined;
        console.error("[hermes/ws-proxy] upstream connect rejected:", JSON.stringify(err));
        const code = err?.code ?? "unknown";
        const reason = `connect failed: ${code}`.slice(0, 120); // G7
        this.browser.close(4001, reason);
      }
      this.internalConnectId = null;
      return;
    }

    // Bridge handles its own proxy.ready emission too; if it emits one
    // before our synthesized one, just forward (UI is idempotent).
    if (this.browser.readyState === WsWebSocket.OPEN) {
      this.browser.send(JSON.stringify(frame));
    }
  }

  private async onBrowserMessage(raw: RawData) {
    const frame = safeJsonParse(raw);
    if (!frame) return;

    if (frame.type === "req") {
      // Browser must NEVER call connect directly — the proxy owns it
      if (frame.method === "connect") {
        replyError(
          this.browser,
          frame.id,
          "FORBIDDEN",
          "connect is managed by the portal",
        );
        return;
      }
      // F2 funnel "first-chat" activation — fire once per user on their first
      // chat send. In-memory dedup + atomic DB guard keep it once-per-user and
      // off the hot path after the first message. Never blocks forwarding.
      if (frame.method === "chat.send") {
        void markFirstChat(this.userId);
      }
    }

    if (!this.upstreamReady) {
      this.queued.push(frame);
      return;
    }
    if (this.upstream?.readyState === WsWebSocket.OPEN) {
      this.upstream.send(JSON.stringify(frame));
    }
  }

  private close(reason: string, code = 1000) {
    if (this.closed) return;
    this.closed = true;
    if (this.suspendWatch) {
      clearInterval(this.suspendWatch);
      this.suspendWatch = null;
    }
    try {
      this.browser.close(code, reason.slice(0, 120));
    } catch {
      /* ignore */
    }
    try {
      // Upstream (bridge) only accepts standard close codes; 4xxx app codes are
      // for the browser leg. Always close upstream with 1000.
      this.upstream?.close(1000, reason.slice(0, 120));
    } catch {
      /* ignore */
    }
  }
}

/**
 * HTTP Upgrade handler. Wire into `server.ts` for the `/api/ws/hermes` path.
 *
 * During the migration window both `/api/ws/openclaw` and `/api/ws/hermes`
 * coexist — server.ts dispatches based on the upgrade URL.
 */
export async function handleHermesUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  const auth = await resolveUserFromRequest(req);
  if (!auth) {
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  const upstream = await resolveUpstream(auth.userId);
  if (!upstream) {
    socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (browserWs) => {
    new HermesProxyConnection(browserWs, auth.userId, upstream);
  });
}
