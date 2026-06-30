/**
 * Tool-display utilities — Telegram/Discord parity for /app/chat
 *
 * Mirrors Hermes' `agent/display.py` (verified live in container at
 * `/usr/local/lib/python3.11/site-packages/agent/display.py`) so tool
 * activity in /app renders identically to how Telegram + Discord
 * channels format it:
 *
 *   💻 Terminal: "hermes config show stt"
 *   🔎 Cari file: "stt"
 *   📖 Buka file: "/usr/local/lib/python3.11/site-packag..."
 *   🔊 Suara: "Bisa banget, Chief! Gue udah dicoloki..."
 *   🔀 Lemparkan tugas: "Search for supported STT..."
 *
 * Three exports:
 *   - `getToolEmoji(name)` — emoji per tool, default ⚙️
 *   - `getToolLabel(name)` — Bahasa Indonesia friendly display name
 *   - `buildToolPreview(name, input)` — single-line truncated preview of
 *     the tool's PRIMARY argument (mirrors `build_tool_preview` in
 *     Python; primary-arg map verified line-by-line against Hermes
 *     0.14.0 source, see `tools/*.py` registry.register() calls and
 *     `agent/display.py:181-194` primary_args dict)
 *
 * Why duplicate the maps in TypeScript instead of fetching from bridge:
 *   - Zero-latency render (no async lookup per tool call)
 *   - Survives bridge restart / Hermes upgrade as long as tool names
 *     don't change drastically
 *   - Skin overrides (Hermes' tool_emojis dict) aren't exposed on the
 *     wire — we don't lose anything by hardcoding the canonical set
 *
 * Maintenance:
 *   - When Hermes adds a tool, add its name+emoji+label here too.
 *   - Unknown tools render with ⚙️ + title-cased English name as
 *     fallback so the UI degrades gracefully.
 */

// Emoji per tool name — extracted verbatim from each `tools/*.py`
// file's `registry.register(name=..., emoji=...)` call. Source of truth
// is Hermes 0.14.0; verified via `grep -rE 'emoji="' /usr/local/lib/python3.11/site-packages/tools/`.
export const TOOL_EMOJI: Record<string, string> = {
  // File tools (tools/file_tools.py)
  read_file: "📖",
  write_file: "✍️",
  patch: "🔧",
  search_files: "🔎",

  // Terminal / code (tools/terminal_tool.py, code_execution_tool.py)
  terminal: "💻",
  execute_code: "🐍",
  process: "⚙️",

  // AgentBuff POS — MCP tools (hackathon demo): brand the native MCP tool row so
  // the climax reads "Laporan POS UMKM" not the raw "Mcp  Agentbuff-Pos  Generate Report".
  "mcp__agentbuff-pos__generate_report": "🧾",

  // Web / browser (tools/web_tools.py, browser_tool.py, browser_cdp_tool.py)
  web_search: "🔍",
  web_extract: "📄",
  browser_navigate: "🌐",
  browser_click: "👆",
  browser_type: "⌨️",
  browser_screenshot: "📸",
  browser_dialog: "💬",
  browser_back: "◀️",
  browser_keyboard: "⌨️",
  browser_pdf: "📜",
  browser_image: "🖼️",
  browser_console: "👁️",
  browser_desktop: "🖥️",
  browser_cdp: "🧪",

  // Media / TTS / vision (tools/tts_tool.py, vision_tools.py, image_generation_tool.py)
  text_to_speech: "🔊",
  vision_analyze: "👁️",
  video_extract: "🎬",
  image_generate: "🎨",
  video_generate: "🎬",

  // Skills + delegation (tools/skills_tool.py, delegate_tool.py, skill_manager_tool.py)
  skill_view: "📚",
  skills_list: "📚",
  skill_create: "📝",
  skill_manage: "📝",
  delegate_task: "🔀",
  mixture_of_agents: "🧠",

  // Memory / clarify / todo / search
  memory: "🧠",
  clarify: "❓",
  todo: "📋",
  session_search: "🔍",

  // Messaging tools (tools/send_message_tool.py)
  send_message: "📨",
  send_image: "🖼️",
  send_voice: "🔊",
  send_video: "🎬",
  send_document: "📄",

  // Cron / scheduler (tools/cronjob_tools.py)
  cronjob: "⏰",

  // Home automation (tools/homeassistant_tool.py)
  home_assistant: "🏠",
  homeassistant: "🏠",

  // Kanban (tools/kanban_tools.py)
  kanban_list: "📋",
  kanban_view: "📋",
  kanban_done: "✔",
  kanban_pause: "⏸",
  kanban_pulse: "💓",
  kanban_comment: "💬",
  kanban_add: "➕",
  kanban_start: "▶",
  kanban_link: "🔗",

  // X / Twitter search
  x_search: "🐦",

  // Yuanbao (Chinese chat assistant — kept for completeness)
  yuanbao_share: "👥",
  yuanbao_doc: "📋",
  yuanbao_email: "✉️",
  yuanbao_search: "🔍",
  yuanbao_canvas: "🎨",

  // Feishu (Lark) docs
  feishu_doc: "📄",
  feishu_drive_list: "💬",
  feishu_drive_share: "✉️",
};

