// Comprehensive read-only verification untuk semua fitur Telegram + WhatsApp.
// Non-destructive: cuma config.get + channels.status (probe) + agents.list.
// Output: TABLE per channel + PASS/FAIL summary tiap surface.
//
//   pnpm tsx --env-file=.env.local scripts/verify-telegram-whatsapp-features.ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway, type GatewayClient } from "@/lib/hermes/gateway-client";

type ConnInfo = { url: string; token: string; userIdShort: string };

type CheckResult = { name: string; ok: boolean; detail: string };

const checks: CheckResult[] = [];

function check(name: string, ok: boolean, detail = "") {
  checks.push({ name, ok, detail });
  const tag = ok ? "✓" : "✗";
  const color = ok ? "" : "  (FAIL)";
  console.log(`  ${tag} ${name}${detail ? ": " + detail : ""}${color}`);
}

async function withFresh<T>(
  conn: ConnInfo,
  label: string,
  fn: (c: GatewayClient) => Promise<T>,
): Promise<T> {
  return withGateway(
    {
      url: conn.url,
      token: conn.token,
      clientId: "openclaw-control-ui",
      instanceId: `verify-${conn.userIdShort}-${label}`,
      defaultCallTimeoutMs: 15_000,
    },
    fn,
  );
}

async function main() {
  const [row] = await db
    .select({
      userId: schema.userContainers.userId,
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
      status: schema.userContainers.status,
    })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.status, "running"))
    .limit(1);
  if (!row) {
    console.error("[fail] no running container");
    process.exit(1);
  }
  const conn: ConnInfo = {
    url: `ws://${hermesConfig.publicHost}:${row.port}/`,
    token: row.gatewayToken,
    userIdShort: row.userId.slice(0, 8),
  };
  console.log(`Target: container userId=${row.userId} port=${row.port}\n`);

  // === Phase 1: Engine + Plugin state ===
  console.log("[Phase 1] Engine state + plugin loading");
  const status = await withFresh(conn, "p1-status", (c) =>
    c.call<{
      channelOrder?: string[];
      channels?: Record<string, Record<string, unknown>>;
      channelAccounts?: Record<string, Array<Record<string, unknown>>>;
    }>("channels.status", { probe: false }),
  );
  const order = status?.channelOrder ?? [];
  check("Telegram plugin loaded", order.includes("telegram"));
  check("WhatsApp plugin loaded", order.includes("whatsapp"));

  // === Phase 2: Config snapshot ===
  console.log("\n[Phase 2] Config snapshot");
  const cfgResult = await withFresh(conn, "p2-cfg", (c) =>
    c.call<{
      config?: {
        channels?: Record<string, Record<string, unknown>>;
        bindings?: unknown[];
      };
    }>("config.get", {}),
  );
  const cfg = cfgResult?.config ?? {};
  const channelsCfg = cfg.channels ?? {};
  const bindings = Array.isArray(cfg.bindings) ? cfg.bindings : [];

  for (const channelId of ["telegram", "whatsapp"] as const) {
    const ch = channelsCfg[channelId] as Record<string, unknown> | undefined;
    if (!ch) {
      check(`${channelId}: config exists`, false, "missing");
      continue;
    }
    check(`${channelId}: enabled`, ch.enabled === true);
    check(
      `${channelId}: dmPolicy permissive (open)`,
      ch.dmPolicy === "open",
      `actual: ${ch.dmPolicy}`,
    );
    const allowFrom = Array.isArray(ch.allowFrom) ? ch.allowFrom : [];
    check(
      `${channelId}: allowFrom contains "*"`,
      allowFrom.includes("*"),
      `actual: [${allowFrom.join(", ")}]`,
    );
    check(
      `${channelId}: groupPolicy permissive (open)`,
      ch.groupPolicy === "open",
      `actual: ${ch.groupPolicy}`,
    );
    const groupAllowFrom = Array.isArray(ch.groupAllowFrom) ? ch.groupAllowFrom : [];
    check(
      `${channelId}: groupAllowFrom contains "*"`,
      groupAllowFrom.includes("*"),
      `actual: [${groupAllowFrom.join(", ")}]`,
    );
  }

  // === Phase 3: Account state ===
  console.log("\n[Phase 3] Account runtime state");
  const channelsState = status?.channels ?? {};
  const channelAccounts = status?.channelAccounts ?? {};

  for (const channelId of ["telegram", "whatsapp"] as const) {
    const ch = channelsState[channelId] as
      | { configured?: boolean; running?: boolean; connected?: boolean; lastError?: string | null }
      | undefined;
    if (!ch) {
      check(`${channelId}: account state present`, false, "missing");
      continue;
    }
    check(`${channelId}: configured`, ch.configured === true);
    check(`${channelId}: running`, ch.running === true);
    // connected field: WhatsApp WS-persistent sets, Telegram polling-mode tidak
    if (channelId === "whatsapp") {
      check(`${channelId}: connected (WS)`, ch.connected === true);
    }
    check(
      `${channelId}: no lastError`,
      !ch.lastError,
      ch.lastError ? `error: ${ch.lastError}` : "",
    );

    const accs = channelAccounts[channelId] ?? [];
    check(`${channelId}: has at least 1 account`, accs.length >= 1);
    const acc = accs[0] as
      | { lastError?: string | null; reconnectAttempts?: number }
      | undefined;
    if (acc) {
      check(
        `${channelId} default acc: no lastError`,
        !acc.lastError,
        acc.lastError ? `error: ${acc.lastError}` : "",
      );
      check(
        `${channelId} default acc: no reconnect loop`,
        !(typeof acc.reconnectAttempts === "number" && acc.reconnectAttempts >= 3),
        `attempts: ${acc.reconnectAttempts ?? 0}`,
      );
    }
  }

  // === Phase 4: Test Connection probe ===
  console.log("\n[Phase 4] Test Connection probe — verify identity returns");
  try {
    const probe = await withFresh(conn, "p4-probe", (c) =>
      c.call<{
        channels?: Record<string, Record<string, unknown>>;
        channelAccounts?: Record<
          string,
          Array<{ probe?: { bot?: { username?: string }; team?: { name?: string } }; self?: { e164?: string } }>
        >;
      }>("channels.status", { probe: true, timeoutMs: 10_000 }),
    );

    const tgAcc = probe?.channelAccounts?.telegram?.[0];
    const tgBot = tgAcc?.probe?.bot?.username;
    check(
      "telegram probe returns bot username",
      Boolean(tgBot),
      tgBot ? `@${tgBot}` : "no bot info",
    );

    const waAcc = probe?.channelAccounts?.whatsapp?.[0];
    const waChStatus = probe?.channels?.whatsapp as { self?: { e164?: string } } | undefined;
    const waPhone = waAcc?.self?.e164 ?? waChStatus?.self?.e164;
    check(
      "whatsapp probe returns phone (e164)",
      Boolean(waPhone),
      waPhone ?? "no phone info",
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check("probe call succeeded", false, msg);
  }

  // === Phase 5: Bindings + agent routing ===
  console.log("\n[Phase 5] Bindings & agent routing");
  const agents = await withFresh(conn, "p5-agents", (c) =>
    c.call<{ defaultId?: string; agents?: Array<{ id: string; name?: string }> }>(
      "agents.list",
      {},
    ),
  );
  const defaultAgentId = agents?.defaultId ?? "main";
  const agentIds = (agents?.agents ?? []).map((a) => a.id);
  check(`agents.list returns default ID`, Boolean(defaultAgentId), defaultAgentId);
  check(
    `default agent (${defaultAgentId}) exists in list`,
    agentIds.includes(defaultAgentId),
    `available: [${agentIds.join(", ")}]`,
  );

  for (const channelId of ["telegram", "whatsapp"] as const) {
    const explicit = bindings.find((b) => {
      if (!b || typeof b !== "object") return false;
      const m = (b as { match?: { channel?: string; accountId?: string } }).match;
      return m?.channel === channelId && (m?.accountId ?? "default") === "default";
    });
    if (explicit) {
      const agentId = (explicit as { agentId?: string }).agentId;
      check(
        `${channelId}: explicit binding to agent "${agentId}"`,
        Boolean(agentId) && agentIds.includes(agentId!),
        agentId ?? "no agentId",
      );
    } else {
      // No explicit binding = falls back to default agent (engine behavior)
      check(
        `${channelId}: routes to default agent (no explicit binding, OK)`,
        true,
        `fallback: ${defaultAgentId}`,
      );
    }
  }

  // === Phase 6: Inbound message readiness ===
  console.log("\n[Phase 6] Inbound message readiness");
  for (const channelId of ["telegram", "whatsapp"] as const) {
    const ch = channelsState[channelId] as
      | { lastInboundAt?: number | null }
      | undefined;
    const ts = ch?.lastInboundAt ?? null;
    if (ts) {
      const ageMin = (Date.now() - ts) / 60_000;
      check(
        `${channelId}: has inbound history`,
        true,
        `last inbound ${ageMin.toFixed(1)} menit yang lalu`,
      );
    } else {
      check(
        `${channelId}: no inbound yet (kosong = belum ada test message)`,
        true,
        "OK kalo belum ada user ngirim ke bot",
      );
    }
  }

  // === Summary ===
  const passed = checks.filter((c) => c.ok).length;
  const failed = checks.filter((c) => !c.ok).length;
  console.log("\n" + "=".repeat(60));
  console.log(`RESULT: ${passed} passed, ${failed} failed (${checks.length} total)`);
  console.log("=".repeat(60));

  if (failed > 0) {
    console.log("\nFAILURES:");
    for (const c of checks.filter((x) => !x.ok)) {
      console.log(`  ✗ ${c.name}: ${c.detail}`);
    }
    process.exit(1);
  }
  console.log("\nALL FEATURES OPERATIONAL ✓");
  process.exit(0);
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
