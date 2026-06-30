// Live end-to-end audit of the agents.* RPC family against the REAL Hermes container.
//
// Connects via WebSocket exactly like scripts/test-peragent-chat.mjs:
//   ws://127.0.0.1:<PORT>/ with an Origin header, send a "connect" frame
//   (operator scopes + auth.token), then send {type:"req",id,method,params}
//   frames and await {type:"res"} replies.
//
// SAFETY: only mutates throwaway agents whose id starts with "zaudit".
// Never touches default / kiwi / main. Cleans up at the end and re-lists.
//
// Run: node scripts/audit-agents-rpc.mjs   (port/token inlined below)
import WebSocket from "ws";

// --- inlined connection constants (per task spec) ---
const PORT = "18800";
const TOKEN = "a08929663626986741bc850f22b4a7d345b384bc3a1a5076a7ed7274c012b10f";

const WS_URL = `ws://127.0.0.1:${PORT}/`;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const PROTECTED = new Set(["default", "kiwi", "main"]);

let idCounter = 1;
const pending = new Map();
let ws;

function nextId() {
  return String(idCounter++);
}

// Send a req frame and resolve with { ok, result, error } when the matching
// res arrives. Never rejects on RPC error — we want to *capture* the error,
// not throw. Rejects only on timeout / transport failure.
function call(method, params = {}, timeoutMs = 30000) {
  return new Promise((resolve, reject) => {
    const id = nextId();
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    pending.set(id, { method, resolve, reject, timer });
    ws.send(JSON.stringify({ type: "req", id, method, params }));
  });
}

const OPERATOR_SCOPES = [
  "operator.admin",
  "operator.read",
  "operator.write",
  "operator.approvals",
  "operator.pairing",
];

// connect is a normal req frame on this bridge (see test-peragent-chat.mjs /
// gateway-client.ts). NOT a bare {type:"connect"} frame — that gets 4001.
async function doConnect() {
  const r = await call("connect", {
    minProtocol: 3,
    maxProtocol: 3,
    client: { id: "agentbuff-audit", version: "1", platform: "node", mode: "backend" },
    role: "operator",
    scopes: OPERATOR_SCOPES,
    auth: { token: TOKEN },
  }, 15000);
  if (!r.ok) {
    throw new Error(`connect rejected: ${errStr(r.error)}`);
  }
  return r.result;
}

// --- result table ---
const rows = [];
function record(step, name, pass, summary) {
  rows.push({ step, name, pass, summary });
  const tag = pass ? "PASS" : "FAIL";
  console.log(`STEP ${step} ${name} -> ${tag} | ${summary}`);
}

function errStr(error) {
  if (!error) return "(no error object)";
  const code = error.code ?? "(no code)";
  const msg = error.message ?? "(no message)";
  return `code=${code} message=${msg}`;
}

// short JSON preview
function preview(obj, len = 220) {
  try {
    const s = JSON.stringify(obj);
    return s.length > len ? s.slice(0, len) + "…" : s;
  } catch {
    return String(obj);
  }
}

function waitOpen() {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("ws open timeout")), 10000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

