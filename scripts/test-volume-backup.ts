// D5 regression smoke test — exercises the real volume backup/list/delete path
// against a live user volume. backupVolume mounts the volume read-only and
// deleteBackup only removes the tarball this test created, so it never mutates
// volume data. Run: pnpm tsx --env-file=.env.local scripts/test-volume-backup.ts
import fs from "node:fs";
import { db } from "@/lib/db";
import { userContainers } from "@/lib/db/schema";
import {
  backupVolume,
  listBackupsForUser,
  deleteBackup,
  isSafeBackupName,
} from "@/lib/hermes/backup";

function assert(cond: boolean, label: string): void {
  if (!cond) {
    console.error(`FAIL: ${label}`);
    process.exit(1);
  }
  console.log(`PASS: ${label}`);
}

async function main(): Promise<void> {
  const [row] = await db.select().from(userContainers).limit(1);
  if (!row) {
    console.error("no user_container rows — provision a container first");
    process.exit(1);
  }
  const userId = row.userId;
  console.log(`testing against userId=${userId.slice(0, 16)}… (volume hermes-user-${userId.slice(0, 16)})`);

  const nowMs = Date.now();
  const { filename, path: tarPath } = await backupVolume(userId, nowMs);
  console.log(`created: ${filename}`);

  assert(isSafeBackupName(userId, filename), "filename passes isSafeBackupName");
  const st = fs.statSync(tarPath);
  assert(st.isFile() && st.size > 0, `tarball exists on host and is non-empty (${st.size} bytes)`);

  const list = await listBackupsForUser(userId);
  assert(list.some((e) => e.filename === filename), "backup appears in listBackupsForUser");

  const deleted = await deleteBackup(userId, filename);
  assert(deleted, "deleteBackup returns true");
  assert(!fs.existsSync(tarPath), "tarball removed from host after delete");

  // Negative: a crafted traversal/foreign filename must be rejected.
  assert(!isSafeBackupName(userId, "../etc-passwd.tar.gz"), "rejects path traversal filename");
  assert(!isSafeBackupName(userId, "deadbeef00000000-1.tar.gz"), "rejects foreign-user filename");

  console.log("\nALL PASS — D5 volume backup/list/delete verified end-to-end.");
  process.exit(0);
}

main().catch((e) => {
  console.error("ERROR:", e);
  process.exit(1);
});
