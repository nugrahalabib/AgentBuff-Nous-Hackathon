// Diagnostic: prove a BRAND-NEW user gets the agreed clean baseline. Creates a
// synthetic user, provisions a fresh container on the current :local image,
// inspects it (no stuck provider keys, lean skill pack, pack-hash marker, no
// stale platform_toolsets), then DESTROYS everything (container + volume +
// synthetic user) so the DB returns to empty. Run:
//   pnpm tsx --env-file=.env.local scripts/_verify-fresh-baseline.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { provisionContainer, destroyContainer, getContainerStatus } from "@/lib/hermes/docker";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

const exec = promisify(execFile);
const TEST_ID = "00000000-0000-4000-8000-baseline0001";
const HOME = "/home/hermes/.hermes";

async function dx(container: string, cmd: string): Promise<string> {
  try {
    // -u root: read everything regardless of seeded-file ownership (the
    // non-root container user couldn't traverse root-owned seeded skill dirs,
    // which made an earlier `find` falsely report 0).
    const { stdout } = await exec("docker", ["exec", "-u", "root", container, "sh", "-c", cmd], {
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    return `ERR: ${(err.stderr ?? err.message ?? String(e)).split("\n")[0]}`;
  }
}

async function main() {
  console.log("=== create synthetic user + provision fresh container ===");
  await db
    .insert(users)
    .values({ id: TEST_ID, email: "baseline-test@local", name: "Baseline Test" })
    .onConflictDoNothing();

  let containerName = "";
  try {
    const cfg = await provisionContainer(TEST_ID);
    containerName = cfg.containerName;
    console.log(`  provisioned: ${containerName} (port ${cfg.port}, image ${cfg.imageVersion})`);

    console.log("\n=== BASELINE INSPECTION (brand-new container, no login/BYOK) ===");

    const envKeys = await dx(
      containerName,
      `awk -F= '/_API_KEY=|_TOKEN=/ { v=substr($0,index($0,"=")+1); print "    " $1 "=" (length(v)>0 ? "PRESENT(len=" length(v) ")  <-- LEAK" : "empty") }' ${HOME}/.env 2>/dev/null || echo "    (.env: only timezone/no keys)"`,
    );
    console.log("  .env provider keys (must be NONE/empty):");
    console.log(envKeys || "    (none)");

    const allEnv = await dx(containerName, `grep -cE '_API_KEY=.+|_TOKEN=.+' ${HOME}/.env 2>/dev/null || echo 0`);
    console.log(`  -> non-empty key/token lines in .env: ${allEnv}`);

    const coreSkills = await dx(containerName, `ls -d ${HOME}/skills/*/ 2>/dev/null | wc -l`);
    const optionalSeeded = await dx(
      containerName,
      `for d in mlops red-teaming audiocraft segment-anything vllm lm-evaluation-harness; do test -d ${HOME}/skills/$d && echo $d; done | wc -l`,
    );
    console.log(`  skills on disk (lean core, expect ~78): ${coreSkills}`);
    console.log(`  optional-pack junk seeded (expect 0): ${optionalSeeded}`);

    const packHash = await dx(containerName, `cat ${HOME}/.agentbuff_pack_hash 2>/dev/null || echo "(missing)"`);
    console.log(`  .agentbuff_pack_hash marker: ${packHash}`);
    const markers = await dx(containerName, `ls -1a ${HOME} 2>/dev/null | grep agentbuff | tr '\\n' ' '`);
    console.log(`  agentbuff dotfile markers present: ${markers || "(none)"}`);

    const platformToolsets = await dx(
      containerName,
      `grep -c 'platform_toolsets' ${HOME}/config.yaml 2>/dev/null || echo 0`,
    );
    console.log(`  platform_toolsets in config.yaml (expect 0 = no stale gating): ${platformToolsets}`);

    const baseline = await dx(
      containerName,
      `python -c "import json; print(len(json.load(open('${HOME}/skills/.agentbuff_builtin_baseline.json'))))" 2>/dev/null || echo "(not captured yet)"`,
    );
    console.log(`  builtin baseline snapshot size: ${baseline}`);

    console.log("\n=== ENTRYPOINT / SEED LOGS (diagnose why skills=0) ===");
    try {
      const { stdout, stderr } = await exec("docker", ["logs", containerName], {
        maxBuffer: 16 * 1024 * 1024,
      });
      const all = (stdout + "\n" + stderr)
        .split("\n")
        .filter((l) => /seed|skill|reconcile|pack|bundled|HERMES_HOME|optional|lean/i.test(l))
        .slice(0, 30);
      console.log(all.length ? all.map((l) => "    " + l).join("\n") : "    (no seed/skill log lines)");
    } catch (e) {
      console.log(`    logs err: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
    }
    console.log("\n  -- raw dir checks --");
    console.log(`  HERMES_HOME env in container: ${await dx(containerName, "printenv HERMES_HOME AGENTBUFF_LEAN_ENGINE 2>/dev/null | tr '\\n' ' '")}`);
    console.log(`  ls ~/.hermes (top): ${await dx(containerName, `ls -1 ${HOME} 2>/dev/null | tr '\\n' ' '`)}`);
    console.log(`  /opt bundled core: ${await dx(containerName, "find /opt/hermes-bundled-skills/skills -name SKILL.md 2>/dev/null | wc -l")}`);

    console.log("\n=== AUTHORITATIVE: what the ENGINE sees (skills.status RPC) ===");
    const status = await getContainerStatus(TEST_ID);
    if (status) {
      try {
        await withGateway(
          {
            url: `ws://${hermesConfig.publicHost}:${status.port}/`,
            token: status.bridgeToken,
            clientId: "agentbuff-baseline-probe",
            instanceId: `baseline-${TEST_ID.slice(0, 8)}`,
          },
          async (c) => {
            const r = (await c.call("skills.status", {})) as Record<string, unknown>;
            const skills = (r.skills ?? r.entries) as unknown[] | undefined;
            console.log(`  skills.status keys: ${Object.keys(r).join(", ")}`);
            console.log(`  engine skill count: ${Array.isArray(skills) ? skills.length : JSON.stringify({ enabled: r.enabled, disabledCount: r.disabledCount, total: r.total })}`);
          },
        );
      } catch (e) {
        console.log(`  skills.status err: ${e instanceof Error ? e.message.split("\n")[0] : String(e)}`);
      }
    }
  } finally {
    console.log("\n=== cleanup: destroy container + volume + synthetic user (restore empty) ===");
    try {
      await destroyContainer(TEST_ID);
      console.log("  container + volume destroyed");
    } catch (e) {
      console.log(`  destroy err: ${e instanceof Error ? e.message : String(e)}`);
    }
    await db.delete(users).where(eq(users.id, TEST_ID));
    console.log("  synthetic user deleted");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("FAIL:", e);
  process.exit(1);
});
