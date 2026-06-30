import { randomUUID } from "node:crypto";
import WebSocket from "ws";

type ReqFrame = {
  type: "req";
  id: string;
  method: string;
  params?: unknown;
};

type ResFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code?: string | number; message?: string; data?: unknown };
};

type EventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
};

type IncomingFrame = ResFrame | EventFrame | { type: string; [k: string]: unknown };

export class GatewayRpcError extends Error {
  readonly code: string | number;
  readonly data: unknown;

  constructor(code: string | number, message: string, data?: unknown) {
    super(message);
    this.name = "GatewayRpcError";
    this.code = code;
    this.data = data;
  }
}

export class GatewayTransportError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "GatewayTransportError";
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

export type ConnectPayload = {
  policy?: unknown;
  features?: { methods?: string[]; events?: string[] };
  [k: string]: unknown;
};

export type GatewayClientOptions = {
  url: string;
  token: string;
  clientId?: string;
  instanceId?: string;
  role?: "operator" | "browser" | "device";
  scopes?: string[];
  caps?: string[];
  userAgent?: string;
  locale?: string;
  connectTimeoutMs?: number;
  defaultCallTimeoutMs?: number;
  /**
   * Origin header untuk WS handshake. Gateway control-UI-csp enforce origin
   * match `controlUi.allowedOrigins` HANYA kalau client.id === "openclaw-control-ui"
   * (magic string operator UI). Default: derive dari url's host:port supaya
   * match allowedOrigins yang seeded di docker.ts initVolume.
   */
  origin?: string;
};

type PendingCall = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

const OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending: Map<string, PendingCall> = new Map();
  private connectPayload: ConnectPayload | null = null;
  private closed = false;
  private closeReason: Error | null = null;

  constructor(private readonly opts: GatewayClientOptions) {}

  async connect(): Promise<ConnectPayload> {
    if (this.ws) {
      throw new Error("GatewayClient.connect called twice");
    }
    // Derive default Origin dari URL host:port — match allowedOrigins yang
    // di-seed `provisionContainer()`. Wajib kalau clientId === "openclaw-control-ui".
    const derivedOrigin = (() => {
      if (this.opts.origin) return this.opts.origin;
      try {
        const parsed = new URL(this.opts.url);
        const protocol = parsed.protocol === "wss:" ? "https:" : "http:";
        return `${protocol}//${parsed.host}`;
      } catch {
        return undefined;
      }
    })();
    const ws = new WebSocket(this.opts.url, {
      perMessageDeflate: false,
      origin: derivedOrigin,
    });
    this.ws = ws;

    const challengeTimeoutMs = this.opts.connectTimeoutMs ?? 10_000;

    return new Promise<ConnectPayload>((resolve, reject) => {
      const onError = (err: Error) => {
        this.markClosed(new GatewayTransportError(err.message, err));
        reject(new GatewayTransportError(err.message, err));
      };

      const fail = (reason: Error) => {
        this.markClosed(reason);
        try {
          ws.terminate();
        } catch {
          // ignore
        }
        reject(reason);
      };

      const connectTimer = setTimeout(() => {
        fail(new GatewayTransportError("Gateway did not respond to connect in time"));
      }, challengeTimeoutMs);

      let connectSent = false;
      const sendConnect = () => {
        if (connectSent) return;
        connectSent = true;
        const id = randomUUID();
        const pendingConnect: PendingCall = {
          method: "connect",
          resolve: (value) => {
            clearTimeout(connectTimer);
            this.connectPayload = (value as ConnectPayload) ?? {};
            resolve(this.connectPayload);
          },
          reject,
          timer: setTimeout(() => {
            this.pending.delete(id);
            fail(new GatewayTransportError("connect RPC timed out"));
          }, challengeTimeoutMs),
        };
        this.pending.set(id, pendingConnect);
        this.send({
          type: "req",
          id,
          method: "connect",
          params: this.buildConnectParams(),
        });
      };

      ws.once("error", (err) => {
        clearTimeout(connectTimer);
        onError(err as Error);
      });

      ws.on("close", (code, reasonBuf) => {
        clearTimeout(connectTimer);
        const reason = reasonBuf?.toString() || `ws closed (code ${code})`;
        const err = new GatewayTransportError(reason);
        this.markClosed(err);
      });

      // Hermes bridge protocol: accept connect REQ immediately on open
      // (no challenge-response dance). Send right away — bridge.auth.py
      // validates the connect frame as the first message.
      ws.once("open", () => {
        sendConnect();
      });

      ws.on("message", (raw: WebSocket.RawData) => {
        let frame: IncomingFrame | null = null;
        try {
          frame = JSON.parse(raw.toString()) as IncomingFrame;
        } catch {
          return;
        }
        if (!frame) return;
        if (frame.type === "event" && (frame as EventFrame).event === "connect.challenge") {
          // Legacy OpenClaw path: server requested challenge-response.
          // If we already sent connect on open, ignore — bridge will reply
          // to the connect REQ directly. Otherwise send now.
          sendConnect();
          return;
        }
        if (frame.type === "res") {
          this.handleRes(frame as ResFrame);
          return;
        }
        // Events after handshake (e.g. bridge proxy.ready) are observable
        // but not used by backend clients here.
      });
    });
  }

  private buildConnectParams() {
    const instanceId = this.opts.instanceId ?? randomUUID();
    return {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: this.opts.clientId ?? "agentbuff-portal",
        version: "1",
        platform: "node",
        mode: "backend",
        instanceId,
      },
      role: this.opts.role ?? "operator",
      scopes: this.opts.scopes ?? OPERATOR_SCOPES,
      caps: this.opts.caps ?? ["tool-events"],
      auth: { token: this.opts.token },
      userAgent: this.opts.userAgent ?? "agentbuff-portal/1.0",
      locale: this.opts.locale ?? "id-ID",
    };
  }

  private handleRes(frame: ResFrame) {
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    if (frame.ok) {
      pending.resolve(frame.payload);
    } else {
      const err = frame.error ?? {};
      pending.reject(
        new GatewayRpcError(
          err.code ?? "UNKNOWN",
          err.message ?? `RPC ${pending.method} failed`,
          err.data,
        ),
      );
    }
  }

  private send(frame: ReqFrame) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new GatewayTransportError("WebSocket is not open");
    }
    this.ws.send(JSON.stringify(frame));
  }

  async call<T = unknown>(
    method: string,
    params?: unknown,
    options: { timeoutMs?: number } = {},
  ): Promise<T> {
    if (this.closed) {
      throw this.closeReason ?? new GatewayTransportError("Gateway connection closed");
    }
    if (!this.connectPayload) {
      throw new Error("GatewayClient.call called before connect()");
    }
    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.opts.defaultCallTimeoutMs ?? 30_000;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new GatewayTransportError(`RPC ${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.send({ type: "req", id, method, params });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  getConnectPayload(): ConnectPayload | null {
    return this.connectPayload;
  }

  hasMethod(name: string): boolean {
    const methods = this.connectPayload?.features?.methods ?? [];
    return methods.includes(name);
  }

  private markClosed(reason: Error) {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = reason;
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(reason);
    }
    this.pending.clear();
  }

  async close(): Promise<void> {
    this.markClosed(new GatewayTransportError("Client closed connection"));
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) {
        resolve();
        return;
      }
      ws.once("close", () => resolve());
      try {
        ws.close(1000, "agentbuff-done");
      } catch {
        resolve();
      }
      setTimeout(() => resolve(), 500);
    });
  }
}

export async function withGateway<T>(
  opts: GatewayClientOptions,
  fn: (client: GatewayClient) => Promise<T>,
): Promise<T> {
  const client = new GatewayClient(opts);
  try {
    await client.connect();
    return await fn(client);
  } finally {
    await client.close();
  }
}

export type SkillInstallParams =
  | { source: "clawhub"; slug: string; version?: string; force?: boolean }
  | { source: "direct"; name: string; installId: string; version?: string; force?: boolean };

export type SkillInstallResult = {
  slug?: string;
  name?: string;
  version?: string;
  enabled?: boolean;
  [k: string]: unknown;
};

export async function installSkill(
  client: GatewayClient,
  params: SkillInstallParams,
  options: { timeoutMs?: number } = {},
): Promise<SkillInstallResult> {
  return client.call<SkillInstallResult>("skills.install", params, {
    timeoutMs: options.timeoutMs ?? 120_000,
  });
}

// Admin force-uninstall (D4). The bridge forwards to engine skills.manage with
// action="remove". The engine matches the skill by slug/name, so we send both
// (set to the same canonical skillKey) to be tolerant of either lookup path.
export async function uninstallSkill(
  client: GatewayClient,
  skillKey: string,
  options: { timeoutMs?: number } = {},
): Promise<SkillInstallResult> {
  return client.call<SkillInstallResult>(
    "skills.uninstall",
    { slug: skillKey, name: skillKey },
    { timeoutMs: options.timeoutMs ?? 120_000 },
  );
}

export type SessionsUsageDailyEntry = {
  date: string; // YYYY-MM-DD
  tokens?: { input?: number; output?: number; total?: number };
  messages?: { total?: number; user?: number; assistant?: number };
  cost?: { usd?: number };
};

export type SessionsUsageRecentSession = {
  key: string;
  agentId?: string | null;
  displayName?: string | null;
  label?: string | null;
  model?: string | null;
  updatedAt?: number | null;
  tokens?: { input?: number; output?: number; total?: number };
};

export type SessionsUsageResult = {
  updatedAt?: number;
  startDate?: string;
  endDate?: string;
  totals?: {
    tokens?: {
      input?: number;
      output?: number;
      total?: number;
    };
    cost?: { usd?: number };
    messages?: { total?: number; user?: number; assistant?: number };
    [k: string]: unknown;
  };
  sessions?: SessionsUsageRecentSession[];
  aggregates?: {
    daily?: SessionsUsageDailyEntry[];
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

export type SessionsUsageParams = {
  /** YYYY-MM-DD inclusive lower bound. Omit untuk default (yesterday). */
  startDate?: string;
  /** YYYY-MM-DD inclusive upper bound. Omit untuk default (today). */
  endDate?: string;
  /** Limit recent sessions array. Default 50. */
  limit?: number;
};

export async function getSessionsUsage(
  client: GatewayClient,
  params: SessionsUsageParams = {},
  options: { timeoutMs?: number } = {},
): Promise<SessionsUsageResult> {
  return client.call<SessionsUsageResult>("sessions.usage", params, {
    timeoutMs: options.timeoutMs ?? 15_000,
  });
}

export type HealthSnapshot = {
  ok?: boolean;
  ts?: number;
  durationMs?: number;
  channels?: Record<string, unknown>;
  channelOrder?: string[];
  channelLabels?: Record<string, string>;
  heartbeatSeconds?: number;
  defaultAgentId?: string;
  agents?: Array<{
    agentId: string;
    name?: string;
    isDefault: boolean;
    heartbeat?: { enabled: boolean; every?: string; everyMs?: number | null };
    sessions?: { count: number; recent?: unknown[] };
  }>;
  sessions?: { path?: string; count?: number; recent?: unknown[] };
  [k: string]: unknown;
};

export async function getHealth(
  client: GatewayClient,
  options: { timeoutMs?: number } = {},
): Promise<HealthSnapshot> {
  return client.call<HealthSnapshot>("health", { probe: true }, {
    timeoutMs: options.timeoutMs ?? 8_000,
  });
}

// ---------------------------------------------------------------------
// Hermes bridge convenience wrappers
// ---------------------------------------------------------------------
//
// Sugar over `withGateway` with Hermes-specific defaults — connect URL
// derived from the user's container port + magic client.id "agentbuff-
// portal" that the bridge's auth.py enforces, plus sensible call-timeout
// caps so background workers (usage-poller, skill-installer) don't hang.

import { hermesConfig } from "./config";

export interface HermesBridgeConnectConfig {
  /** Host the bridge is reachable on (defaults to hermesConfig.bindHost = 127.0.0.1). */
  host?: string;
  /** Loopback port published for this user's container. */
  port: number;
  /** Bridge auth token from user_container.gatewayToken. */
  bridgeToken: string;
  /** Logical client identifier for logs / observability. Defaults to a sensible portal tag. */
  callerTag?: string;
  /** Connect deadline (default 8s). */
  connectTimeoutMs?: number;
  /** Per-call default timeout (default 12s). */
  defaultCallTimeoutMs?: number;
}

/**
 * Open a short-lived authenticated WS connection to a user's Hermes bridge,
 * run `callback(client)`, then close cleanly.
 *
 * Use this for one-off RPC calls from server-side workers (usage polling,
 * skill installation, dashboard reads). For long-lived per-user connections,
 * use the browser-side GatewayClient via the /api/ws/hermes upgrade handler.
 */
export async function withHermesBridge<T>(
  cfg: HermesBridgeConnectConfig,
  callback: (client: GatewayClient) => Promise<T>,
): Promise<T> {
  const host = cfg.host ?? hermesConfig.bindHost;
  const tag = cfg.callerTag ?? "agentbuff-portal-worker";

  return withGateway(
    {
      url: `ws://${host}:${cfg.port}/`,
      token: cfg.bridgeToken,
      // Magic string the bridge auth.py enforces. Mismatch = INVALID_REQUEST.
      clientId: "agentbuff-portal",
      role: "operator",
      userAgent: `${tag}/1.0`,
      connectTimeoutMs: cfg.connectTimeoutMs ?? 8_000,
      defaultCallTimeoutMs: cfg.defaultCallTimeoutMs ?? 12_000,
    },
    callback,
  );
}

/**
 * Sugar: fetch sessions usage aggregate (for billing meter).
 *
 * Bridge handler aggregates across all sessions; returns
 * `{ totals: { tokens: { total: number } } }`.
 */
export async function getHermesSessionsUsage(
  client: GatewayClient,
): Promise<{ totals: { tokens: { total: number } } } | null> {
  const result = await getSessionsUsage(client);
  if (!result) return null;
  if (
    typeof result === "object" &&
    result !== null &&
    "totals" in result &&
    typeof (result as { totals: unknown }).totals === "object"
  ) {
    return result as { totals: { tokens: { total: number } } };
  }
  return { totals: { tokens: { total: 0 } } };
}
