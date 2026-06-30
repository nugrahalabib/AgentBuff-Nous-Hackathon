"use client";

/**
 * Local-execute slash commands — intercepted in the composer BEFORE the
 * message goes to the agent. Ported from Hermes Desktop's
 * `useLocalCommands.ts` to keep functional parity with the engine the
 * Telegram bot + Hermes Desktop already serve.
 *
 * Two execution paths in our store (`tryLocalCommand`):
 *   - LOCAL — returns a `LocalCommandResult` with markdown content + an
 *     optional `sideEffect` callback that the store invokes BEFORE
 *     appending the response bubble. Side effects can mutate state
 *     (create a new session, clear transcript, toggle a config flag).
 *   - PASS-THROUGH — returns `null`, signalling the composer to proceed
 *     with the normal `chat.send` path so the agent backend handles it.
 *
 * Per-command implementations live below. Each one mirrors how Hermes
 * Desktop's `useLocalCommands.ts` handles it (line refs annotated) — the
 * goal is "what you can do in the Telegram bot + Hermes Desktop, you can
 * do here too".
 */

import type { GatewayClient } from "@/lib/hermes/browser-gateway";
import { agentIdFromSessionKey } from "@/lib/app/session-utils";

/** Optional callback the store runs BEFORE appending the response bubble.
 *  Used by commands that need to mutate session state (new/clear/fast). */
export type LocalCommandSideEffect = () => Promise<void> | void;

export type LocalCommandResult = {
  /** Markdown content rendered as an agent bubble. Pass empty string to
   *  suppress the bubble entirely (e.g. /new + /clear should reset the
   *  transcript without injecting a "you ran /new" message). */
  content: string;
  /** Optional callback invoked by the store before appending the bubble.
   *  Errors thrown here are caught and surfaced inline as part of the
   *  response. */
  sideEffect?: LocalCommandSideEffect;
};

export type LocalCommandHandler = (
  args: string,
  ctx: LocalCommandContext,
) => Promise<LocalCommandResult> | LocalCommandResult;

export interface LocalCommandContext {
  client: GatewayClient;
  sessionKey: string;
  /** Live actions the store exposes for sideEffects to call. We keep the
   *  surface narrow so commands don't reach into unrelated parts of the
   *  store (and so the tryLocalCommand wiring stays simple). */
  actions: {
    createSession: () => Promise<string | null>;
    deleteSession: (key: string) => Promise<void>;
    setActiveSession: (key: string) => Promise<void>;
    /** Patch agent.service_tier — "fast" / "priority" / "". */
    setFastMode: (on: boolean) => Promise<boolean>;
    /** Read currently active session's accumulated usage from the last
     *  assistant message meta. Returns null when no turn has completed
     *  yet (empty session or pre-first-reply). */
    getLastUsage: () => {
      input: number;
      output: number;
      cost: number;
      model: string | null;
    } | null;
    /** Read current fast-mode setting from localStorage. */
    getFastMode: () => boolean;
  };
}

/** Catalog of all local-execute commands, keyed by their slash name. */
export const LOCAL_COMMANDS: Record<string, LocalCommandHandler> = {
  // ── Chat control ──
  "/new": handleNew,
  "/clear": handleClear,
  // ── Info / lookup ──
  "/help": handleHelp,
  "/version": handleVersion,
  "/model": handleModel,
  "/memory": handleMemory,
  "/tools": handleTools,
  "/skills": handleSkills,
  "/persona": handlePersona,
  "/usage": handleUsage,
  // ── Agent ──
  "/fast": handleFast,
};

/** Parse a raw composer text into `(commandName, args)` if it starts with
 *  a registered local-command keyword. Returns `null` otherwise. */
export function matchLocalCommand(
  rawText: string,
): { name: string; args: string } | null {
  const trimmed = rawText.trim();
  if (!trimmed.startsWith("/")) return null;
  const spaceIdx = trimmed.search(/\s/);
  const name = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
  const args = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1);
  if (!(name in LOCAL_COMMANDS)) return null;
  return { name, args };
}