// Bahasa Indonesia friendly display labels. Chosen for mass-market
// non-developer Indonesian users (AgentBuff B2C target market per
// CLAUDE.md §2.5). Falls back to title-case English for unknown tools.
export const TOOL_LABEL_ID: Record<string, string> = {
  // File
  read_file: "Buka file",
  write_file: "Tulis file",
  patch: "Patch file",
  search_files: "Cari file",

  // Terminal / code
  terminal: "Terminal",
  execute_code: "Jalankan kode",
  process: "Proses",

  // AgentBuff POS — MCP tools (hackathon demo)
  "mcp__agentbuff-pos__generate_report": "Laporan POS UMKM",

  // Web / browser
  web_search: "Cari di web",
  web_extract: "Ambil halaman",
  browser_navigate: "Buka URL",
  browser_click: "Klik elemen",
  browser_type: "Ketik di browser",
  browser_screenshot: "Tangkap layar",
  browser_dialog: "Dialog browser",
  browser_back: "Mundur",
  browser_pdf: "Buka PDF",
  browser_image: "Lihat gambar",
  browser_console: "Konsol browser",
  browser_desktop: "Tampilan desktop",
  browser_cdp: "Browser CDP",

  // Media
  text_to_speech: "Suara",
  vision_analyze: "Analisa gambar",
  video_extract: "Ekstrak video",
  image_generate: "Bikin gambar",
  video_generate: "Bikin video",

  // Skills + delegation
  skill_view: "Lihat skill",
  skills_list: "Daftar skill",
  skill_create: "Bikin skill",
  skill_manage: "Atur skill",
  delegate_task: "Lemparkan tugas",
  mixture_of_agents: "Diskusi multi-agent",

  // Memory / clarify / todo / search
  memory: "Memori",
  clarify: "Klarifikasi",
  todo: "Catatan tugas",
  session_search: "Cari riwayat",

  // Messaging
  send_message: "Kirim pesan",
  send_image: "Kirim gambar",
  send_voice: "Kirim suara",
  send_video: "Kirim video",
  send_document: "Kirim dokumen",

  // Cron
  cronjob: "Jadwal",

  // Home Assistant
  home_assistant: "Smart home",
  homeassistant: "Smart home",

  // Kanban
  kanban_list: "Lihat kanban",
  kanban_view: "Detail kanban",
  kanban_done: "Tandai selesai",
  kanban_pause: "Pause kanban",
  kanban_pulse: "Update kanban",
  kanban_comment: "Komentar kanban",
  kanban_add: "Tambah kanban",
  kanban_start: "Mulai kanban",
  kanban_link: "Tautan kanban",

  // X / Twitter
  x_search: "Cari di X",

  // Feishu
  feishu_doc: "Feishu doc",
  feishu_drive_list: "Feishu drive",
  feishu_drive_share: "Bagikan feishu",
};

