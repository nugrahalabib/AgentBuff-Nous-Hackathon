// Throwaway test — call computeChannelsDashboard untuk user existing,
// konfirmasi filter baru: connectedChannels harus EMPTY (belum ada channel
// yang di-pair). Plugins loaded tapi semua account unconfigured → channel
// gak boleh masuk "Saluran Aktif". Run:
//   pnpm tsx --env-file=.env.local scripts/verify-channels-filter.ts

import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { computeChannelsDashboard } from "@/lib/dashboard/channels-service";

async function main() {
  const [row] = await db
    .select({ userId: schema.userContainers.userId })
    .from(schema.userContainers)
    .limit(1);
  if (!row) {
    console.error("no user_container row");
    process.exit(1);
  }
  console.error("user:", row.userId);

  const payload = await computeChannelsDashboard(row.userId);
  console.log("connectedChannels.length:", payload.connectedChannels.length);
  console.log(
    "connectedChannels ids:",
    payload.connectedChannels.map((c) => c.channelId),
  );
  console.log("totals:", payload.totals);
  console.log("engineLive:", payload.engineLive);
  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