export async function dispatchLocalCommand(
  rawText: string,
  ctx: LocalCommandContext,
): Promise<LocalCommandResult | null> {
  const matched = matchLocalCommand(rawText);
  if (!matched) return null;
  const handler = LOCAL_COMMANDS[matched.name];
  if (!handler) return null;
  try {
    return await Promise.resolve(handler(matched.args, ctx));
  } catch (err) {
    return {
      content:
        `**${matched.name}** gagal: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ════════════════════════════════════════════════════════════════
//  CHAT CONTROL
// ════════════════════════════════════════════════════════════════

/** `/new` — start a fresh session. Mirrors Hermes Desktop's `onNewChat`
 *  in `useLocalCommands.ts:54-56`. */
function handleNew(_args: string, ctx: LocalCommandContext): LocalCommandResult {
  return {
    // Empty content — Hermes Desktop's /new + /clear don't push any
    // message (intentional: "you start fresh, no clutter").
    content: "",
    sideEffect: async () => {
      await ctx.actions.createSession();
    },
  };
}

/** `/clear` — wipe the active session's transcript by deleting + creating
 *  a fresh one. Mirrors Hermes Desktop's `onClear` flow which calls
 *  deleteSession + clears local state. */
function handleClear(
  _args: string,
  ctx: LocalCommandContext,
): LocalCommandResult {
  return {
    content: "",
    sideEffect: async () => {
      const oldKey = ctx.sessionKey;
      // Spin a fresh session first so we don't land on a "no active
      // session" gap state where the composer disables itself.
      await ctx.actions.createSession();
      // Now safe to drop the old session.
      if (oldKey) {
        try {
          await ctx.actions.deleteSession(oldKey);
        } catch {
          /* best-effort — fresh session already active */
        }
      }
    },
  };
}

// ════════════════════════════════════════════════════════════════
//  INFO / LOOKUP
// ════════════════════════════════════════════════════════════════

function handleHelp(): LocalCommandResult {
  // Categorized list of EVERY command — local + backend.
  // Mirrors Hermes Desktop `useLocalCommands.ts:171-193` which builds
  // a grouped markdown table from SLASH_COMMANDS.
  const lines: string[] = [
    "## Daftar Perintah",
    "",
    "**Chat Control** _(eksekusi langsung, tanpa token cost)_",
    "| Perintah | Fungsi |",
    "|---|---|",
    "| `/new` | Mulai sesi baru |",
    "| `/clear` | Hapus sesi aktif & mulai fresh |",
    "",
    "**Info / Lookup** _(eksekusi langsung, tanpa token cost)_",
    "| Perintah | Fungsi |",
    "|---|---|",
    "| `/help` | Daftar perintah ini |",
    "| `/version` | Versi AgentBuff + engine Hermes |",
    "| `/model` | Model + provider yang aktif |",
    "| `/memory` | Isi memory agent |",
    "| `/tools` | Daftar tool yang tersedia |",
    "| `/skills` | Skill yang sudah ke-install |",
    "| `/persona` | Persona agent (SOUL.md) |",
    "| `/usage` | Token + biaya turn terakhir |",
    "| `/fast` | Toggle Fast Mode (priority processing) |",
    "",
    "**Agent Control** _(dikirim ke agent, kena token cost)_",
    "| Perintah | Fungsi |",
    "|---|---|",
    "| `/btw <pesan>` | Tanya sampingan tanpa ngubah konteks utama |",
    "| `/approve` / `/deny` | Setujui / tolak aksi yg butuh approval (atau pakai bar inline) |",
    "| `/status` | Status agent saat ini |",
    "| `/reset` | Reset konteks conversation |",
    "| `/compact` | Compact + summarize percakapan |",
    "| `/compress <topik>` | Compress conversation dengan focus topic |",
    "| `/undo` | Undo aksi terakhir |",
    "| `/retry` | Ulangi aksi gagal |",
    "| `/debug` | Diagnostics + debug info |",
    "| `/goal <text>` | Kunci agent ke goal lintas-turn (Ralph loop) |",
    "| `/steer <text>` | Steer agent yg sedang jalan tanpa interrupt |",
    "| `/queue <text>` | Queue follow-up setelah turn ini selesai |",
    "",
    "**Tools** _(dikirim ke agent, kena token cost)_",
    "| Perintah | Fungsi |",
    "|---|---|",
    "| `/web <query>` | Cari web |",
    "| `/image <prompt>` | Generate gambar |",
    "| `/browse <url>` | Browse halaman URL |",
    "| `/code <prompt>` | Generate / eksekusi kode |",
    "| `/file <path>` | Read / write file |",
    "| `/shell <cmd>` | Jalankan shell command |",
    "",
    "**Tips**:",
    "- ↑/↓ di textarea = recall pesan sebelumnya.",
    "- Ctrl+F = pencarian dalam chat.",
    "- Right-click pesan = menu salin / pilih.",
  ];
  return { content: lines.join("\n") };
}

async function handleVersion(
  _args: string,
  ctx: LocalCommandContext,
): Promise<LocalCommandResult> {
  // Engine returns `{current, latest, hasUpdate, autoUpdate, ...}`.
  // `current` is the field we want; `latest` is the GitHub release tag
  // checked on a schedule (`intervalHours`).
  let current = "tidak diketahui";
  let latest = "";
  let hasUpdate = false;
  try {
    const res = await ctx.client.request<{
      current?: string;
      latest?: string;
      hasUpdate?: boolean;
    }>("system.engine.status", {});
    current = res?.current ?? "tidak diketahui";
    latest = res?.latest ?? "";
    hasUpdate = !!res?.hasUpdate;
  } catch {
    /* surface "tidak diketahui" */
  }
  const lines = [
    "## Versi",
    "",
    "| Komponen | Versi |",
    "|---|---|",
    "| **AgentBuff (web)** | 0.1 |",
    `| **Hermes engine** | ${current}${hasUpdate ? ` _(latest: ${latest})_` : ""} |`,
  ];
  if (hasUpdate) {
    lines.push("", `⚡ **Update tersedia**: engine \`v${latest}\` rilis. Ketik \`/update\` untuk pasang.`);
  }
  return { content: lines.join("\n") };
}

