/**
 * E2E test: verify engine accepts shapes yang akan dikirim UI baru:
 *  1. First-pair patch  → channels.<id>.<fields>           (top-level)
 *  2. Add-account patch → channels.<id>.accounts.<id>.<fields>
 *  3. Bindings array with multiple route entries (different accountId per binding)
 *
 * Dry-run only: pakai DUMMY bot token "0:dummy" yang akan fail di startup tapi
 * tetep BISA disimpan ke config (engine validate schema, gak validate API key
 * live). Tujuan: confirm shape merge-patch correct + accounts namespace separation.
 *
 * SETELAH selesai: bersihkan channels.telegram dengan composite null patch.
 *
 *   pnpm tsx --env-file=.env.local scripts/test-multi-account-shape.ts
 */

import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway, type GatewayClient } from "@/lib/hermes/gateway-client";

const CHANNEL = "telegram";

type ConnInfo = { url: string; token: string; userIdShort: string };

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
      instanceId: `e2e-${conn.userIdShort}-${label}`,
      defaultCallTimeoutMs: 20_000,
    },
    fn,
  );
}

async function patchConfig(
  client: GatewayClient,
  partial: Record<string, unknown>,
): Promise<void> {
  const snapshot = await client.call<{ hash?: string }>("config.get", {});
  const baseHash =
    typeof snapshot?.hash === "string" ? snapshot.hash.trim() : "";
  if (!baseHash) throw new Error("no baseHash");
  await client.call("config.patch", {
    raw: JSON.stringify(partial),
    baseHash,
  });
}

async function readConfig(
  conn: ConnInfo,
): Promise<Record<string, unknown> | null> {
  return withFresh(conn, "read-cfg", async (c) => {
    const snap = await c.call<{ config?: Record<string, unknown> }>(
      "config.get",
      {},
    );
    return snap?.config ?? null;
  });
}

async function tryPatch(
  conn: ConnInfo,
  label: string,
  partial: Record<string, unknown>,
): Promise<{ ok: boolean; error?: string }> {
  // Auto-retry on engine rate-limit: gateway returns "rate limit exceeded for
  // config.patch; retry after Ns" — we parse N and sleep + retry once.
  const attempt = async (): Promise<{ ok: boolean; error?: string }> => {
    try {
      await withFresh(conn, label, (c) => patchConfig(c, partial));
      return { ok: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/socket hang up|gateway closed|gateway timeout|ECONNRESET/i.test(msg)) {
        return { ok: true, error: msg };
      }
      const rateMatch = msg.match(/retry after (\d+)s/i);
      if (rateMatch) {
        const waitS = Math.min(parseInt(rateMatch[1], 10) + 2, 60);
        console.log(`[rate-limit] sleeping ${waitS}s then retrying...`);
        await new Promise((r) => setTimeout(r, waitS * 1000));
        try {
          await withFresh(conn, `${label}-retry`, (c) => patchConfig(c, partial));
          return { ok: true };
        } catch (err2) {
          const msg2 = err2 instanceof Error ? err2.message : String(err2);
          if (/socket hang up|gateway closed|gateway timeout|ECONNRESET/i.test(msg2)) {
            return { ok: true, error: msg2 };
          }
          return { ok: false, error: msg2 };
        }
      }
      return { ok: false, error: msg };
    }
  };
  return attempt();
}

async function waitHealth(port: number, ms = 90_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const ok = await fetch(`http://127.0.0.1:${port}/healthz`, {
        signal: AbortSignal.timeout(2_000),
      })
        .then((r) => r.ok)
        .catch(() => false);
      if (ok) return;
    } catch {
      /* keep polling */
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`gateway not healthy after ${ms}ms`);
}

