// Verify sessions.get returns the transcript for NON-default agent sessions
// (manager-pribadi / kak-tutor) — they live in profiles/<agent>/state.db, which
// the getter now reads. Before the fix, sessions.get read only the root db ->
// empty/NOT_FOUND -> /app snapped back to the Command Center.
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

async function main() {
  const [row] = await db.select().from(schema.userContainers).limit(1);
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  let pass = 0, fail = 0;
  const ok = (n: string, c: boolean, x = "") => { (c ? pass++ : fail++); console.log(`${c ? "PASS" : "FAIL"} — ${n}${x ? " :: " + x : ""}`); };

  await withGateway(
    { url, token: row.gatewayToken, clientId: "agentbuff-probe", instanceId: "sget" },
    async (c) => {
      const list = (await c.call("sessions.list", {})) as { sessions?: Array<{ key: string }> };
      const sessions = list.sessions ?? [];
      // pick one session per agent namespace
      const pick = (agent: string) =>
        sessions.find((s) => s.key.startsWith(`agent:${agent}:`));
      for (const agent of ["manager-pribadi", "kak-tutor", "main"]) {
        const s = pick(agent);
        if (!s) { console.log(`(no ${agent} session to test)`); continue; }
        const got = await c.call("sessions.get", { key: s.key }).catch((e) => ({ __err: (e as Error).message }));
        const g = got as { messages?: unknown[]; __err?: string };
        const n = Array.isArray(g.messages) ? g.messages.length : -1;
        ok(`sessions.get('${agent}') returns transcript`, !g.__err && n > 0, g.__err ? g.__err : `${n} messages, key=${s.key}`);
      }
      return null;
    },
  );
  console.log(`\n=== ${pass} passed, ${fail} failed ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("FAIL:", e); process.exit(1); });
