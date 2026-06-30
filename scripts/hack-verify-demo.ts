/**
 * hack-verify-demo.ts — one-command pre-demo smoke check.
 * Run: pnpm tsx --env-file=.env.local scripts/hack-verify-demo.ts
 *
 * Asserts all demo dependencies are live BEFORE recording, so you never burn a take
 * on a dead service. Read-only: never touches production, never restarts anything.
 */
import { execSync } from "node:child_process";

const PORTAL = "http://localhost:617";
const POS_FRONTEND = process.env.POS_WEBAPP_URL ?? "http://localhost:7703";
const POS_BACKEND = process.env.POS_BACKEND_URL ?? "http://localhost:7704";

type Check = { name: string; ok: boolean; detail: string };
const checks: Check[] = [];

function sh(cmd: string): string {
  try {
    return execSync(cmd, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

async function http(
  url: string,
  opts?: { json?: boolean },
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    const body = await res.text();
    if (opts?.json) {
      try {
        JSON.parse(body);
      } catch {
        return { ok: false, detail: `non-JSON (HTTP ${res.status})` };
      }
    }
    // 200 = ok; 307 = auth redirect (portal); 426 = WS upgrade (gateway) — all "alive".
    const alive = res.ok || res.status === 307 || res.status === 426;
    return { ok: alive, detail: `HTTP ${res.status}` };
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
}

async function main(): Promise<void> {
  const portal = await http(`${PORTAL}/api/auth/session`, { json: true });
  checks.push({ name: "Portal /api/auth/session (617)", ...portal });

  const posFe = await http(POS_FRONTEND);
  checks.push({ name: "POS frontend (7703)", ...posFe });

  const posBe = await http(`${POS_BACKEND}/health`, { json: true });
  checks.push({ name: "POS backend /health (7704)", ...posBe });

  const cname = sh('docker ps --filter "name=hermes-hack-user-" --format "{{.Names}}"')
    .split("\n")
    .filter(Boolean)[0];

  if (!cname) {
    checks.push({
      name: "Hack container",
      ok: false,
      detail: "not found (hermes-hack-user-*) — reprovision via /loby",
    });
  } else {
    const health = sh(`docker inspect --format "{{.State.Health.Status}}" ${cname}`);
    checks.push({
      name: `Container ${cname}`,
      ok: health === "healthy",
      detail: `health=${health || "?"}`,
    });

    const mcp = sh(`docker exec ${cname} hermes mcp list`);
    const mcpOk = /agentbuff-pos/.test(mcp) && /(enabled|✓)/.test(mcp);
    checks.push({
      name: "MCP agentbuff-pos",
      ok: mcpOk,
      detail: mcpOk ? "enabled" : "NOT enabled (run hack-reset-demo.ts + docker restart)",
    });

    const model = sh(
      `docker exec ${cname} sh -lc "grep -i default ~/.hermes/config.yaml 2>/dev/null | head -3"`,
    );
    const modelOk = /nemotron/i.test(model);
    checks.push({
      name: "Model = Nemotron",
      ok: modelOk,
      detail: modelOk ? "nemotron-3-super" : `NOT nemotron (${model || "unreadable"})`,
    });
  }

  let allOk = true;
  for (const c of checks) {
    if (!c.ok) allOk = false;
    console.log(`[${c.ok ? "PASS" : "FAIL"}] ${c.name} — ${c.detail}`);
  }
  console.log(
    allOk
      ? "\nSEMUA HIJAU — siap rekam. (NEW thread + status pill CONNECTED dulu.)"
      : "\nADA YANG MERAH — perbaiki sebelum rekam (lihat DEMO-SCENARIO.md §A).",
  );
  process.exit(allOk ? 0 : 1);
}

void main();