async function main() {
  const rows = await db
    .select({
      userId: schema.userContainers.userId,
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
      status: schema.userContainers.status,
    })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.status, "running"));

  if (rows.length === 0) {
    console.error("[fail] no running container — start container first");
    process.exit(1);
  }
  const row = rows[0];
  const conn: ConnInfo = {
    url: `ws://${hermesConfig.publicHost}:${row.port}/`,
    token: row.gatewayToken,
    userIdShort: row.userId.slice(0, 8),
  };
  console.log(`[info] target container userId=${row.userId} port=${row.port}`);

  // ── Phase 0: clean pre-state (wipe any existing telegram config) ─────
  console.log(`\n[Phase 0] Pre-clean — wipe any existing channels.${CHANNEL}`);
  const pre = await readConfig(conn);
  const preChan = (pre?.channels as Record<string, unknown> | undefined)?.[
    CHANNEL
  ];
  if (preChan !== undefined) {
    console.log(
      `[Phase 0] existing config detected, wiping. dump:`,
      JSON.stringify(preChan).slice(0, 200),
    );
    const wipe = await tryPatch(conn, "pre-wipe", {
      channels: { [CHANNEL]: null },
      bindings: [],
    });
    if (!wipe.ok) {
      console.error(`[FAIL] Phase 0: pre-wipe failed:`, wipe.error);
      process.exit(1);
    }
    await waitHealth(row.port);
    console.log(`[ok] Phase 0 pre-clean complete`);
  } else {
    console.log(`[ok] Phase 0 — no existing config, clean start`);
  }

  // Note: engine returns redacted tokens in config.get (botToken etc replaced
  // with "__OPENCLAW_REDACTED__"). We verify presence + structural correctness,
  // not literal value match.
  const REDACTED = "__OPENCLAW_REDACTED__";

  // ── Phase 1: first pair (top-level)  ─────────────────────────
  console.log(`\n[Phase 1] First pair — patch channels.${CHANNEL}.<fields> top-level`);
  const firstPair = await tryPatch(conn, "first-pair", {
    channels: {
      [CHANNEL]: {
        botToken: "0:dummy_phase1",
        enabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
        groupAllowFrom: ["*"],
      },
    },
    bindings: [
      {
        type: "route",
        agentId: "main",
        match: { channel: CHANNEL, accountId: "default" },
      },
    ],
  });
  if (!firstPair.ok) {
    console.error(`[FAIL] Phase 1 patch failed:`, firstPair.error);
    process.exit(1);
  }
  console.log(`[ok] Phase 1 patch accepted`);
  await waitHealth(row.port);
  let cfg = await readConfig(conn);
  const tg1 = (cfg?.channels as Record<string, unknown>)?.[CHANNEL] as
    | Record<string, unknown>
    | undefined;
  console.log(`[Phase 1 verify] top-level botToken present:`, !!tg1?.botToken);
  console.log(`[Phase 1 verify] enabled flag:`, tg1?.enabled);
  console.log(`[Phase 1 verify] dmPolicy:`, tg1?.dmPolicy);
  if (!tg1?.botToken || tg1.botToken !== REDACTED) {
    console.error(
      `[FAIL] Phase 1: top-level botToken missing or unexpected:`,
      tg1?.botToken,
    );
    process.exit(1);
  }
  if (tg1?.enabled !== true) {
    console.error(`[FAIL] Phase 1: enabled flag not set`);
    process.exit(1);
  }
  console.log(`[ok] Phase 1 verified — top-level wired correctly`);

  // ── Phase 2: add account (accounts.<id>.<fields>)  ──────────
  console.log(
    `\n[Phase 2] Add account — patch channels.${CHANNEL}.accounts.account-2.<fields>`,
  );
  const addAcct = await tryPatch(conn, "add-acct", {
    channels: {
      [CHANNEL]: {
        accounts: {
          "account-2": {
            botToken: "0:dummy_phase2_acct2",
            enabled: true,
            dmPolicy: "open",
            allowFrom: ["*"],
            groupPolicy: "open",
            groupAllowFrom: ["*"],
          },
        },
      },
    },
    bindings: [
      // Keep default route
      {
        type: "route",
        agentId: "main",
        match: { channel: CHANNEL, accountId: "default" },
      },
      // Add new route for account-2
      {
        type: "route",
        agentId: "main",
        match: { channel: CHANNEL, accountId: "account-2" },
      },
    ],
  });
  if (!addAcct.ok) {
    console.error(`[FAIL] Phase 2 patch failed:`, addAcct.error);
    process.exit(1);
  }
  console.log(`[ok] Phase 2 patch accepted`);
  await waitHealth(row.port);
  cfg = await readConfig(conn);
  const tg2 = (cfg?.channels as Record<string, unknown>)?.[CHANNEL] as
    | Record<string, unknown>
    | undefined;
  const acctNs = tg2?.accounts as Record<string, unknown> | undefined;
  const acct2 = acctNs?.["account-2"] as Record<string, unknown> | undefined;
  console.log(
    `[Phase 2 verify] FULL channels.telegram dump:`,
    JSON.stringify(tg2, null, 2),
  );
  // IMPORTANT — engine auto-migrates per-account fields. When `accounts`
  // namespace is introduced for the first time, fields like `botToken` that
  // are per-account get MOVED from top-level into `accounts.default.*` by
  // the engine. Channel-level base config (allowFrom, groupAllowFrom,
  // enabled, etc.) stays at top-level. This is correct, safe behavior:
  //   - Single-account user keeps simple top-level config (no breaking change)
  //   - Add second account → engine auto-migrates first to accounts.default
  //   - Our bindings use accountId="default" for first pair, matches engine
  const acctDefault = acctNs?.["default"] as Record<string, unknown> | undefined;
  console.log(`[Phase 2 verify] accounts.default exists:`, !!acctDefault);
  console.log(`[Phase 2 verify] accounts.default.botToken:`, acctDefault?.botToken);
  console.log(`[Phase 2 verify] accounts.account-2.botToken:`, acct2?.botToken);
  if (!acctDefault || acctDefault.botToken !== REDACTED) {
    console.error(
      `[FAIL] Phase 2: accounts.default.botToken missing — engine auto-migration did not work`,
    );
    process.exit(1);
  }
  if (!acct2 || acct2.botToken !== REDACTED) {
    console.error(`[FAIL] Phase 2: account-2 namespace missing or wrong`);
    process.exit(1);
  }
  if (acct2.enabled !== true) {
    console.error(`[FAIL] Phase 2: account-2 enabled flag not set`);
    process.exit(1);
  }
  console.log(
    `[ok] Phase 2 verified — multi-account works; engine auto-migrated default account`,
  );

  // ── Phase 3: verify bindings array preserved per-account ────
  const bindings = cfg?.bindings as unknown[] | undefined;
  console.log(`[Phase 3] bindings count:`, bindings?.length);
  console.log(`[Phase 3] bindings dump:`, JSON.stringify(bindings, null, 2));
  if (!Array.isArray(bindings) || bindings.length < 2) {
    console.error(`[FAIL] Phase 3: bindings array should have >= 2 entries`);
    process.exit(1);
  }
  const route2 = bindings.find((b) => {
    if (!b || typeof b !== "object") return false;
    const m = (b as { match?: { accountId?: string } }).match;
    return m?.accountId === "account-2";
  });
  if (!route2) {
    console.error(`[FAIL] Phase 3: account-2 binding missing`);
    process.exit(1);
  }
  console.log(`[ok] Phase 3 verified — account-2 binding present`);

  // ── Phase 4: edit binding agent for account-2 only ──────────
  console.log(
    `\n[Phase 4] Edit binding — re-route account-2 ke "sales-bot" agent (bindings only, no channel config change)`,
  );
  const editBind = await tryPatch(conn, "edit-bind", {
    bindings: [
      {
        type: "route",
        agentId: "main",
        match: { channel: CHANNEL, accountId: "default" },
      },
      {
        type: "route",
        agentId: "sales-bot",
        match: { channel: CHANNEL, accountId: "account-2" },
      },
    ],
  });
  if (!editBind.ok) {
    console.error(`[FAIL] Phase 4 patch failed:`, editBind.error);
    process.exit(1);
  }
  console.log(`[ok] Phase 4 patch accepted`);
  await waitHealth(row.port);
  cfg = await readConfig(conn);
  const bindings4 = cfg?.bindings as unknown[] | undefined;
  const route2New = bindings4?.find((b) => {
    if (!b || typeof b !== "object") return false;
    const m = (b as { match?: { accountId?: string } }).match;
    return m?.accountId === "account-2";
  }) as { agentId?: string } | undefined;
  console.log(
    `[Phase 4 verify] account-2 routed agent:`,
    route2New?.agentId,
  );
  if (route2New?.agentId !== "sales-bot") {
    console.error(`[FAIL] Phase 4: account-2 not re-routed`);
    process.exit(1);
  }
  // Verify both account namespaces preserved (no token loss):
  const tg4 = (cfg?.channels as Record<string, unknown>)?.[CHANNEL] as
    | Record<string, unknown>
    | undefined;
  const acctNs4 = tg4?.accounts as Record<string, unknown> | undefined;
  const acctDefault4 = acctNs4?.["default"] as Record<string, unknown> | undefined;
  const acct2_4 = acctNs4?.["account-2"] as Record<string, unknown> | undefined;
  if (!acctDefault4 || acctDefault4.botToken !== REDACTED) {
    console.error(`[FAIL] Phase 4: accounts.default.botToken lost on edit-binding`);
    process.exit(1);
  }
  if (!acct2_4 || acct2_4.botToken !== REDACTED) {
    console.error(`[FAIL] Phase 4: accounts.account-2.botToken lost on edit-binding`);
    process.exit(1);
  }
  console.log(`[ok] Phase 4 verified — binding re-routed, both account auth preserved`);

  // ── Phase 5: Cleanup (composite null wipe + bindings=[]) ────
  console.log(
    `\n[Phase 5] Cleanup — wipe channels.${CHANNEL} + bindings via composite null patch`,
  );
  const cleanup = await tryPatch(conn, "cleanup", {
    channels: { [CHANNEL]: null },
    bindings: [],
  });
  if (!cleanup.ok) {
    console.error(`[FAIL] Phase 5 cleanup failed:`, cleanup.error);
    process.exit(1);
  }
  await waitHealth(row.port);
  cfg = await readConfig(conn);
  const chFinal = (cfg?.channels as Record<string, unknown> | undefined)?.[
    CHANNEL
  ];
  const bindFinal = cfg?.bindings as unknown[] | undefined;
  console.log(`[Phase 5 verify] channels.telegram =`, chFinal);
  console.log(`[Phase 5 verify] bindings.length =`, bindFinal?.length);
  if (chFinal !== undefined) {
    console.error(`[FAIL] Phase 5: channels.telegram not wiped`);
    process.exit(1);
  }
  if (Array.isArray(bindFinal) && bindFinal.length > 0) {
    console.error(`[FAIL] Phase 5: bindings not wiped`);
    process.exit(1);
  }
  console.log(`[ok] Phase 5 verified — cleanup complete`);

  console.log(`\n=== ALL 5 PHASES PASSED ===`);
  console.log(`Multi-account namespace separation: OK`);
  console.log(`Bindings per-account preservation:   OK`);
  console.log(`Edit-binding without auth loss:      OK`);
  console.log(`RFC 7396 null cleanup:               OK`);
  process.exit(0);
}

main().catch((err) => {
  console.error("[FATAL]", err);
  process.exit(1);
});