// English friendly labels — used when the UI locale is "en" (international demo /
// English-speaking users). Mirrors TOOL_LABEL_ID 1:1.
export const TOOL_LABEL_EN: Record<string, string> = {
  read_file: "Open file",
  write_file: "Write file",
  patch: "Patch file",
  search_files: "Search files",
  terminal: "Terminal",
  execute_code: "Run code",
  process: "Process",
  "mcp__agentbuff-pos__generate_report": "POS UMKM Report",
  web_search: "Web search",
  web_extract: "Fetch page",
  browser_navigate: "Open URL",
  browser_click: "Click element",
  browser_type: "Type in browser",
  browser_screenshot: "Screenshot",
  browser_dialog: "Browser dialog",
  browser_back: "Back",
  browser_pdf: "Open PDF",
  browser_image: "View image",
  browser_console: "Browser console",
  browser_desktop: "Desktop view",
  browser_cdp: "Browser CDP",
  text_to_speech: "Voice",
  vision_analyze: "Analyze image",
  video_extract: "Extract video",
  image_generate: "Generate image",
  video_generate: "Generate video",
  skill_view: "View skill",
  skills_list: "List skills",
  skill_create: "Create skill",
  skill_manage: "Manage skill",
  delegate_task: "Delegate task",
  mixture_of_agents: "Multi-agent discussion",
  memory: "Memory",
  clarify: "Clarify",
  todo: "Task notes",
  session_search: "Search history",
  send_message: "Send message",
  send_image: "Send image",
  send_voice: "Send voice",
  send_video: "Send video",
  send_document: "Send document",
  cronjob: "Schedule",
  home_assistant: "Smart home",
  homeassistant: "Smart home",
  kanban_list: "View kanban",
  kanban_view: "Kanban detail",
  kanban_done: "Mark done",
  kanban_pause: "Pause kanban",
  kanban_pulse: "Update kanban",
  kanban_comment: "Kanban comment",
  kanban_add: "Add kanban",
  kanban_start: "Start kanban",
  kanban_link: "Kanban link",
  x_search: "Search X",
  feishu_doc: "Feishu doc",
  feishu_drive_list: "Feishu drive",
  feishu_drive_share: "Share feishu",
};

// Locale for tool labels — synced from the i18n provider (same idiom as
// session-utils' setSessionUtilsLocale), since this module can't call hooks.
let toolLabelLocale: "id" | "en" = "id";
export function setToolDisplayLocale(locale: "id" | "en"): void {
  toolLabelLocale = locale === "en" ? "en" : "id";
}

// Primary-arg map — mirrors `agent/display.py:181-194` primary_args dict.
// For each tool, this is the input key whose value gets shown as the
// preview snippet on the compact row. Verified line-by-line.
export const TOOL_PRIMARY_ARG: Record<string, string> = {
  terminal: "command",
  web_search: "query",
  web_extract: "urls",
  read_file: "path",
  write_file: "path",
  patch: "path",
  search_files: "pattern",
  browser_navigate: "url",
  browser_click: "ref",
  browser_type: "text",
  image_generate: "prompt",
  video_generate: "prompt",
  text_to_speech: "text",
  vision_analyze: "question",
  mixture_of_agents: "user_prompt",
  skill_view: "name",
  skills_list: "category",
  cronjob: "action",
  execute_code: "code",
  delegate_task: "goal",
  clarify: "question",
  skill_manage: "name",
  skill_create: "name",
  session_search: "query",
  send_message: "message",
  send_image: "caption",
  send_voice: "caption",
  send_video: "caption",
  send_document: "caption",
};

// Fallback chain — mirrors `agent/display.py:248` fallback iteration.
const FALLBACK_KEYS = [
  "query",
  "text",
  "command",
  "path",
  "name",
  "prompt",
  "code",
  "goal",
  "question",
  "url",
  "message",
];

/** Default emoji when tool name not in TOOL_EMOJI map. Matches Hermes'
 *  fallback in `tools/process_registry.py` (⚙️). */
const DEFAULT_EMOJI = "⚙️";

/** Returns the registered emoji for a tool, or the generic ⚙️ fallback. */
export function getToolEmoji(name: string): string {
  if (!name) return DEFAULT_EMOJI;
  return TOOL_EMOJI[name] ?? DEFAULT_EMOJI;
}

/** Returns the Bahasa Indonesia friendly label for a tool.
 *  Unknown tools degrade to a title-cased version of their snake_case
 *  English name (e.g. `weird_new_tool` → "Weird New Tool") so the UI
 *  never shows an empty label. */
export function getToolLabel(name: string): string {
  if (!name) return "Tool";
  const map = toolLabelLocale === "en" ? TOOL_LABEL_EN : TOOL_LABEL_ID;
  const known = map[name];
  if (known) return known;
  return titleCase(name.replace(/_/g, " "));
}

