/**
 * Re-pair chief's Telegram bot in the Hermes container (post-migration).
 *
 * Reads bridge token from user_container row; calls channels.pair RPC
 * with the saved bot token.
 */
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { withHermesBridge } from "@/lib/hermes/gateway-client";

// Secret: supply via env (CHIEF_TELEGRAM_TOKEN) — never hardcode a real token.
const CHIEF_TELEGRAM_TOKEN = process.env.CHIEF_TELEGRAM_TOKEN ?? "";
const CHIEF_EMAIL = "nugrahalabib@gmail.com";

async function main() {
  const [user] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, CHIEF_EMAIL))
    .limit(1);
  if (!user) throw new Error(`No user ${CHIEF_EMAIL}`);

  const [row] = await db
    .select()
    .from(schema.userContainers)
    .where(eq(schema.userContainers.userId, user.id))
    .limit(1);
  if (!row) throw new Error("No container row");

  console.log(`Pairing Telegram for ${CHIEF_EMAIL} via container ${row.containerName} on port ${row.port}`);

  const result = await withHermesBridge(
    {
      port: row.port,
      bridgeToken: row.gatewayToken,
      callerTag: "agentbuff-pair-chief",
      connectTimeoutMs: 15_000,
      defaultCallTimeoutMs: 30_000,
    },
    async (client) => {
      return await client.call("channels.pair", {
        channel: "telegram",
        accountId: "default",
        credentials: { botToken: CHIEF_TELEGRAM_TOKEN },
      });
    },
  );

  console.log("Pair result:", JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((e) => {
  console.error("Pair failed:", e);
  process.exit(1);
});
