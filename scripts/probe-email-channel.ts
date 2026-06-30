// Probe: confirm the bridge accepts "email" as a synthetic pair channel.
// Sends channels.pair with deliberately-empty creds → expects a
// "missing required field" validation error (proves email IS wired into
// PER_CHANNEL_PAIR_SCHEMA + the email-always-synthetic dispatch). An
// "unsupported channel" error would mean the new channels_handler.py
// didn't load. Non-destructive: empty creds never persist anything.
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

async function main() {
  const [row] = await db.select().from(schema.userContainers).limit(1);
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  await withGateway(
    { url, token: row.gatewayToken, clientId: "agentbuff-probe", instanceId: "email-probe" },
    async (c) => {
      // 1) Empty creds → should be a FIELD validation error (email is supported).
      try {
        await c.call("channels.pair", { channel: "email", credentials: {} });
        console.log("UNEXPECTED: pair accepted empty creds");
      } catch (e) {
        const m = (e as Error).message;
        console.log("pair(email, {}) →", m.slice(0, 160));
        console.log(
          /missing required field/i.test(m)
            ? "VERDICT: email IS a supported pair channel (field-validated)"
            : /unsupported|not in the supported/i.test(m)
              ? "VERDICT: email NOT wired (bridge rejected channel) — channels_handler stale"
              : "VERDICT: other error (inspect above)",
        );
      }
      // 2) channels.status liveness — count of channels surfaced.
      try {
        const st = (await c.call("channels.status", {})) as {
          channels?: Record<string, unknown>;
        };
        console.log("channels.status keys:", Object.keys(st.channels ?? {}).length);
      } catch (e) {
        console.log("status ERR:", (e as Error).message);
      }
      return null;
    },
  );
  process.exit(0);
}
main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