async function handleModel(
  _args: string,
  ctx: LocalCommandContext,
): Promise<LocalCommandResult> {
  // The model is PER-AGENT (AgentBuff): each agent's `model.{primary,provider}`
  // lives in its own config.yaml. The OLD impl read the GLOBAL `config.get
  // {model}` which LIES for a named agent (e.g. shows the default agent's
  // gpt-5.5 while "Manager Pribadi" actually runs gpt-5.4). Fix: resolve the
  // ACTIVE session's agent and read ITS model from agents.list.
  const agentId = agentIdFromSessionKey(ctx.sessionKey) ?? "default";
  let model: { primary?: string; default?: string; provider?: string } = {};
  let agentName = agentId;
  try {
    const res = await ctx.client.request<{ agents?: unknown }>("agents.list", {});
    const agents = Array.isArray(res?.agents) ? res.agents : [];
    const match =
      agents.find(
        (a) => (a as Record<string, unknown>)?.id === agentId,
      ) ??
      agents.find((a) => (a as Record<string, unknown>)?.id === "default");
    if (match && typeof match === "object") {
      const obj = match as Record<string, unknown>;
      if (obj.model && typeof obj.model === "object") {
        model = obj.model as typeof model;
      }
      const identity =
        obj.identity && typeof obj.identity === "object"
          ? (obj.identity as Record<string, unknown>)
          : {};
      agentName =
        (typeof identity.name === "string" && identity.name) ||
        (typeof obj.name === "string" && obj.name) ||
        agentId;
    }
  } catch {
    /* fall through to global config */
  }
  // Fallback to the global default ONLY if agents.list didn't yield a model.
  if (!model.primary && !model.default) {
    try {
      const res = await ctx.client.request<{
        value?: { model?: typeof model };
        model?: typeof model;
      }>("config.get", { path: "model" });
      model = res?.value?.model ?? res?.model ?? {};
    } catch {
      /* fall through */
    }
  }
  const modelName = model.primary || model.default || "_(belum di-set)_";
  return {
    content: [
      "## Model Aktif",
      "",
      `Agen **${agentName}** sekarang pakai:`,
      "",
      "| Field | Nilai |",
      "|---|---|",
      `| **Model** | \`${modelName}\` |`,
      `| **Provider** | ${model.provider || "_(belum di-set)_"} |`,
      "",
      "_Ganti model lewat tab Agents (per-agen)._",
    ].join("\n"),
  };
}

