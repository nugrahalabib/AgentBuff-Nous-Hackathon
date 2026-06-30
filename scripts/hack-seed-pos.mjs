// HACKATHON — rebuild the POS demo dataset against the running POS backend (7704).
// Idempotent + reusable: safe to re-run. Creates (or reuses) the demo tenant
// `chief@buffpos.demo / buffpos123`, seeds a small F&B catalog, and writes 7 PAID
// transactions that sum to exactly Rp 255.000 with "Es Teh Manis" as the top seller
// (matches DEMO-SCENARIO.md: Omzet Rp 255.000 · 7 transaksi · rata-rata Rp 36.429 ·
// terlaris Es Teh). Then it issues a fresh MCP connection token for that tenant.
//
// Why this exists: POS sales live in the POS PGlite DB (not the portal). When that
// DB was reset, the demo sales + MCP token were lost. This rebuilds them through the
// real HTTP API (no DB lock fight) so the agent's `generate_report` returns real data.
//
// Output (last line): RESULT_JSON={ tenantId, mcpToken, mcpUrl, omzet, count }
// Run: node scripts/hack-seed-pos.mjs

const BASE = process.env.POS_BACKEND_URL ?? "http://localhost:7704";
const EMAIL = "chief@buffpos.demo";
const PASSWORD = "buffpos123";

// host.docker.internal so the in-container agent can reach the host POS backend.
const mcpUrlFor = (tenantId) => `http://host.docker.internal:7704/mcp/${tenantId}`;

async function api(path, { method = "GET", token, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = text ? JSON.parse(text) : {}; } catch { json = { _raw: text }; }
  if (!res.ok) {
    const msg = json?.error || json?._raw || `HTTP ${res.status}`;
    const err = new Error(`${method} ${path} -> ${res.status}: ${msg}`);
    err.status = res.status;
    err.json = json;
    throw err;
  }
  return json;
}

// Catalog: name -> price (Rp). Mirrors the F&B template so the POS app looks real.
const CATALOG = [
  { name: "Es Teh Manis", price: 6000, color: "#B45309" },
  { name: "Kopi Susu Gula Aren", price: 18000, color: "#C2410C" },
  { name: "Americano", price: 16000, color: "#7C2D12" },
  { name: "Nasi Ayam", price: 22000, color: "#15803D" },
  { name: "Roti Bakar Coklat", price: 15000, color: "#92400E" },
  { name: "Lemon Tea", price: 12000, color: "#CA8A04" },
];

// 7 carts → exactly Rp 255.000, Es Teh Manis dominant (qty 22 vs others <= 2).
const CARTS = [
  [["Es Teh Manis", 4], ["Kopi Susu Gula Aren", 1]], // 42.000
  [["Es Teh Manis", 3], ["Nasi Ayam", 1]],           // 40.000
  [["Es Teh Manis", 2], ["Americano", 1]],           // 28.000
  [["Es Teh Manis", 5], ["Roti Bakar Coklat", 1]],   // 45.000
  [["Es Teh Manis", 3], ["Lemon Tea", 1]],           // 30.000
  [["Es Teh Manis", 2], ["Kopi Susu Gula Aren", 1]], // 30.000
  [["Es Teh Manis", 3], ["Nasi Ayam", 1]],           // 40.000
];

async function main() {
  // 1) Auth — register the demo tenant, or log in if it already exists.
  let auth;
  try {
    auth = await api("/api/auth/register", {
      method: "POST",
      body: {
        ownerName: "Chief BuffPOS",
        email: EMAIL,
        password: PASSWORD,
        shopName: "Warung Kopi Chief",
        businessType: "fnb",
        outletName: "Outlet Utama",
      },
    });
    console.log("registered tenant", auth.tenant.id);
  } catch (e) {
    if (e.status === 409) {
      auth = await api("/api/auth/login", { method: "POST", body: { email: EMAIL, password: PASSWORD } });
      console.log("logged into existing tenant", auth.tenant.id);
    } else {
      throw e;
    }
  }
  const token = auth.token;
  const tenantId = auth.tenant.id;

  // 2) No tax/service → total == subtotal (predictable, exact Rp 255.000).
  await api("/api/settings", { method: "PATCH", token, body: { taxEnabled: false, serviceEnabled: false, roundTo: 1 } });

  // 3) Catalog — create missing products (idempotent by name).
  const existing = await api("/api/catalog", { token });
  const byName = new Map((existing.products ?? []).map((p) => [p.name, p]));
  for (const item of CATALOG) {
    if (byName.has(item.name)) continue;
    const created = await api("/api/products", {
      method: "POST",
      token,
      body: { name: item.name, price: item.price, color: item.color },
    });
    byName.set(item.name, created);
    console.log("created product", item.name, created.id);
  }

  const priceOf = (name) => CATALOG.find((c) => c.name === name).price;
  const idOf = (name) => byName.get(name).id;

  // 4) 7 PAID transactions (idempotent by idempotencyKey seed-chief-N).
  let computedTotal = 0;
  for (let i = 0; i < CARTS.length; i++) {
    const cart = CARTS[i];
    const lines = cart.map(([name, qty], j) => ({
      lineId: `seed-${i}-${j}`,
      productId: idOf(name),
      name,
      unitPrice: priceOf(name),
      qty,
      modifiers: [],
    }));
    const total = lines.reduce((s, l) => s + l.unitPrice * l.qty, 0);
    computedTotal += total;
    const r = await api("/api/checkout", {
      method: "POST",
      token,
      body: {
        idempotencyKey: `seed-chief-${i}`,
        channel: "cashier",
        lines,
        payments: [
          { id: "", methodId: "cash", methodName: "Tunai", class: "recorded", amount: total, status: "SUCCEEDED" },
        ],
      },
    });
    if (r.totals?.total !== total) {
      console.warn(`  WARN txn ${i}: server total ${r.totals?.total} != expected ${total}`);
    }
    console.log(`  txn ${i}: Rp ${total.toLocaleString("id-ID")} ${r.reused ? "(reused)" : "(new)"}`);
  }

  // 5) Verify report.
  const rep = await api("/api/reports/summary?period=day", { token });
  console.log(`report: omzet=${rep.omzet} count=${rep.count} top=${JSON.stringify(rep.topProducts?.slice?.(0, 1) ?? rep.topProducts)}`);

  // 6) Issue a fresh MCP connection token for the agent.
  const conn = await api("/api/agent/connections", {
    method: "POST",
    token,
    body: { label: "AgentBuff Demo Agent (Nemotron)" },
  });

  const result = {
    tenantId,
    mcpToken: conn.token,
    mcpUrl: mcpUrlFor(tenantId),
    omzet: rep.omzet,
    count: rep.count,
    expectedTotal: computedTotal,
  };
  console.log("RESULT_JSON=" + JSON.stringify(result));
}

main().catch((e) => {
  console.error("SEED FAILED:", e.message);
  if (e.json) console.error(JSON.stringify(e.json));
  process.exit(1);
});
