import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { getAdminMutator } from "@/lib/admin/rbac";
import {
  withHermesBridge,
  GatewayRpcError,
  GatewayTransportError,
} from "@/lib/hermes/gateway-client";
import { auditLog, clientIpFromRequest } from "@/lib/security/audit-log";
import { take, keyFromRequest } from "@/lib/security/rate-limit";

// D12/D13 — RPC tester. Proxies one JSON-RPC call to a user's running Hermes
// bridge and returns the raw response. Admin ONLY (it can call mutating methods
// like config.patch / skills.install), rate-limited, and every call is audited.
// Loopback-only: the bridge is published on 127.0.0.1:<port>, never reachable
// off-box. Read methods are the common use; the catalog in the UI is suggestion
// only — any method the gateway exposes is allowed (this is a dev/ops tool).
export const dynamic = "force-dynamic";

const RPC_LIMIT = 60;
const RPC_WINDOW_MS = 60_000;
const METHOD_RE = /^[\w.]{1,64}$/;
// Hard cap so a hung/streaming method can't tie up the request indefinitely.
const CALL_TIMEOUT_MS = 20_000;

export async function POST(req: Request) {
  const actor = await getAdminMutator();
  if (!actor) return Response.json({ error: "FORBIDDEN" }, { status: 403 });
  const ip = clientIpFromRequest(req);

  const rl = take(keyFromRequest("admin.rpc-test", req, actor.id), RPC_LIMIT, RPC_WINDOW_MS);
  if (!rl.ok) return Response.json({ error: "RATE_LIMITED" }, { status: 429 });

  try {
    const body = (await req.json().catch(() => ({}))) as {
      userId?: unknown;
      method?: unknown;
      params?: unknown;
    };
    const userId = typeof body.userId === "string" ? body.userId : "";
    const method = typeof body.method === "string" ? body.method.trim() : "";
    if (!userId) return Response.json({ error: "MISSING_USER" }, { status: 400 });
    if (!METHOD_RE.test(method))
      return Response.json({ error: "INVALID_METHOD" }, { status: 400 });
    // params: pass through whatever JSON the admin supplied (object/array/scalar)
    // or undefined. Reject the `connect` method — the bridge handshakes it itself.
    if (method === "connect")
      return Response.json({ error: "METHOD_NOT_ALLOWED" }, { status: 400 });

    const [container] = await db
      .select({
        port: schema.userContainers.port,
        token: schema.userContainers.gatewayToken,
        status: schema.userContainers.status,
      })
      .from(schema.userContainers)
      .where(eq(schema.userContainers.userId, userId))
      .limit(1);
    if (!container || container.port == null || !container.token)
      return Response.json({ error: "NO_CONTAINER" }, { status: 404 });
    if (container.status !== "running")
      return Response.json({ error: "CONTAINER_NOT_RUNNING", status: container.status }, { status: 409 });

    const startedAt = Date.now();
    try {
      const payload = await withHermesBridge(
        {
          port: container.port,
          bridgeToken: container.token,
          callerTag: "agentbuff-admin-rpc",
          defaultCallTimeoutMs: CALL_TIMEOUT_MS,
        },
        (client) => client.call(method, body.params, { timeoutMs: CALL_TIMEOUT_MS }),
      );
      auditLog({
        event: "admin.rpc.test",
        outcome: "ok",
        actor: actor.id,
        target: userId,
        ip,
        details: { method, ms: Date.now() - startedAt },
      });
      return Response.json({ ok: true, payload, ms: Date.now() - startedAt });
    } catch (e) {
      const ms = Date.now() - startedAt;
      auditLog({
        event: "admin.rpc.test",
        outcome: "error",
        actor: actor.id,
        target: userId,
        ip,
        details: { method, ms },
      });
      if (e instanceof GatewayRpcError) {
        // The gateway answered with an error frame — surface it (not a 500).
        return Response.json({
          ok: false,
          error: { code: e.code, message: e.message, data: e.data },
          ms,
        });
      }
      if (e instanceof GatewayTransportError) {
        return Response.json(
          { ok: false, error: { code: "TRANSPORT", message: e.message }, ms },
          { status: 502 },
        );
      }
      return Response.json(
        { ok: false, error: { code: "UNKNOWN", message: "RPC failed" }, ms },
        { status: 502 },
      );
    }
  } catch {
    return Response.json({ error: "INTERNAL_ERROR" }, { status: 500 });
  }
}