async function runAudit() {
  // ===== READ-ONLY =====

  // 1. agents.list
  let listRes;
  try {
    const r = await call("agents.list", {});
    listRes = r;
    if (r.ok) {
      const ids = (r.result?.agents || []).map((a) => a.id).join(", ");
      record(1, "agents.list", true, `defaultId=${r.result?.defaultId} ids=[${ids}]`);
    } else {
      record(1, "agents.list", false, errStr(r.error));
    }
  } catch (e) {
    record(1, "agents.list", false, `EXC ${e.message}`);
  }

  // 2. agents.get kiwi
  try {
    const r = await call("agents.get", { agentId: "kiwi" });
    if (r.ok) {
      const a = r.result?.agent || r.result || {};
      const hasModel = !!(a.model || r.result?.model);
      const hasIdentity = !!(a.identity || r.result?.identity);
      const soul = r.result?.soul ?? a.soul;
      const hasSoul = typeof soul === "string" && soul.length > 0;
      record(
        2,
        "agents.get(kiwi)",
        true,
        `model=${hasModel} identity=${hasIdentity} soul=${hasSoul}(${typeof soul === "string" ? soul.length : 0}ch)`,
      );
    } else {
      record(2, "agents.get(kiwi)", false, errStr(r.error));
    }
  } catch (e) {
    record(2, "agents.get(kiwi)", false, `EXC ${e.message}`);
  }

  // 3. agents.files.list kiwi
  try {
    const r = await call("agents.files.list", { agentId: "kiwi" });
    if (r.ok) {
      const files = r.result?.files || [];
      record(3, "agents.files.list(kiwi)", true, `files=[${files.join(", ")}]`);
    } else {
      record(3, "agents.files.list(kiwi)", false, errStr(r.error));
    }
  } catch (e) {
    record(3, "agents.files.list(kiwi)", false, `EXC ${e.message}`);
  }

  // 4. agents.files.get kiwi SOUL.md
  try {
    const r = await call("agents.files.get", { agentId: "kiwi", filename: "SOUL.md" });
    if (r.ok) {
      const content = r.result?.content ?? "";
      record(4, "agents.files.get(kiwi,SOUL.md)", true, `content length=${content.length}`);
    } else {
      record(4, "agents.files.get(kiwi,SOUL.md)", false, errStr(r.error));
    }
  } catch (e) {
    record(4, "agents.files.get(kiwi,SOUL.md)", false, `EXC ${e.message}`);
  }

  // 5. agents.memory.entries kiwi
  try {
    const r = await call("agents.memory.entries", { agentId: "kiwi" });
    if (r.ok) {
      const entries = r.result?.entries || [];
      record(5, "agents.memory.entries(kiwi)", true, `count=${entries.length}`);
    } else {
      record(5, "agents.memory.entries(kiwi)", false, errStr(r.error));
    }
  } catch (e) {
    record(5, "agents.memory.entries(kiwi)", false, `EXC ${e.message}`);
  }

  // 6. skills.status kiwi
  try {
    const r = await call("skills.status", { agentId: "kiwi" });
    if (r.ok) {
      const res = r.result || {};
      const count = Array.isArray(res.skills)
        ? res.skills.length
        : Array.isArray(res)
          ? res.length
          : res.count ?? "?";
      record(6, "skills.status(kiwi)", true, `count=${count} shape=${preview(res, 120)}`);
    } else {
      record(6, "skills.status(kiwi)", false, errStr(r.error));
    }
  } catch (e) {
    record(6, "skills.status(kiwi)", false, `EXC ${e.message}`);
  }

  // 7. models.list
  try {
    const r = await call("models.list", {});
    if (r.ok) {
      const res = r.result || {};
      let shape = "unknown";
      let count = "?";
      if (Array.isArray(res.providers)) {
        shape = "providers[]";
        count = res.providers.length;
      } else if (Array.isArray(res.models)) {
        shape = "models[]";
        count = res.models.length;
      } else if (Array.isArray(res)) {
        shape = "array";
        count = res.length;
      }
      record(7, "models.list", true, `shape=${shape} count=${count} preview=${preview(res, 120)}`);
    } else {
      record(7, "models.list", false, errStr(r.error));
    }
  } catch (e) {
    record(7, "models.list", false, `EXC ${e.message}`);
  }

  // 8. agents.template.list
  try {
    const r = await call("agents.template.list", {});
    if (r.ok) {
      const t = r.result?.templates || r.result || [];
      const count = Array.isArray(t) ? t.length : "?";
      record(8, "agents.template.list", true, `templates=${count} preview=${preview(r.result, 120)}`);
    } else {
      record(8, "agents.template.list", false, errStr(r.error));
    }
  } catch (e) {
    record(8, "agents.template.list", false, `EXC ${e.message}`);
  }

  // ===== MUTATION (throwaway zaudit* only) =====
  const A1 = "zaudit1";
  const A2 = "zaudit2";

  // 9. agents.create zaudit1
  try {
    const r = await call(
      "agents.create",
      {
        id: A1,
        profile: { name: "ZAudit", identity: { name: "ZAudit" } },
        soulContent: "Kamu agen uji.",
      },
      60000,
    );
    if (r.ok) {
      record(9, "agents.create(zaudit1)", true, `id=${r.result?.id ?? A1} preview=${preview(r.result, 120)}`);
    } else {
      record(9, "agents.create(zaudit1)", false, errStr(r.error));
    }
  } catch (e) {
    record(9, "agents.create(zaudit1)", false, `EXC ${e.message}`);
  }

  // 10. agents.get zaudit1 -> persisted?
  try {
    const r = await call("agents.get", { agentId: A1 });
    if (r.ok) {
      const a = r.result?.agent || r.result || {};
      const name = a.name || a.identity?.name;
      const soul = r.result?.soul ?? a.soul ?? "";
      record(
        10,
        "agents.get(zaudit1)",
        true,
        `name=${name} soul="${String(soul).slice(0, 40)}"(${String(soul).length}ch)`,
      );
    } else {
      record(10, "agents.get(zaudit1)", false, errStr(r.error));
    }
  } catch (e) {
    record(10, "agents.get(zaudit1)", false, `EXC ${e.message}`);
  }

  // 11. agents.update zaudit1 description -> verify via re-get
  try {
    const u = await call("agents.update", { agentId: A1, patch: { description: "updated desc" } });
    if (!u.ok) {
      record(11, "agents.update(zaudit1)", false, `update ${errStr(u.error)}`);
    } else {
      const g = await call("agents.get", { agentId: A1 });
      const a = g.result?.agent || g.result || {};
      const desc = a.description;
      const ok = desc === "updated desc";
      record(11, "agents.update(zaudit1)", ok, ok ? `description="${desc}" (verified)` : `re-get description="${desc}" (mismatch)`);
    }
  } catch (e) {
    record(11, "agents.update(zaudit1)", false, `EXC ${e.message}`);
  }

  // 12. agents.files.set zaudit1 SOUL.md -> verify via files.get
  try {
    const newSoul = "Kamu agen uji versi 2.";
    const s = await call("agents.files.set", { agentId: A1, filename: "SOUL.md", content: newSoul });
    if (!s.ok) {
      record(12, "agents.files.set(zaudit1,SOUL.md)", false, `set ${errStr(s.error)}`);
    } else {
      const g = await call("agents.files.get", { agentId: A1, filename: "SOUL.md" });
      const content = g.result?.content ?? "";
      const ok = content === newSoul;
      record(12, "agents.files.set(zaudit1,SOUL.md)", ok, ok ? `content changed -> "${content}" (verified)` : `re-get="${content}" (mismatch)`);
    }
  } catch (e) {
    record(12, "agents.files.set(zaudit1,SOUL.md)", false, `EXC ${e.message}`);
  }

  // 13. agents.memory.addEntry zaudit1 -> verify via memory.entries
  try {
    const a = await call("agents.memory.addEntry", { agentId: A1, content: "fakta uji" });
    if (!a.ok) {
      record(13, "agents.memory.addEntry(zaudit1)", false, `add ${errStr(a.error)}`);
    } else {
      const e = await call("agents.memory.entries", { agentId: A1 });
      const entries = e.result?.entries || [];
      const found = entries.some((x) => (typeof x === "string" ? x : x.content) === "fakta uji");
      record(13, "agents.memory.addEntry(zaudit1)", found, `entries=${entries.length} contains "fakta uji"=${found}`);
    }
  } catch (e) {
    record(13, "agents.memory.addEntry(zaudit1)", false, `EXC ${e.message}`);
  }

  // 14. agents.skills.set zaudit1
  try {
    const r = await call("agents.skills.set", { agentId: A1, skills: ["web_search"] });
    if (r.ok) {
      record(14, "agents.skills.set(zaudit1)", true, `skills=${preview(r.result?.skills ?? r.result, 120)}`);
    } else {
      record(14, "agents.skills.set(zaudit1)", false, errStr(r.error));
    }
  } catch (e) {
    record(14, "agents.skills.set(zaudit1)", false, `EXC ${e.message}`);
  }

  // 15. agents.clone zaudit1 -> zaudit2, verify via agents.get
  try {
    const c = await call("agents.clone", { sourceId: A1, newId: A2, name: "ZAudit Clone" }, 60000);
    if (!c.ok) {
      record(15, "agents.clone(zaudit1->zaudit2)", false, `clone ${errStr(c.error)}`);
    } else {
      const g = await call("agents.get", { agentId: A2 });
      if (g.ok) {
        const a = g.result?.agent || g.result || {};
        record(15, "agents.clone(zaudit1->zaudit2)", true, `zaudit2 exists name=${a.name || a.identity?.name}`);
      } else {
        record(15, "agents.clone(zaudit1->zaudit2)", false, `clone ok but get(zaudit2) ${errStr(g.error)}`);
      }
    }
  } catch (e) {
    record(15, "agents.clone(zaudit1->zaudit2)", false, `EXC ${e.message}`);
  }

  // 16. agents.describe zaudit1 (LLM call, may be slow)
  try {
    const r = await call("agents.describe", { agentId: A1, overwrite: true }, 60000);
    if (r.ok) {
      record(16, "agents.describe(zaudit1)", true, `ok preview=${preview(r.result, 140)}`);
    } else {
      record(16, "agents.describe(zaudit1)", false, errStr(r.error));
    }
  } catch (e) {
    record(16, "agents.describe(zaudit1)", false, `EXC ${e.message}`);
  }

  // ===== 17. CLEANUP =====
  for (const id of [A1, A2]) {
    if (PROTECTED.has(id)) continue; // hard guard, should never trigger
    try {
      const r = await call("agents.delete", { agentId: id, deleteFiles: true }, 30000);
      if (r.ok) {
        record(17, `agents.delete(${id})`, true, `deleted (ok)`);
      } else {
        // not-found is acceptable if a create/clone step never succeeded
        const code = r.error?.code;
        const msg = r.error?.message || "";
        const benign = /not\s*found|tidak\s*ada|does not exist/i.test(msg);
        record(17, `agents.delete(${id})`, benign, benign ? `not present (nothing to delete): ${errStr(r.error)}` : errStr(r.error));
      }
    } catch (e) {
      record(17, `agents.delete(${id})`, false, `EXC ${e.message}`);
    }
  }

  // ===== 18. FINAL agents.list — confirm clean state =====
  try {
    const r = await call("agents.list", {});
    if (r.ok) {
      const ids = (r.result?.agents || []).map((a) => a.id);
      const leakedThrowaway = ids.filter((x) => x.startsWith("zaudit"));
      const hasDefault = ids.includes("default");
      const hasKiwi = ids.includes("kiwi");
      const clean = leakedThrowaway.length === 0;
      record(
        18,
        "agents.list(final)",
        clean,
        `ids=[${ids.join(", ")}] | zaudit residue=${leakedThrowaway.length ? leakedThrowaway.join(",") : "none"} | default=${hasDefault} kiwi=${hasKiwi}`,
      );
      return { ids, clean };
    } else {
      record(18, "agents.list(final)", false, errStr(r.error));
      return { ids: null, clean: false };
    }
  } catch (e) {
    record(18, "agents.list(final)", false, `EXC ${e.message}`);
    return { ids: null, clean: false };
  }
}

