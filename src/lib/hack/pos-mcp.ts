// HACKATHON-only: connect the user's in-container agent to the AgentBuff POS MCP
// server when they buy the "Kasir POS UMKM" skill from BuffHub. This is what makes
// the demo's purchase ACTUALLY unlock the real POS — after buying, the agent can
// operate the POS via MCP (generate_report, suggest_price_change, etc.).
//
// The POS MCP URL + a real OAuth-issued token live in env (gitignored). The connect
// runs `hermes mcp add` inside the container (idempotent) over loopback.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const POS_MCP_URL = process.env.POS_MCP_URL ?? "";
const POS_MCP_TOKEN = process.env.POS_MCP_TOKEN ?? "";

/** Connect the container agent to the POS MCP server (idempotent, best-effort). */
export async function connectPosMcp(containerName: string): Promise<{ ok: boolean; status: string }> {
  if (!POS_MCP_URL || !POS_MCP_TOKEN || !containerName) {
    return { ok: false, status: "POS_MCP not configured" };
  }
  // Idempotent: skip if already connected, else `hermes mcp add` (interactive →
  // pipe auth=Y + token + enable-all=Y). Token/URL are alnum + /:._- so safe inline.
  const inner =
    `if hermes mcp list 2>/dev/null | grep -q agentbuff-pos; then echo ALREADY_CONNECTED; ` +
    `else printf 'Y\\n%s\\nY\\n' '${POS_MCP_TOKEN}' | ` +
    `hermes mcp add agentbuff-pos --url '${POS_MCP_URL}' --auth header >/dev/null 2>&1 ` +
    `&& echo CONNECTED || echo CONNECT_FAILED; fi`;
  try {
    const { stdout } = await exec(
      "docker",
      ["exec", "-u", "hermes", containerName, "bash", "-lc", inner],
      { timeout: 60000 },
    );
    const s = stdout.trim();
    const ok = s.includes("CONNECTED") || s.includes("ALREADY");
    return { ok, status: s.includes("ALREADY") ? "ALREADY_CONNECTED" : ok ? "CONNECTED" : "unknown" };
  } catch (e) {
    // execFile rejects on non-zero exit even when the marker echoed (login-shell
    // quirks); trust stdout if it shows success. NEVER surface the raw error
    // message — it embeds the full command including the token.
    const out = ((e as { stdout?: string }).stdout ?? "").trim();
    if (out.includes("ALREADY")) return { ok: true, status: "ALREADY_CONNECTED" };
    if (out.includes("CONNECTED")) return { ok: true, status: "CONNECTED" };
    return { ok: false, status: "connect_error" };
  }
}

/** Disconnect (used by the demo reset so a fresh recording starts POS-locked). */
export async function disconnectPosMcp(containerName: string): Promise<void> {
  if (!containerName) return;
  try {
    await exec(
      "docker",
      ["exec", "-u", "hermes", containerName, "bash", "-lc", "hermes mcp remove agentbuff-pos >/dev/null 2>&1 || true"],
      { timeout: 30000 },
    );
  } catch {
    /* non-fatal */
  }
}