/** Build a single-line preview of a tool call's primary argument, ≤40
 *  chars by default. Mirrors `build_tool_preview` in Hermes Python:
 *    - Looks up the primary arg key per tool (e.g. `terminal` → `command`)
 *    - Falls back to first-match on generic keys
 *    - Collapses whitespace + truncates with "..."
 *    - Some tools have custom formatting (memory, todo, send_message)
 *      replicated here for fidelity with Telegram channel rendering. */
export function buildToolPreview(
  name: string,
  input: Record<string, unknown> | undefined | null,
  maxLen = 40,
): string {
  if (!input || typeof input !== "object") return "";

  // ── Custom formatters mirroring agent/display.py:196-241 ────────────
  // These produce richer previews than a single primary-arg extraction.

  if (name === "process") {
    const action = strOf(input.action);
    const sid = strOf(input.session_id);
    const data = strOf(input.data);
    const timeoutVal = input.timeout;
    const parts: string[] = [];
    if (action) parts.push(action);
    if (sid) parts.push(sid.slice(0, 16));
    if (data) parts.push(`"${oneline(data.slice(0, 20))}"`);
    if (timeoutVal && action === "wait") parts.push(`${timeoutVal}s`);
    return truncate(parts.join(" "), maxLen);
  }

  if (name === "todo") {
    const todosArg = input.todos;
    const merge = input.merge === true;
    if (todosArg === undefined || todosArg === null) {
      return "baca daftar tugas";
    }
    if (Array.isArray(todosArg)) {
      return merge
        ? `update ${todosArg.length} tugas`
        : `rencana ${todosArg.length} tugas`;
    }
    return "";
  }

  if (name === "session_search") {
    const q = oneline(strOf(input.query));
    const head = q.slice(0, 25);
    const ellipsis = q.length > 25 ? "..." : "";
    return truncate(`recall: "${head}${ellipsis}"`, maxLen);
  }

  if (name === "memory") {
    const action = strOf(input.action);
    const target = strOf(input.target);
    if (action === "add") {
      const content = oneline(strOf(input.content));
      const head = content.slice(0, 25);
      const ellipsis = content.length > 25 ? "..." : "";
      return truncate(`+${target}: "${head}${ellipsis}"`, maxLen);
    }
    if (action === "replace") {
      const old = oneline(strOf(input.old_text)) || "<missing old_text>";
      return truncate(`~${target}: "${old.slice(0, 20)}"`, maxLen);
    }
    if (action === "remove") {
      const old = oneline(strOf(input.old_text)) || "<missing old_text>";
      return truncate(`-${target}: "${old.slice(0, 20)}"`, maxLen);
    }
    return truncate(action, maxLen);
  }

  if (name === "send_message") {
    const target = strOf(input.target) || "?";
    const msg = oneline(strOf(input.message));
    const head = msg.length > 20 ? msg.slice(0, 17) + "..." : msg;
    return truncate(`to ${target}: "${head}"`, maxLen);
  }

  // ── Primary arg + fallback chain ─────────────────────────────────────
  const primaryKey = TOOL_PRIMARY_ARG[name];
  const candidates = primaryKey ? [primaryKey, ...FALLBACK_KEYS] : FALLBACK_KEYS;
  let value: unknown;
  for (const key of candidates) {
    const v = (input as Record<string, unknown>)[key];
    if (v !== undefined && v !== null && v !== "") {
      value = v;
      break;
    }
  }
  if (value === undefined) return "";

  // Lists → take first element (mirrors Python `value = value[0] if value else ""`)
  if (Array.isArray(value)) {
    value = value.length > 0 ? value[0] : "";
  }

  const preview = oneline(strOf(value));
  if (!preview) return "";
  return truncate(preview, maxLen);
}

// ── helpers ──────────────────────────────────────────────────────────────
function strOf(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function oneline(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function truncate(s: string, maxLen: number): string {
  if (!s) return "";
  if (maxLen <= 0 || s.length <= maxLen) return s;
  if (maxLen <= 3) return s.slice(0, maxLen);
  return s.slice(0, maxLen - 3) + "...";
}

function titleCase(s: string): string {
  return s.replace(
    /\w\S*/g,
    (t) => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase(),
  );
}
