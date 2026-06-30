// D5 — per-user volume backup/restore (admin ops tooling). Pure host-side Docker
// volume operations via a tiny `tar` sidecar container; no Hermes/engine change.
//
// On Windows Docker Desktop the backup dir is a local host path (drive must be
// shared with Docker). On VPS (DOCKER_HOST=ssh://) the dir is the REMOTE host's
// path — backups land on the VPS, not the operator's laptop.
import fs from "node:fs";
import path from "node:path";
import { hermesConfig } from "./config";
import {
  volumeName,
  runDockerOk,
  stopContainer,
  startContainer,
  getContainerStatus,
} from "./docker";

export type BackupEntry = {
  filename: string;
  sizeBytes: number;
  createdAt: string; // ISO
};

const VOLUME_MOUNT = "/data";
const BACKUP_MOUNT = "/backup";

function userPrefix(userId: string): string {
  return userId.slice(0, 16);
}

/** A backup filename is safe iff it has no path separators / traversal, ends in
 *  .tar.gz, and belongs to this user (prefix match). Defends the restore/delete
 *  paths against a crafted filename escaping the backup dir. */
export function isSafeBackupName(userId: string, filename: string): boolean {
  if (!filename || filename.length > 200) return false;
  if (filename.includes("/") || filename.includes("\\") || filename.includes("..")) {
    return false;
  }
  if (!filename.endsWith(".tar.gz")) return false;
  return filename.startsWith(`${userPrefix(userId)}-`);
}

async function ensureBackupDir(): Promise<string> {
  const dir = hermesConfig.volumeBackupDir;
  await fs.promises.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * Back up a user's volume to a timestamped tarball on the host. Backs up the
 * LIVE volume (no container stop) — good enough for the mostly-file `.hermes`
 * state; a write mid-tar is the only caveat. Returns the created filename.
 */
export async function backupVolume(
  userId: string,
  nowMs: number,
): Promise<{ filename: string; path: string }> {
  const dir = await ensureBackupDir();
  const filename = `${userPrefix(userId)}-${nowMs}.tar.gz`;
  await runDockerOk([
    "run",
    "--rm",
    "-v",
    `${volumeName(userId)}:${VOLUME_MOUNT}:ro`,
    "-v",
    `${dir}:${BACKUP_MOUNT}`,
    hermesConfig.tarImage,
    "tar",
    "czf",
    `${BACKUP_MOUNT}/${filename}`,
    "-C",
    VOLUME_MOUNT,
    ".",
  ]);
  return { filename, path: path.join(dir, filename) };
}

/**
 * Restore a user's volume from a tarball. DESTRUCTIVE: wipes the volume then
 * extracts. Stops the container first (if running) for a consistent restore and
 * restarts it after if it had been running. Caller MUST pre-validate the
 * filename with isSafeBackupName.
 */
export async function restoreVolume(
  userId: string,
  filename: string,
): Promise<{ ok: boolean; restarted: boolean; message: string }> {
  if (!isSafeBackupName(userId, filename)) {
    return { ok: false, restarted: false, message: "invalid backup filename" };
  }
  const dir = hermesConfig.volumeBackupDir;
  const filePath = path.join(dir, filename);
  try {
    await fs.promises.stat(filePath);
  } catch {
    return { ok: false, restarted: false, message: "backup file not found" };
  }

  const before = await getContainerStatus(userId);
  const wasRunning = before?.status === "running";
  if (wasRunning) {
    try {
      await stopContainer(userId);
    } catch {
      // proceed — the restore tar mounts the volume directly, not the container
    }
  }

  // Wipe (incl. dotfiles) then extract, in one sidecar. sh -c so the compound
  // runs inside the alpine container; the whole script is one shellEscaped arg.
  await runDockerOk([
    "run",
    "--rm",
    "-v",
    `${volumeName(userId)}:${VOLUME_MOUNT}`,
    "-v",
    `${dir}:${BACKUP_MOUNT}:ro`,
    hermesConfig.tarImage,
    "sh",
    "-c",
    `rm -rf ${VOLUME_MOUNT}/* ${VOLUME_MOUNT}/.[!.]* ${VOLUME_MOUNT}/..?* 2>/dev/null; ` +
      `tar xzf ${BACKUP_MOUNT}/${filename} -C ${VOLUME_MOUNT}`,
  ]);

  let restarted = false;
  if (wasRunning) {
    try {
      await startContainer(userId);
      restarted = true;
    } catch {
      // Container failed to come back; admin can start it manually. Restore of
      // the volume data itself already succeeded.
    }
  }
  return {
    ok: true,
    restarted,
    message: wasRunning
      ? restarted
        ? "restored; container restarted"
        : "restored; container did NOT restart (start manually)"
      : "restored; container was not running",
  };
}

/** List this user's backups (newest first). Host-side file listing — filters by
 *  the user prefix so one user's backups never leak into another's view. */
export async function listBackupsForUser(userId: string): Promise<BackupEntry[]> {
  const dir = hermesConfig.volumeBackupDir;
  let files: string[];
  try {
    files = await fs.promises.readdir(dir);
  } catch {
    return [];
  }
  const mine = files.filter((f) => isSafeBackupName(userId, f));
  const entries = await Promise.all(
    mine.map(async (f) => {
      try {
        const st = await fs.promises.stat(path.join(dir, f));
        return {
          filename: f,
          sizeBytes: st.size,
          createdAt: st.mtime.toISOString(),
        } satisfies BackupEntry;
      } catch {
        return null;
      }
    }),
  );
  return entries
    .filter((e): e is BackupEntry => e !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Delete one of a user's backups. Validates ownership + path safety first. */
export async function deleteBackup(
  userId: string,
  filename: string,
): Promise<boolean> {
  if (!isSafeBackupName(userId, filename)) return false;
  try {
    await fs.promises.unlink(path.join(hermesConfig.volumeBackupDir, filename));
    return true;
  } catch {
    return false;
  }
}
