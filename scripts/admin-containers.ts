import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import {
  provisionContainer,
  destroyContainer,
  startContainer,
  stopContainer,
} from "@/lib/hermes/docker";

const exec = promisify(execFile);

async function list() {
  const rows = await db.select().from(schema.userContainers);
  console.table(
    rows.map((r) => ({
      user: r.userId.slice(0, 8),
      name: r.containerName,
      port: r.port,
      status: r.status,
      attempts: r.provisionAttempts,
      error: r.errorMessage?.slice(0, 40) ?? "",
    })),
  );
}

async function reconcile() {
  const rows = await db.select().from(schema.userContainers);
  for (const r of rows) {
    try {
      const { stdout } = await exec("docker", ["inspect", "-f", "{{.State.Running}}", r.containerName]);
      const running = stdout.trim() === "true";
      if (r.status === "running" && !running) {
        console.log(`[reconcile] ${r.containerName}: row=running, docker=stopped → marking failed`);
        await db.update(schema.userContainers)
          .set({ status: "failed", errorMessage: "reconcile: docker reports stopped" })
          .where(eq(schema.userContainers.userId, r.userId));
      }
    } catch {
      console.log(`[reconcile] ${r.containerName}: docker does not know → marking failed`);
      await db.update(schema.userContainers)
        .set({ status: "failed", errorMessage: "reconcile: container missing" })
        .where(eq(schema.userContainers.userId, r.userId));
    }
  }
  console.log("reconcile done");
}

async function logs(userIdPrefix: string) {
  const rows = await db.select().from(schema.userContainers);
  const row = rows.find((r) => r.userId.startsWith(userIdPrefix));
  if (!row) return console.error("user not found");
  const { stdout } = await exec("docker", ["logs", "--tail=200", row.containerName]);
  console.log(stdout);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  switch (cmd) {
    case "list":
      await list();
      break;
    case "reconcile":
      await reconcile();
      break;
    case "logs":
      if (!arg) return console.error("usage: logs <userIdPrefix>");
      await logs(arg);
      break;
    case "provision":
      if (!arg) return console.error("usage: provision <userId>");
      await provisionContainer(arg);
      break;
    case "destroy":
      if (!arg) return console.error("usage: destroy <userId>");
      await destroyContainer(arg);
      break;
    case "start":
      if (!arg) return console.error("usage: start <userId>");
      await startContainer(arg);
      break;
    case "stop":
      if (!arg) return console.error("usage: stop <userId>");
      await stopContainer(arg);
      break;
    default:
      console.log(`commands:
  list                     - show all container rows
  reconcile                - mark stale rows (docker says not running) as failed
  logs <userIdPrefix>      - docker logs for that user
  provision <userId>       - force provision for a user
  destroy <userId>         - rm container + volume + release port
  start <userId>           - docker start
  stop  <userId>           - docker stop`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
