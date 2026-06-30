import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import { hermesConfig } from "@/lib/hermes/config";

const exec = promisify(execFile);

async function docker(args: string[]) {
  try {
    const { stdout } = await exec("docker", args, { maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return `ERR: ${err.stderr ?? err.message ?? String(e)}`;
  }
}

async function main() {
  // HARD SAFETY GATE — this nuclear script docker-rm's every container/volume
  // matching the resolved prefix and shares the local Docker engine with live
  // PRODUCTION containers (hermes-user-*). If the HERMES_* env is ever absent
  // (e.g. run without --env-file=.env.local) the getters fall back to defaults;
  // refuse to run unless every scope is provably hack-isolated, so we can never
  // touch production. The Docker destroy block runs before any DB call, so this
  // check MUST be first.
  const dbUrl = process.env.DATABASE_URL ?? "";
  const hackScoped =
    hermesConfig.containerPrefix.includes("hack") &&
    hermesConfig.volumePrefix.includes("hack") &&
    hermesConfig.network.includes("hack") &&
    dbUrl.includes(":5433");
  if (!hackScoped) {
    console.error(
      "[reset] ABORT: resolved scope is NOT hack-isolated — refusing to touch production.\n" +
        `  containerPrefix='${hermesConfig.containerPrefix}' volumePrefix='${hermesConfig.volumePrefix}' network='${hermesConfig.network}'\n` +
        `  DATABASE_URL points at hack DB (:5433)? ${dbUrl.includes(":5433")}\n` +
        "  Run with: pnpm tsx --env-file=.env.local scripts/reset-all.ts",
    );
    process.exit(1);
  }

  // Match by NAME PREFIX, not the agentbuff.managed label: older/manually
  // provisioned containers may carry no label, so a label-only filter would
  // orphan them (left running, still holding their published ports + locking
  // their volume from removal). Name prefix catches every per-user container.
  console.log(`[reset] removing docker containers (name=${hermesConfig.containerPrefix}-*)…`);
  const ids = await docker(["ps", "-aq", "--filter", `name=${hermesConfig.containerPrefix}-`]);
  if (ids && !ids.startsWith("ERR") && ids.length > 0) {
    const list = ids.split(/\s+/).filter(Boolean);
    await docker(["rm", "-f", ...list]);
    console.log(`  removed ${list.length} container(s)`);
  } else {
    console.log("  none");
  }

  console.log(`[reset] removing volumes matching ${hermesConfig.volumePrefix}-*…`);
  const vols = await docker(["volume", "ls", "-q"]);
  if (!vols.startsWith("ERR")) {
    const matching = vols.split(/\s+/).filter((v) => v.startsWith(hermesConfig.volumePrefix + "-"));
    if (matching.length) {
      await docker(["volume", "rm", "-f", ...matching]);
      console.log(`  removed ${matching.length} volume(s)`);
    } else {
      console.log("  none");
    }
  }

  console.log("[reset] wiping DB rows (users cascade)…");
  await db.execute(sql`DELETE FROM "user_container"`);
  await db.execute(sql`UPDATE "container_port_slot" SET user_id = NULL, claimed_at = NULL`);
  await db.execute(sql`DELETE FROM "account"`);
  await db.execute(sql`DELETE FROM "session"`);
  await db.execute(sql`DELETE FROM "user_profile"`);
  await db.execute(sql`DELETE FROM "user"`);
  // early_access_lead has NO FK to user (standalone landing-page capture), so
  // the user cascade above never clears it. Wipe explicitly for a true reset.
  await db.execute(sql`DELETE FROM "early_access_lead"`);
  console.log("  done");

  const remain = await db.select().from(schema.users);
  console.log(`[reset] users remaining: ${remain.length}`);
  const cs = await db.select().from(schema.userContainers);
  console.log(`[reset] container rows remaining: ${cs.length}`);
  const ps = await db.execute<{ n: number }>(
    sql`SELECT COUNT(*)::int AS n FROM "container_port_slot" WHERE user_id IS NOT NULL`,
  );
  console.log(`[reset] port slots still claimed: ${ps[0]?.n ?? 0}`);

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