async function handleMemory(
  _args: string,
  ctx: LocalCommandContext,
): Promise<LocalCommandResult> {
  // Engine stores agent memory in `MEMORY.md` per agent. The
  // `agents.files.get` RPC reads any file under the agent's home; we
  // ask for the canonical MEMORY.md of the default `main` agent.
  let memContent = "";
  let userContent = "";
  try {
    const res = await ctx.client.request<{ content?: string; name?: string }>(
      "agents.files.get",
      { agentId: "main", filename: "MEMORY.md" },
    );
    memContent = (res?.content || "").trim();
  } catch {
    /* MEMORY.md might not exist — that's fine, show empty state */
  }
  try {
    const res = await ctx.client.request<{ content?: string }>(
      "agents.files.get",
      { agentId: "main", filename: "USER.md" },
    );
    userContent = (res?.content || "").trim();
  } catch {
    /* USER.md optional */
  }
  if (!memContent && !userContent) {
    return {
      content:
        "## Memory\n\n_(belum ada memory yang tersimpan)_\n\nMemory ke-update otomatis oleh agent saat kamu chat. Kamu bisa minta agent \"simpan ini ke memory\" supaya tersimpan permanen.",
    };
  }
  const lines: string[] = ["## Memory Agent"];
  if (memContent) {
    const truncated =
      memContent.length > 3000
        ? memContent.slice(0, 3000) + "\n\n…(truncated)"
        : memContent;
    lines.push("", "### MEMORY.md", "", "```md", truncated, "```");
  }
  if (userContent) {
    const truncated =
      userContent.length > 2000
        ? userContent.slice(0, 2000) + "\n\n…(truncated)"
        : userContent;
    lines.push("", "### USER.md", "", "```md", truncated, "```");
  }
  return { content: lines.join("\n") };
}

async function handleTools(
  _args: string,
  ctx: LocalCommandContext,
): Promise<LocalCommandResult> {
  // Hermes Desktop calls getToolsets() which returns engine-level toolset
  // toggles. Closest equivalent in our wire: commands.list (the slash
  // catalog) since that's what the agent will accept. Show the catalog.
  try {
    const res = await ctx.client.request<{
      pairs?: Array<[string, string]>;
    }>("commands.list", {});
    const pairs = Array.isArray(res?.pairs) ? res.pairs : [];
    if (pairs.length === 0) {
      return {
        content: "## Tools / Perintah\n\n_(catalog kosong — engine belum siap?)_",
      };
    }
    const lines: string[] = [
      "## Tools / Perintah Tersedia",
      "",
      `Total **${pairs.length}** perintah dari engine:`,
      "",
    ];
    for (const [name, desc] of pairs.slice(0, 50)) {
      lines.push(`- \`${name}\` — ${desc || "_(tanpa deskripsi)_"}`);
    }
    if (pairs.length > 50) {
      lines.push("", `_… dan ${pairs.length - 50} perintah lainnya._`);
    }
    return { content: lines.join("\n") };
  } catch {
    return { content: "## Tools\n\n_(gagal ambil daftar dari engine)_" };
  }
}

async function handleSkills(
  _args: string,
  ctx: LocalCommandContext,
): Promise<LocalCommandResult> {
  // Engine returns `{skills: {category: [skill_name1, skill_name2, ...]}}`
  // (verified via probe-rpcs). NOT an array of objects — a category-keyed
  // map of skill-name strings.
  try {
    const res = await ctx.client.request<{
      skills?: Record<string, string[]>;
    }>("skills.status", {});
    const categorized = res?.skills ?? {};
    const categoryNames = Object.keys(categorized);
    if (categoryNames.length === 0) {
      return {
        content:
          "## Skills\n\n_(belum ada skill yang ter-install)_\n\nInstall skill via tab BuffHub atau perintah engine.",
      };
    }
    let total = 0;
    for (const arr of Object.values(categorized)) total += arr.length;
    const lines: string[] = [
      "## Skills Ter-install",
      "",
      `Total: **${total}** skill di **${categoryNames.length}** kategori`,
      "",
    ];
    for (const cat of categoryNames) {
      const items = categorized[cat] ?? [];
      lines.push(`### ${cat}`);
      lines.push("");
      for (const name of items) {
        lines.push(`- \`${name}\``);
      }
      lines.push("");
    }
    return { content: lines.join("\n") };
  } catch {
    return { content: "## Skills\n\n_(gagal ambil daftar skill dari engine)_" };
  }
}

