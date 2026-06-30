// Integration test untuk pairing flow tiap channel — pakai test token /
// fake JSON untuk verify engine config.patch path benar dan `channels.status`
// reflect state setelah patch. Saat user actually paste real credentials,
// channel akan start runtime; di test ini kita pakai garbage values yang
// sengaja gak valid supaya engine gak boot real connection ke Telegram/
// Discord/Slack server.
//
// Yang di-test:
//   1. WhatsApp: web.login.start return QR (already verified end-to-end)
//   2. Telegram: patch botToken → channels.status whatsapp.configured = true
//   3. Discord: patch token (NOT botToken) → channels.status discord.configured = true
//   4. Slack: patch botToken/appToken/signingSecret/mode/enabled → channels.status slack.configured = true
//   5. Google Chat: patch serviceAccount → channels.status googlechat.configured = true (atau error JSON shape)
//
// Run:
//   pnpm tsx --env-file=.env.local scripts/test-pairing-flows.ts
//
// Cleanup setelah selesai: scripts mereset ke unconfigured state via
// channels.logout or config.patch dengan empty field.

import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway, type GatewayClient } from "@/lib/hermes/gateway-client";

type ChannelsStatus = {
  channels: Record<string, { configured?: boolean; linked?: boolean }>;
};

async function getChannelStatus(
  client: GatewayClient,
  channelId: string,
): Promise<{ configured: boolean; linked?: boolean }> {
  const result = await client.call<ChannelsStatus>("channels.status", {});
  const ch = result.channels?.[channelId];
  return {
    configured: ch?.configured === true,
    linked: ch?.linked,
  };
}

async function patchConfig(
  client: GatewayClient,
  partial: Record<string, unknown>,
): Promise<void> {
  // Match the helper di src/components/app/channels/config-patch.ts
  const snapshot = await client.call<{ hash?: string }>("config.get", {});
  const baseHash =
    typeof snapshot?.hash === "string" ? snapshot.hash.trim() : "";
  if (!baseHash) throw new Error("no baseHash");
  await client.call("config.patch", {
    raw: JSON.stringify(partial),
    baseHash,
  });
}

async function logoutChannel(
  client: GatewayClient,
  channelId: string,
): Promise<void> {
  try {
    await client.call("channels.logout", {
      channelId,
      accountId: "default",
    });
  } catch (err) {
    console.error(
      `[cleanup] channels.logout ${channelId} failed:`,
      err instanceof Error ? err.message : String(err),
    );
  }
}

type TestResult = {
  channel: string;
  pass: boolean;
  detail: string;
};

// Connection params reused across multiple withGateway invocations.
type ConnInfo = { url: string; token: string; userIdShort: string };

// Open fresh gateway connection — engine closes the proxy during reload,
// so we reconnect after each patch step.
async function withFreshGateway<T>(
  conn: ConnInfo,
  label: string,
  fn: (c: GatewayClient) => Promise<T>,
): Promise<T> {
  return withGateway(
    {
      url: conn.url,
      token: conn.token,
      clientId: "openclaw-control-ui",
      instanceId: `pairing-test-${conn.userIdShort}-${label}`,
      defaultCallTimeoutMs: 15_000,
    },
    fn,
  );
}