function printSummary(finalState) {
  console.log("\n================ SUMMARY TABLE ================");
  console.log("STEP | RESULT | NAME");
  console.log("-----+--------+----------------------------------");
  for (const r of rows) {
    console.log(`${String(r.step).padStart(2, " ")}   | ${r.pass ? "PASS" : "FAIL"}   | ${r.name}`);
  }
  const passes = rows.filter((r) => r.pass).length;
  const fails = rows.length - passes;
  console.log("----------------------------------------------");
  console.log(`TOTAL: ${passes} PASS / ${fails} FAIL (of ${rows.length} checks)`);

  const failed = rows.filter((r) => !r.pass);
  if (failed.length) {
    console.log("\nFAILURES (RPC name -> captured error/summary):");
    for (const r of failed) {
      console.log(`  - STEP ${r.step} ${r.name}: ${r.summary}`);
    }
  }

  console.log("\nFINAL CONTAINER STATE:");
  if (finalState?.ids) {
    console.log(`  agents = [${finalState.ids.join(", ")}]`);
    console.log(`  clean (no zaudit residue) = ${finalState.clean ? "YES" : "NO — MANUAL CLEANUP NEEDED"}`);
  } else {
    console.log("  could not read final agents.list");
  }
  console.log("==============================================");
}

ws = new WebSocket(WS_URL, { headers: { Origin: ORIGIN } });

ws.on("open", () => {
  console.log(`[ws] open ${WS_URL} (origin ${ORIGIN})`);
});

ws.on("message", (data) => {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    return;
  }
  if (msg.type === "res") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    // bridge res frame: { type:"res", id, ok, payload, error }
    p.resolve({
      ok: msg.ok !== false && !msg.error,
      result: msg.payload ?? msg.result,
      error: msg.error,
    });
    return;
  }
  // events (streaming) ignored
});

ws.on("error", (e) => {
  console.error("[ws] error:", e.message);
});

ws.on("close", (c, r) => {
  console.log("[ws] close", c, r?.toString().slice(0, 120) || "");
});

(async () => {
  try {
    await waitOpen();
    const cp = await doConnect();
    console.log(`[ws] connected ok: ${preview(cp, 160)}`);
  } catch (e) {
    console.error("FATAL: could not establish gateway connection:", e.message);
    process.exit(1);
  }
  let finalState = null;
  try {
    finalState = await runAudit();
  } catch (e) {
    console.error("FATAL during audit:", e.message);
  }
  printSummary(finalState);
  try {
    ws.close(1000, "audit done");
  } catch {}
  // give close a tick, then exit
  setTimeout(() => process.exit(0), 300);
})();