async function handlePersona(
  _args: string,
  ctx: LocalCommandContext,
): Promise<LocalCommandResult> {
  // Bridge accepts `filename` (NOT `file`) — verified via INVALID_REQUEST
  // probe. Returns `{name, content}`.
  try {
    const res = await ctx.client.request<{ name?: string; content?: string }>(
      "agents.files.get",
      { agentId: "main", filename: "SOUL.md" },
    );
    const text = (res?.content || "").trim();
    if (!text) {
      return {
        content:
          "## Persona Agent\n\n_(belum ada persona — agent pakai default)_",
      };
    }
    const truncated =
      text.length > 4000 ? text.slice(0, 4000) + "\n\n…(truncated)" : text;
    return {
      content: `## Persona Agent (SOUL.md)\n\n\`\`\`md\n${truncated}\n\`\`\``,
    };
  } catch {
    return { content: "## Persona\n\n_(gagal baca persona dari engine)_" };
  }
}

function handleUsage(
  _args: string,
  ctx: LocalCommandContext,
): LocalCommandResult {
  // Read REAL usage from store via the actions API. Hermes Desktop pulls
  // from `usageRef.current` accumulated by useChatIPC's onChatUsage event.
  // Our equivalent is `meta` on the latest assistant message — same data,
  // just stored in the store rather than a hook ref.
  const usage = ctx.actions.getLastUsage();
  if (!usage) {
    return {
      content:
        "## Token Usage\n\n_(belum ada turn yang selesai — usage akan muncul setelah agent balas)_",
    };
  }
  const total = usage.input + usage.output;
  const lines: string[] = [
    "## Token Usage (Turn Terakhir)",
    "",
    "| Field | Nilai |",
    "|---|---|",
    `| **Prompt (input)** | ${usage.input.toLocaleString("id-ID")} tokens |`,
    `| **Completion (output)** | ${usage.output.toLocaleString("id-ID")} tokens |`,
    `| **Total** | ${total.toLocaleString("id-ID")} tokens |`,
  ];
  if (usage.cost > 0) {
    lines.push(`| **Biaya** | $${usage.cost.toFixed(4)} |`);
  }
  if (usage.model) {
    lines.push(`| **Model** | \`${usage.model}\` |`);
  }
  return { content: lines.join("\n") };
}

// ════════════════════════════════════════════════════════════════
//  AGENT CONTROL (Local-execute)
// ════════════════════════════════════════════════════════════════

/** `/fast` — toggle Fast Mode. Same wire path as the header ⚡ button
 *  (writes `agent.service_tier` via `config.patch`). Mirrors Hermes
 *  Desktop's `useLocalCommands.ts:138-152`. */
function handleFast(
  _args: string,
  ctx: LocalCommandContext,
): LocalCommandResult {
  // Read current state, flip, write back via patchSession action.
  const current = ctx.actions.getFastMode();
  const next = !current;
  return {
    content: next
      ? "## Fast Mode: **ON** ⚡\n\nProvider akan memprioritaskan request kamu (paid tier). Cocok untuk turn-turn penting yang gak boleh lambat."
      : "## Fast Mode: **OFF**\n\nProcessing kembali ke tier normal (standar).",
    sideEffect: async () => {
      // Write to localStorage so header toggle stays in sync.
      if (typeof window !== "undefined") {
        try {
          window.localStorage.setItem(
            "agentbuff:app:fast-mode",
            next ? "1" : "0",
          );
        } catch {
          /* quota — best-effort */
        }
      }
      await ctx.actions.setFastMode(next);
    },
  };
}

// ════════════════════════════════════════════════════════════════
//  Helpers
// ════════════════════════════════════════════════════════════════

function extractVersionFromText(text: string): string | null {
  const m = text.match(/(?:v(?:ersion)?[\s:]*)([0-9]+\.[0-9]+(?:\.[0-9]+)?[a-z0-9.-]*)/i);
  return m ? m[1] : null;
}