async function applyAndVerify(
  conn: ConnInfo,
  channelId: string,
  partialChannel: Record<string, unknown>,
): Promise<TestResult> {
  let beforeConfigured = false;
  try {
    beforeConfigured = await withFreshGateway(conn, `${channelId}-pre`, async (c) =>
      (await getChannelStatus(c, channelId)).configured,
    );
  } catch {
    /* ignore */
  }

  // Patch in a separate connection. Engine SIGUSR1 + full process restart
  // when channels.* changes — WS will hang up. We absorb that as expected.
  try {
    await withFreshGateway(conn, `${channelId}-patch`, async (c) => {
      await patchConfig(c, { channels: { [channelId]: partialChannel } });
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Expected error class: socket hang up / restart / closed. Anything
    // else is a real failure.
    if (
      !/socket hang up|service restart|gateway closed|gateway is shutting down|read ECONNRESET|gateway timeout|gateway connect timeout/i.test(
        msg,
      )
    ) {
      return {
        channel: channelId,
        pass: false,
        detail: `patch failed (unexpected error): ${msg}`,
      };
    }
  }

  // Engine restart takes ~30-40s (loads channel plugins). Poll every
  // 2s up to 90s for healthz, then verify.
  const deadline = Date.now() + 90_000;
  let healthy = false;
  while (Date.now() < deadline) {
    try {
      const ok = await fetch(
        `http://${hermesConfig.publicHost}:${conn.url.split(":")[2].replace("/", "")}/healthz`,
        { signal: AbortSignal.timeout(2000) },
      ).then((r) => r.ok).catch(() => false);
      if (ok) {
        healthy = true;
        break;
      }
    } catch {
      /* keep waiting */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!healthy) {
    return {
      channel: channelId,
      pass: false,
      detail: `gateway never came back up after restart`,
    };
  }
  // Extra grace for plugin warmup after healthz returns OK.
  await new Promise((r) => setTimeout(r, 3000));

  // Re-verify in a fresh connection.
  let afterConfigured = false;
  let verifyError: string | null = null;
  try {
    afterConfigured = await withFreshGateway(
      conn,
      `${channelId}-post`,
      async (c) => (await getChannelStatus(c, channelId)).configured,
    );
  } catch (err) {
    verifyError = err instanceof Error ? err.message : String(err);
  }
  if (verifyError) {
    return {
      channel: channelId,
      pass: false,
      detail: `verify failed: ${verifyError}`,
    };
  }
  return {
    channel: channelId,
    pass: afterConfigured === true,
    detail: `before=${beforeConfigured} → after=${afterConfigured}`,
  };
}

async function testTelegram(conn: ConnInfo): Promise<TestResult> {
  return applyAndVerify(conn, "telegram", {
    botToken: "1234567890:AAAA-BBBB-CCCC-fake-test-token-DDDD-EEEE",
    enabled: true,
  });
}

async function testDiscord(conn: ConnInfo): Promise<TestResult> {
  return applyAndVerify(conn, "discord", {
    // Field is `token` for Discord (NOT botToken). This is the bug fix.
    token: "MTQXXXXXXXXXXXXXXXXXXXXXXXXX.fake.test-token-not-real-discord-token-padding",
    enabled: true,
  });
}

async function testSlack(conn: ConnInfo): Promise<TestResult> {
  return applyAndVerify(conn, "slack", {
    mode: "socket",
    botToken: "xoxb-fake-test-not-real-bot-token",
    appToken: "xapp-fake-test-not-real-app-token",
    signingSecret: "fake-signing-secret",
    enabled: true,
  });
}

async function testGoogleChat(conn: ConnInfo): Promise<TestResult> {
  const fakeSa = {
    type: "service_account",
    project_id: "fake-test-project",
    private_key_id: "fake-id",
    private_key:
      "-----BEGIN PRIVATE KEY-----\nfake-test-not-real\n-----END PRIVATE KEY-----\n",
    client_email: "fake@fake-test-project.iam.gserviceaccount.com",
    client_id: "1234567890",
    auth_uri: "https://accounts.google.com/o/oauth2/auth",
    token_uri: "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url:
      "https://www.googleapis.com/robot/v1/metadata/x509/fake.iam.gserviceaccount.com",
  };
  return applyAndVerify(conn, "googlechat", {
    serviceAccount: fakeSa,
    enabled: true,
  });
}

async function cleanupAll(conn: ConnInfo): Promise<void> {
  console.log("\n--- cleanup: reset test channel configs to clean state ---");
  // Reset tokens to empty + enabled=false so user gets clean dashboard
  // for real testing afterwards.
  for (const channelId of ["telegram", "discord", "slack", "googlechat"]) {
    try {
      await withFreshGateway(conn, `cleanup-${channelId}`, async (c) => {
        // We can't easily delete fields via patch; set them back to the
        // engine "unset" value (empty string for tokens, false for enabled,
        // empty object for serviceAccount).
        const reset: Record<string, unknown> = { enabled: false };
        if (channelId === "telegram") reset.botToken = "";
        if (channelId === "discord") reset.token = "";
        if (channelId === "slack") {
          reset.botToken = "";
          reset.appToken = "";
          reset.signingSecret = "";
        }
        // googlechat serviceAccount is object — set undefined doesn't work,
        // try channels.logout instead.
        if (channelId === "googlechat") {
          try {
            await c.call("channels.logout", { channelId, accountId: "default" });
          } catch {
            /* ignore */
          }
          return;
        }
        await patchConfig(c, { channels: { [channelId]: reset } });
      });
      await new Promise((r) => setTimeout(r, 1500));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/service restart|gateway closed/i.test(msg)) {
        console.error(`[cleanup] ${channelId}:`, msg);
      }
    }
  }
}

async function main() {
  const [row] = await db
    .select({
      userId: schema.userContainers.userId,
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
    })
    .from(schema.userContainers)
    .limit(1);
  if (!row) {
    console.error("no user_container row");
    process.exit(1);
  }
  console.log("user:", row.userId, "port:", row.port);

  const conn: ConnInfo = {
    url: `ws://${hermesConfig.publicHost}:${row.port}/`,
    token: row.gatewayToken,
    userIdShort: row.userId.slice(0, 8),
  };
  const results: TestResult[] = [];

  console.log("\n=== Telegram ===");
  results.push(await testTelegram(conn));
  console.log("\n=== Discord ===");
  results.push(await testDiscord(conn));
  console.log("\n=== Slack ===");
  results.push(await testSlack(conn));
  console.log("\n=== Google Chat ===");
  results.push(await testGoogleChat(conn));

  await cleanupAll(conn);

  console.log("\n========== SUMMARY ==========");
  for (const r of results) {
    console.log(
      `${r.pass ? "✅ PASS" : "❌ FAIL"}  ${r.channel.padEnd(12)} ${r.detail}`,
    );
  }
  const failed = results.filter((r) => !r.pass).length;
  process.exit(failed === 0 ? 0 : 2);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
