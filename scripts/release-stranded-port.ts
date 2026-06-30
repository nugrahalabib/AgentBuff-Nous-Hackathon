/**
 * Release a stranded port claim for a user with no container row.
 *
 * Usage: pnpm tsx --env-file=.env.local scripts/release-stranded-port.ts <userId>
 */
import { releasePort } from "@/lib/hermes/ports";

const userId = process.argv[2];
if (!userId) {
  console.error("usage: release-stranded-port.ts <userId>");
  process.exit(1);
}

(async () => {
  await releasePort(userId);
  console.log(`Released port claim for userId=${userId}`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
