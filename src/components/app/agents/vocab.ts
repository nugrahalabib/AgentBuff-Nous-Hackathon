/**
 * vocab.ts — Mass-market Bahasa translation map for technical names.
 *
 * Single source of truth for converting Hermes engine internal names
 * (English, lowercase, snake_case, may be prefixed `hermes-` or
 * `agentbuff-` after brand-scrub) → user-friendly Bahasa Indonesia
 * mass-market labels with emoji + functional description.
 *
 * Used everywhere tools/skills/plugins/MCP show up in /app/agents.
 *
 * Naming conventions:
 *   - `label`      → 1-3 word friendly label ("Cari di Internet")
 *   - `description`→ 1 sentence what it does in plain Bahasa
 *   - `icon`       → single emoji
 *   - `category`   → "produktivitas" | "kreatif" | "komunikasi" | etc.
 *   - `bucket`     → high-level grouping shown in UI
 *                    ("data" | "kreatif" | "komunikasi" | "agen-tools" | "developer" | "lain")
 *
 * Lookup strategy (translateToolset):
 *   1. Strip generic prefixes (mcp:, plugin:, channel:)
 *   2. Strip brand prefixes (hermes-, agentbuff-, hermes_, agentbuff_)
 *   3. Lookup by bare name (so ONE entry "acp" covers both
 *      `hermes-acp` and `agentbuff-acp`)
 *   4. Fall back to raw lookup, then to keyword-based humanizer
 */

import skillMetaRaw from "./skill-meta-data.json";

export type CapabilityCategory =
  | "produktivitas"
  | "kreatif"
  | "komunikasi"
  | "agen-tools"
  | "developer"
  | "riset"
  | "otomasi"
  | "data"
  | "lain";

export type CapabilityBucket =
  | "data"
  | "kreatif"
  | "komunikasi"
  | "agen-tools"
  | "developer"
  | "lain";

export type VocabEntry = {
  label: string;
  description: string;
  icon: string;
  category: CapabilityCategory;
  bucket: CapabilityBucket;
  requires?: Requirement[];
};

/**
 * SetupGuide — step-by-step instructions surfaced in the requirements
 * modal when the user clicks "Cara setup". Each step is a short title +
 * body. `chatPrompt` is a ready-to-paste prompt the user can send the
 * AGENT to do the work via natural-language conversation. `docsUrl`
 * links to official provider docs. `getApiKeyUrl` deep-links to the
 * exact "create API key" page when the provider has one.
 */
export type SetupGuide = {
  /** 2-5 sentences in Bahasa explaining WHAT and WHY upfront. */
  intro?: string;
  /** Ordered list of concrete setup steps. */
  steps: Array<{
    title: string;
    body: string;
  }>;
  /** Where the user does the setup ("dashboard" tab vs CLI vs external) */
  placement:
    | "tab-saluran" // Bind via Saluran tab in /app
    | "tab-plugin-mcp" // Install via Plugin & Connector tab in /app
    | "tab-pengaturan-model" // Set in Pengaturan → Model
    | "tab-pengaturan-env" // Set in Pengaturan → Env (future)
    | "chat-agent" // Just paste the prompt to the agent and they handle it
    | "external"; // Manual sysadmin work (Mac/signal-cli/HA)
  /** Optional natural-language prompt the user can send the AGENT to do the work for them. */
  chatPrompt?: string;
  /** Optional URL to official provider docs (e.g. https://platform.openai.com/api-keys). */
  docsUrl?: string;
  /** Optional deep-link to "Create API key" page. */
  getApiKeyUrl?: string;
};

/**
 * Requirement spec — describes ONE thing a capability needs to actually
 * function. The resolver (`capability-requirements.ts`) inspects live
 * data (models.authStatus, channels.status, mcp.list, etc.) to decide
 * whether each requirement is met.
 *
 * `optional: true` = nice-to-have, doesn't block the capability.
 *
 * `setupGuide` is shown in the requirements modal when this specific
 * requirement is unmet. Should be human-readable Bahasa.
 */
export type Requirement =
  | {
      /** LLM provider key (OPENAI_API_KEY, GEMINI_API_KEY, ANTHROPIC_API_KEY, etc.) */
      kind: "llm-key";
      provider: string; // e.g. "openai" | "anthropic" | "gemini" | "groq" | "deepseek"
      /** Friendly label shown in modal ("Kunci OpenAI"). */
      label: string;
      /** Sub-feature gating (e.g. image_gen sometimes accepts xAI as fallback). */
      providersAny?: string[];
      optional?: boolean;
      setupGuide?: SetupGuide;
    }
  | {
      /** Channel adapter (telegram/whatsapp/discord/slack/etc.) — needs login/binding */
      kind: "channel";
      channel: string;
      label: string;
      optional?: boolean;
      setupGuide?: SetupGuide;
    }
  | {
      /** Generic env var (set by chief in container or via .env mount) */
      kind: "env";
      name: string;
      label: string;
      hint?: string;
      optional?: boolean;
      setupGuide?: SetupGuide;
    }
  | {
      /** Hard external dependency that AgentBuff can't help with (e.g. Mac for BlueBubbles, HA URL for Home Assistant) */
      kind: "external";
      label: string;
      hint: string;
      /** True = completely blocked without manual chief setup */
      blocking?: boolean;
      setupGuide?: SetupGuide;
    }
  | {
      /** Active MCP server with this name — auto-resolves via mcp.list */
      kind: "mcp-server";
      name: string;
      label: string;
      setupGuide?: SetupGuide;
    };

/** Aggregated status used by the UI badge + modal. */
export type RequirementStatus =
  | "ready" // semua syarat terpenuhi
  | "setup-needed" // ada yang kosong/missing
  | "blocked" // ada hard external dep yang nggak tersedia
  | "internal"; // capability internal — gak butuh apa-apa

/* ── Setup guide factories ───────────────────────────────────────── */
/* Reusable guides — STRICTLY ACCURATE to real AgentBuff app navigation.
 * Verified 2026-06-08:
 *   - "Pengaturan → Penyedia AI" tab exists at /app/providers (provider keys)
 *   - Channel pairing is PER-AGENT: /app/agents → pilih agen → sub-tab "Saluran"
 *     (the standalone /app/channels tab was deleted 2026-06-08)
 *   - "Plugin & Connector" sub-tab exists in Kemampuan tab (MCP install)
 *   - NO "Env Vars" UI tab exists — env vars set via .env file via agent
 */

function llmKeyGuide(opts: {
  envName: string;
  providerName: string;
  getApiKeyUrl: string;
  docsUrl?: string;
}): SetupGuide {
  return {
    intro: `The ${opts.providerName} API key lets your agent call its LLM. Without it, this feature won't work.`,
    placement: "tab-pengaturan-model",
    getApiKeyUrl: opts.getApiKeyUrl,
    docsUrl: opts.docsUrl,
    steps: [
      {
        title: `Create a key at ${opts.providerName}`,
        body: `Go to ${opts.getApiKeyUrl}, sign in with your ${opts.providerName} account, and click "Create new secret key" / "Create API key". Copy the key that appears (it's only shown once — don't close the tab yet).`,
      },
      {
        title: "Paste into the AI Providers tab",
        body: `In the /app sidebar, open the "Settings" group → "AI Providers" tab. Find the "${opts.providerName}" provider row, paste your key into the field, and click Save. The key is stored securely in your engine config.`,
      },
      {
        title: "Check here",
        body: "Come back to this tab and refresh — the badge should change to 🟢 READY. If it still shows ⚠️, the key may be mistyped, expired, or the provider account has no credits.",
      },
    ],
    chatPrompt: `Check whether my ${opts.providerName} API key is active via the models.authStatus tool. If not, tell me what I need to do to activate it.`,
  };
}

function channelGuide(opts: {
  channelId: string;
  channelName: string;
  hint?: string;
}): SetupGuide {
  return {
    intro: `To use ${opts.channelName} with your agent, the agent needs to log in as a bot first. Once connected, it can send and receive messages there.`,
    placement: "tab-saluran",
    steps: [
      {
        title: "Open the agent's Channels tab",
        body: `In the /app sidebar, open the "Agents" tab, select your agent, then open the "Channels" sub-tab. Click "Connect Channel" and choose "${opts.channelName}".`,
      },
      {
        title: `Pair ${opts.channelName}`,
        body: opts.hint
          ? opts.hint
          : `Click the pairing button on the ${opts.channelName} card, then follow the dialog (paste bot token / scan QR / OAuth).`,
      },
      {
        title: "Come back here",
        body: "Once the status in the agent's Channels sub-tab shows CONNECTED, return to this Capabilities tab. The badge auto-updates to 🟢 READY after a refresh.",
      },
    ],
    chatPrompt: `I want to set up the ${opts.channelName} channel on my agent. Walk me through the steps I need to take and what I should prepare before starting.`,
  };
}

/**
 * Env var guide — REAL path: agent writes to ~/.hermes/.env via file tool.
 * AgentBuff sengaja gak punya UI form untuk env karena env perlu container
 * restart untuk diapply, dan agent yang punya akses file system + shell
 * di workspace-nya bisa lakuin ini end-to-end via chat.
 */
function envGuide(opts: {
  envName: string;
  serviceName: string;
  getKeyUrl?: string;
  docsUrl?: string;
  customSteps?: Array<{ title: string; body: string }>;
}): SetupGuide {
  return {
    intro: `The env var \`${opts.envName}\` is used by the engine to connect to ${opts.serviceName}. Since AgentBuff doesn't have a dedicated env form yet, the easiest way is to chat with your agent and have it write the value to the env file directly.`,
    placement: "chat-agent",
    docsUrl: opts.docsUrl,
    getApiKeyUrl: opts.getKeyUrl,
    steps:
      opts.customSteps ?? [
        {
          title: `Get your ${opts.serviceName} credentials`,
          body: opts.getKeyUrl
            ? `Go to ${opts.getKeyUrl}, sign in with your ${opts.serviceName} account, and generate / copy the required credentials. Note the value — it won't be shown again in the provider dashboard.`
            : `Generate your ${opts.serviceName} credentials by following the official documentation (see the Docs link below).`,
        },
        {
          title: "Ask your agent to write to .env",
          body: `Use the "💬 Ask your agent" prompt below, replacing the credential placeholder with the value you just copied. The agent uses the write_file tool to append to ~/.hermes/.env, and the engine reloads automatically.`,
        },
        {
          title: "Check here",
          body: "Wait ~5 seconds (engine reload), refresh this tab — the badge should turn 🟢 READY.",
        },
      ],
    chatPrompt: `Please add the env var \`${opts.envName}=<paste your ${opts.serviceName} credential value here>\` to the file ~/.hermes/.env. Append it — don't replace — and leave other env vars intact. After you're done, reload the engine config and let me know whether it succeeded.`,
  };
}

function mcpGuide(opts: { mcpName: string; serviceName: string }): SetupGuide {
  return {
    intro: `${opts.serviceName} integrates via an MCP (Model Context Protocol) connector. Just install the preset from the Plugin & Connector tab here, fill in the requested credentials, and your agent can access it immediately.`,
    placement: "tab-plugin-mcp",
    steps: [
      {
        title: "Open the Plugin & Connector sub-tab",
        body: "Still on this Capabilities tab — click the \"Plugin & Connector\" sub-tab at the top (rightmost after Core Capabilities / Special Skills).",
      },
      {
        title: `Install the ${opts.serviceName} connector`,
        body: `Click "Add connector" in the "App Connectors (MCP)" section. Find "${opts.serviceName}" in the preset grid and click its card. Fill in the requested env var (usually just one token), then click "Install Connector".`,
      },
      {
        title: "Check here",
        body: "Once the connector status is green (active), return to the Core Capabilities sub-tab. The badge auto-updates to 🟢 READY.",
      },
    ],
    chatPrompt: `I want to use ${opts.serviceName} in my agent. Tell me where to get the token/credential I need to enter in the MCP connector preset, and what scope/permissions are required.`,
  };
}

function externalGuide(opts: {
  serviceName: string;
  reason: string;
  steps?: Array<{ title: string; body: string }>;
}): SetupGuide {
  return {
    intro: `${opts.serviceName} requires setup outside of AgentBuff. ${opts.reason}`,
    placement: "external",
    steps:
      opts.steps ?? [
        {
          title: "Set up outside AgentBuff",
          body: opts.reason,
        },
      ],
    chatPrompt: `I want to use ${opts.serviceName} in my agent. Please explain how to set it up from scratch — what I need to buy/prepare, how to install it, and finally how to connect it to the agent.`,
  };
}

/* ── Toolset translation (Hermes built-in toolsets) ──────────────────── */
/*
 * Keys here MUST be the bare bundle name (no `hermes-` or `agentbuff-`
 * prefix). The translateToolset() helper normalizes the prefix away
 * before lookup. So one entry covers all branding variants.
 */

export const TOOLSET_VOCAB: Record<string, VocabEntry> = {
  /* ── Core engine / file & shell ─────────────────────────────────── */
  file: {
    label: "Read & Write Files",
    description: "Lets your agent read, write, and edit files in its own workspace.",
    icon: "📂",
    category: "produktivitas",
    bucket: "data",
  },
  filesystem: {
    label: "File System Access",
    description: "Walk folders, list directory contents, and perform other file operations in the agent's workspace.",
    icon: "📁",
    category: "produktivitas",
    bucket: "data",
  },
  files: {
    label: "File Management",
    description: "Full file/folder operations — move, copy, rename, delete.",
    icon: "📁",
    category: "produktivitas",
    bucket: "data",
  },
  shell: {
    label: "Run Shell Commands",
    description: "Lets your agent execute terminal commands (ls, grep, curl, etc.) in its sandbox.",
    icon: "💻",
    category: "developer",
    bucket: "developer",
  },
  bash: {
    label: "Run Bash",
    description: "Execute multi-line bash scripts for terminal task automation.",
    icon: "💻",
    category: "developer",
    bucket: "developer",
  },
  terminal: {
    label: "Interactive Terminal",
    description: "Full interactive terminal access — opens a stateful shell session.",
    icon: "🖥️",
    category: "developer",
    bucket: "developer",
  },

  /* ── Web & browser ─────────────────────────────────────────────── */
  browser: {
    label: "Automated Browser",
    description: "Open websites, click buttons, fill forms, and take screenshots using a headless browser (Playwright).",
    icon: "🌐",
    category: "otomasi",
    bucket: "developer",
  },
  "browser-cdp": {
    label: "Browser (Chrome DevTools)",
    description: "Control Chrome via the CDP protocol — more advanced for complex scraping.",
    icon: "🌐",
    category: "developer",
    bucket: "developer",
  },
  browser_cdp: {
    label: "Browser (Chrome DevTools)",
    description: "Control Chrome via the CDP protocol — more advanced for complex scraping.",
    icon: "🌐",
    category: "developer",
    bucket: "developer",
  },
  web_search: {
    label: "Web Search",
    description: "Search Google / DuckDuckGo / Brave and retrieve result snippets.",
    icon: "🔍",
    category: "riset",
    bucket: "data",
    requires: [
      {
        kind: "env",
        name: "BRAVE_API_KEY",
        label: "Brave Search Key",
        hint: "Free tier: 2,000 queries/month at brave.com/search/api",
        optional: true,
      },
    ],
  },
  web: {
    label: "Full Web Access",
    description: "Search + fetch URLs + extract web page content as clean text.",
    icon: "🌐",
    category: "riset",
    bucket: "data",
  },
  fetch: {
    label: "Fetch URL",
    description: "Fetch and parse a web page into text/Markdown readable by the agent.",
    icon: "🔗",
    category: "riset",
    bucket: "data",
  },
  fetch_url: {
    label: "Fetch URL",
    description: "Fetch and parse a web page into text/Markdown readable by the agent.",
    icon: "🔗",
    category: "riset",
    bucket: "data",
  },

  /* ── Memory & context ──────────────────────────────────────────── */
  memory: {
    label: "Long-Term Memory",
    description: "Lets your agent remember important things across sessions (user preferences, project facts, etc.).",
    icon: "🧠",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  recall: {
    label: "Memory Recall",
    description: "Search the agent's long-term memory using semantic search.",
    icon: "🧠",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  context_engine: {
    label: "Context Engine",
    description: "Automatically optimizes context window contents — keeps the agent focused on what's relevant.",
    icon: "🧮",
    category: "agen-tools",
    bucket: "agen-tools",
  },

  /* ── Creative: image / video / audio ───────────────────────────── */
  image_gen: {
    label: "Image Generation",
    description: "Create images from text prompts using DALL-E / Imagen / Flux.",
    icon: "🎨",
    category: "kreatif",
    bucket: "kreatif",
    requires: [
      {
        kind: "llm-key",
        provider: "openai",
        providersAny: ["openai", "xai", "gemini"],
        label: "OpenAI / xAI / Gemini Key",
        setupGuide: llmKeyGuide({
          envName: "OPENAI_API_KEY",
          providerName: "OpenAI",
          getApiKeyUrl: "https://platform.openai.com/api-keys",
          docsUrl: "https://platform.openai.com/docs/guides/images",
        }),
      },
    ],
  },
  image_generate: {
    label: "Image Generation",
    description: "Create images from text prompts using multiple AI image providers.",
    icon: "🎨",
    category: "kreatif",
    bucket: "kreatif",
    requires: [
      {
        kind: "llm-key",
        provider: "openai",
        providersAny: ["openai", "xai", "gemini"],
        label: "OpenAI / xAI / Gemini Key",
        setupGuide: llmKeyGuide({
          envName: "OPENAI_API_KEY",
          providerName: "OpenAI",
          getApiKeyUrl: "https://platform.openai.com/api-keys",
        }),
      },
    ],
  },
  image_edit: {
    label: "Edit Image",
    description: "Modify existing images (inpaint, swap, restyle) using AI.",
    icon: "🖌️",
    category: "kreatif",
    bucket: "kreatif",
    requires: [
      {
        kind: "llm-key",
        provider: "openai",
        providersAny: ["openai", "xai"],
        label: "OpenAI / xAI Key",
        setupGuide: llmKeyGuide({
          envName: "OPENAI_API_KEY",
          providerName: "OpenAI",
          getApiKeyUrl: "https://platform.openai.com/api-keys",
        }),
      },
    ],
  },
  video_gen: {
    label: "Video Generation",
    description: "Create short videos from text prompts (Gemini Veo / Qwen / Moonshot).",
    icon: "🎬",
    category: "kreatif",
    bucket: "kreatif",
    requires: [
      {
        kind: "llm-key",
        provider: "gemini",
        providersAny: ["gemini", "qwen", "moonshot"],
        label: "Gemini / Qwen / Moonshot Key",
        setupGuide: llmKeyGuide({
          envName: "GEMINI_API_KEY",
          providerName: "Google Gemini",
          getApiKeyUrl: "https://aistudio.google.com/apikey",
          docsUrl: "https://ai.google.dev/gemini-api/docs/video",
        }),
      },
    ],
  },
  video_generate: {
    label: "Video Generation",
    description: "Create short videos from text prompts using multiple AI video providers.",
    icon: "🎬",
    category: "kreatif",
    bucket: "kreatif",
    requires: [
      {
        kind: "llm-key",
        provider: "gemini",
        providersAny: ["gemini", "qwen", "moonshot"],
        label: "Gemini / Qwen / Moonshot Key",
        setupGuide: llmKeyGuide({
          envName: "GEMINI_API_KEY",
          providerName: "Google Gemini",
          getApiKeyUrl: "https://aistudio.google.com/apikey",
        }),
      },
    ],
  },
  voice: {
    label: "Agent Voice",
    description: "Text-to-speech + speech-to-text — your agent can send and receive voice notes.",
    icon: "🎙️",
    category: "kreatif",
    bucket: "kreatif",
    requires: [
      {
        kind: "llm-key",
        provider: "gemini",
        providersAny: ["gemini", "openai", "groq", "deepgram"],
        label: "Audio provider key (Gemini / OpenAI / Groq / Deepgram)",
        optional: true,
        setupGuide: llmKeyGuide({
          envName: "GEMINI_API_KEY",
          providerName: "Google Gemini",
          getApiKeyUrl: "https://aistudio.google.com/apikey",
        }),
      },
    ],
  },
  tts: {
    label: "Text-to-Speech",
    description: "Convert text to MP3 audio — for narration, voice notes, or audio responses.",
    icon: "🔊",
    category: "kreatif",
    bucket: "kreatif",
  },
  stt: {
    label: "Speech-to-Text",
    description: "Transcribe voice notes / audio recordings to text automatically.",
    icon: "🎤",
    category: "kreatif",
    bucket: "kreatif",
    requires: [
      {
        kind: "llm-key",
        provider: "gemini",
        providersAny: ["gemini", "openai", "groq", "deepgram"],
        label: "STT provider key (Gemini / OpenAI / Groq / Deepgram)",
        setupGuide: llmKeyGuide({
          envName: "GEMINI_API_KEY",
          providerName: "Google Gemini",
          getApiKeyUrl: "https://aistudio.google.com/apikey",
        }),
      },
    ],
  },
  vision: {
    label: "Image Analysis",
    description: "Your agent can 'see' image contents — captions, OCR, object detection, visual Q&A.",
    icon: "👁️",
    category: "kreatif",
    bucket: "kreatif",
    requires: [
      {
        kind: "llm-key",
        provider: "gemini",
        providersAny: ["gemini", "openai", "anthropic"],
        label: "Multimodal model (Gemini / OpenAI / Claude)",
        setupGuide: llmKeyGuide({
          envName: "GEMINI_API_KEY",
          providerName: "Google Gemini",
          getApiKeyUrl: "https://aistudio.google.com/apikey",
        }),
      },
    ],
  },

  /* ── Productivity / scheduling / planning ──────────────────────── */
  cronjob: {
    label: "Scheduled Tasks",
    description: "Create scheduled jobs — your agent works autonomously every morning, weekly, or on a cron expression.",
    icon: "⏰",
    category: "produktivitas",
    bucket: "agen-tools",
  },
  cron: {
    label: "Scheduled Tasks",
    description: "Create scheduled jobs — your agent works autonomously every morning, weekly, or on a cron expression.",
    icon: "⏰",
    category: "produktivitas",
    bucket: "agen-tools",
  },
  kanban: {
    label: "Quest Board",
    description: "Manage tasks + collaboration board like Trello (todo / doing / done).",
    icon: "📋",
    category: "produktivitas",
    bucket: "agen-tools",
  },
  task: {
    label: "Task Management",
    description: "Track and manage the agent's internal task list — focus, priority, status.",
    icon: "✅",
    category: "produktivitas",
    bucket: "agen-tools",
  },
  task_planning: {
    label: "Task Planning",
    description: "Break complex problems into systematic step-by-step plans.",
    icon: "🗺️",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  clarify: {
    label: "Clarification",
    description: "Makes the agent ask the user when instructions are ambiguous — prevents misunderstandings.",
    icon: "❓",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  delegation: {
    label: "Delegate to Sub-Agent",
    description: "The agent can spawn other sub-agents to work on subtasks in parallel.",
    icon: "👥",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  delegate_task: {
    label: "Task Delegation",
    description: "Spawn specialist sub-agents (researcher, coder, writer) for specific tasks.",
    icon: "👥",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  subagents: {
    label: "Sub-Agents",
    description: "Manage a sub-agent team — recruit, assign roles, and coordinate multi-agent workflows.",
    icon: "👥",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  moa: {
    label: "Mixture of Agents",
    description: "Combines answers from multiple agents simultaneously for more accurate results.",
    icon: "🧩",
    category: "agen-tools",
    bucket: "agen-tools",
  },

  /* ── Developer tools ───────────────────────────────────────────── */
  code_execution: {
    label: "Run Code",
    description: "Execute Python / shell snippets directly in the agent's sandbox.",
    icon: "🐍",
    category: "developer",
    bucket: "developer",
  },
  execute_code: {
    label: "Run Code",
    description: "Safely execute Python / JS / shell code snippets in a sandbox.",
    icon: "🐍",
    category: "developer",
    bucket: "developer",
  },
  python: {
    label: "Python REPL",
    description: "Run interactive Python — data analysis, calculations, on-the-fly scripting.",
    icon: "🐍",
    category: "developer",
    bucket: "developer",
  },
  computer_use: {
    label: "Computer Control",
    description: "Screenshot + mouse + keyboard control — the agent can use desktop apps just like a human.",
    icon: "🖱️",
    category: "otomasi",
    bucket: "developer",
  },
  debugging: {
    label: "Debugging",
    description: "Tools for tracing errors, setting breakpoints, and fixing bugs in code the agent writes.",
    icon: "🐛",
    category: "developer",
    bucket: "developer",
  },
  git: {
    label: "Git",
    description: "Commit, branch, push, and open pull requests to a Git repo (local or GitHub).",
    icon: "🌿",
    category: "developer",
    bucket: "developer",
  },
  safe: {
    label: "Safe Sandbox",
    description: "Run code/commands in an isolated environment — won't affect your main system.",
    icon: "🛡️",
    category: "developer",
    bucket: "developer",
  },
  sandbox: {
    label: "Execution Sandbox",
    description: "Isolated execution environment for risky code or commands.",
    icon: "🛡️",
    category: "developer",
    bucket: "developer",
  },
  cli: {
    label: "Engine CLI Access",
    description: "Lets the agent call the engine's own CLI commands — useful for self-management.",
    icon: "⌨️",
    category: "developer",
    bucket: "developer",
  },
  skills: {
    label: "Skill Management",
    description: "Lets the agent list, install, or swap its own custom skills.",
    icon: "📖",
    category: "agen-tools",
    bucket: "agen-tools",
  },

  /* ── Infrastructure & runtime ──────────────────────────────────── */
  api_server: {
    label: "API Server",
    description: "Expose your agent as an HTTP API endpoint — callable from external applications.",
    icon: "🔌",
    category: "developer",
    bucket: "developer",
  },
  "api-server": {
    label: "API Server",
    description: "Expose your agent as an HTTP API endpoint — callable from external applications.",
    icon: "🔌",
    category: "developer",
    bucket: "developer",
  },
  gateway: {
    label: "Gateway Runtime",
    description: "The core engine that connects your agent to all channels and tools (internal).",
    icon: "🛰️",
    category: "developer",
    bucket: "developer",
  },
  acp: {
    label: "Agent-to-Agent Comms",
    description: "Lets your agent talk and collaborate with other agents via the Agent Communication Protocol.",
    icon: "📡",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  messaging: {
    label: "Multi-Channel Messaging",
    description: "Adapter bundle for sending and receiving messages across multiple messaging platforms at once.",
    icon: "📨",
    category: "komunikasi",
    bucket: "komunikasi",
  },

  /* ── Messaging channels (mainstream) ──────────────────────────── */
  telegram: {
    label: "Telegram",
    description: "Send and receive Telegram messages via a bot — DMs, groups, media, inline keyboards.",
    icon: "✈️",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "channel",
        channel: "telegram",
        label: "Telegram bot token",
        setupGuide: channelGuide({
          channelId: "telegram",
          channelName: "Telegram",
          hint:
            "Open @BotFather in Telegram, send /newbot, and give your bot a name. BotFather will give you a long bot token. Copy it, go back to AgentBuff, and paste it in the Telegram pairing dialog.",
        }),
      },
    ],
  },
  whatsapp: {
    label: "WhatsApp",
    description: "Send and receive WhatsApp messages via Baileys — DMs, groups, media, voice notes.",
    icon: "💚",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "channel",
        channel: "whatsapp",
        label: "WhatsApp session (QR scan)",
        setupGuide: channelGuide({
          channelId: "whatsapp",
          channelName: "WhatsApp",
          hint:
            "Click the \"Connect WhatsApp\" button on its card. AgentBuff will generate a QR code. Open WhatsApp on your phone → Settings → Linked Devices → Link a Device → scan the QR. Done.",
        }),
      },
    ],
  },
  discord: {
    label: "Discord",
    description: "Discord bot — send messages, react, manage servers/channels/threads.",
    icon: "🎮",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "channel",
        channel: "discord",
        label: "Discord bot token",
        setupGuide: channelGuide({
          channelId: "discord",
          channelName: "Discord",
          hint:
            "Go to discord.com/developers/applications, click New Application, and give it a name. Open the \"Bot\" tab → Reset Token → copy. Go back to AgentBuff and paste the token in the Discord pairing dialog. Make sure to invite the bot to your server using the OAuth2 URL AgentBuff provides.",
        }),
      },
    ],
  },
  discord_admin: {
    label: "Discord Admin",
    description: "Admin tools for Discord servers — ban, kick, roles, audit log.",
    icon: "🛡️",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "channel",
        channel: "discord",
        label: "Discord bot token",
        setupGuide: channelGuide({
          channelId: "discord",
          channelName: "Discord",
          hint:
            "Use the same bot token as the regular Discord capability. Make sure your bot has Admin role permissions in the Discord server (Manage Channels / Manage Roles / Ban Members).",
        }),
      },
    ],
  },
  slack: {
    label: "Slack",
    description: "Slack bot — send messages, react, manage workspaces, channels, and threads.",
    icon: "🔔",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "channel",
        channel: "slack",
        label: "Slack bot token + signing secret",
        setupGuide: channelGuide({
          channelId: "slack",
          channelName: "Slack",
          hint:
            "Go to api.slack.com/apps → Create New App → From scratch. Under OAuth & Permissions, install to your workspace and copy the \"Bot User OAuth Token\" (xoxb-...). Under Basic Information, copy the \"Signing Secret\". Go back to AgentBuff and paste both in the pairing dialog.",
        }),
      },
    ],
  },
  bluebubbles: {
    label: "iMessage (BlueBubbles)",
    description: "Send and receive Apple iMessages via the BlueBubbles bridge (requires a Mac as a server).",
    icon: "💬",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "external",
        label: "Always-on Mac + BlueBubbles server",
        hint: "iMessage only runs in the Apple ecosystem. You need a Mac to act as a bridge server.",
        blocking: true,
        setupGuide: externalGuide({
          serviceName: "BlueBubbles iMessage Bridge",
          reason:
            "Apple doesn't expose an official iMessage API to non-Apple devices. BlueBubbles works around this: install BlueBubbles Server on your Mac (running 24/7), the Mac handles real iMessage, and AgentBuff connects to your BlueBubbles Server via HTTP.",
          steps: [
            {
              title: "Prepare an always-on Mac",
              body: "A Mac mini, old MacBook, or iMac you can leave running permanently. It must be signed in to the Apple ID that owns the active iMessage number, and have a stable internet connection.",
            },
            {
              title: "Install BlueBubbles Server on the Mac",
              body: "Download from bluebubbles.app — choose BlueBubbles Server and install it like any Mac app. On first launch: sign in with your Apple ID and grant Full Disk Access via System Settings → Privacy & Security → Full Disk Access → toggle BlueBubbles ON.",
            },
            {
              title: "Set up a public tunnel (Cloudflare/ngrok)",
              body: "BlueBubbles Server has a built-in Cloudflare tunnel — enable it via Settings → Network tab → Connection. It will auto-generate an https://xxxx.trycloudflare.com URL (free, no sign-up). Note that URL and the password you set in the Server.",
            },
            {
              title: "Connect to AgentBuff via agent chat",
              body: "Use the prompt below, replacing the placeholders with the tunnel URL and password. The agent writes to ~/.hermes/.env. After the engine reloads, enable the iMessage toolset in this Capabilities tab.",
            },
          ],
        }),
      },
    ],
  },
  matrix: {
    label: "Matrix",
    description: "Decentralized Matrix messaging (Element / Synapse) — federated chat + E2E encrypted.",
    icon: "🟢",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "env",
        name: "MATRIX_HOMESERVER",
        label: "Matrix homeserver URL",
        setupGuide: envGuide({
          envName: "MATRIX_HOMESERVER",
          serviceName: "Matrix",
          docsUrl: "https://matrix.org/docs/",
          customSteps: [
            {
              title: "Choose a Matrix homeserver",
              body: "You can use matrix.org (free, public) or self-host with Synapse/Dendrite. Note your homeserver URL in the format https://matrix.org (or your private homeserver address).",
            },
            {
              title: "Ask your agent to write to .env",
              body: "Use the prompt below, replacing the placeholder with your homeserver URL. The agent writes to ~/.hermes/.env. Repeat this step for MATRIX_ACCESS_TOKEN in the next card.",
            },
          ],
        }),
      },
      {
        kind: "env",
        name: "MATRIX_ACCESS_TOKEN",
        label: "Matrix access token",
        setupGuide: envGuide({
          envName: "MATRIX_ACCESS_TOKEN",
          serviceName: "Matrix",
          docsUrl: "https://t2bot.io/docs/access_tokens/",
          customSteps: [
            {
              title: "Generate an access token",
              body: "Follow the official guide at t2bot.io/docs/access_tokens (Docs link below). In short: log into your Matrix account via a curl request to /_matrix/client/r0/login — the response contains your access_token.",
            },
            {
              title: "Ask your agent to write to .env",
              body: "Use the prompt below, replacing the placeholder with the token you just generated. The agent writes to ~/.hermes/.env and the engine auto-reloads.",
            },
            {
              title: "Check here",
              body: "Wait ~5 seconds, refresh this tab — the badge should turn 🟢 READY.",
            },
          ],
        }),
      },
    ],
  },
  mattermost: {
    label: "Mattermost",
    description: "Open-source Slack alternative — send messages, react, manage team channels.",
    icon: "💼",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "env",
        name: "MATTERMOST_URL",
        label: "Mattermost server URL",
        setupGuide: envGuide({
          envName: "MATTERMOST_URL",
          serviceName: "Mattermost",
          customSteps: [
            {
              title: "Find your Mattermost server URL",
              body: "Your Mattermost workspace URL is usually formatted as https://team.mattermost.com or https://mattermost.your-domain.com. Check the invite email, the browser address bar when logged in, or ask your workspace admin.",
            },
            {
              title: "Ask your agent to write to .env",
              body: "Use the prompt below, replacing the placeholder with your full workspace URL (including https://).",
            },
          ],
        }),
      },
      {
        kind: "env",
        name: "MATTERMOST_TOKEN",
        label: "Bot access token",
        setupGuide: envGuide({
          envName: "MATTERMOST_TOKEN",
          serviceName: "Mattermost",
          docsUrl: "https://developers.mattermost.com/integrate/reference/bot-accounts/",
          customSteps: [
            {
              title: "Enable Bot Accounts in System Console",
              body: "Bot accounts need to be enabled first. A Mattermost workspace admin must do this via System Console → Integrations → Bot Accounts → Enable Bot Account Creation. (If you're not the admin, ask them.)",
            },
            {
              title: "Create a bot account",
              body: "Once enabled, go to Mattermost main menu → Integrations → Bot Accounts → Add Bot Account. Give it a username and display name. After saving, Mattermost shows the access token once — copy it now.",
            },
            {
              title: "Ask your agent to write to .env",
              body: "Use the prompt below, replacing the placeholder with the token you just copied. The engine auto-reloads after the file is written.",
            },
          ],
        }),
      },
    ],
  },
  signal: {
    label: "Signal",
    description: "Send and receive Signal messages (privacy-first, E2E encrypted messaging).",
    icon: "🔒",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "external",
        label: "Signal phone number + signal-cli setup",
        hint: "Signal requires phone-number registration and a signal-cli daemon on the server.",
        setupGuide: externalGuide({
          serviceName: "Signal Messenger",
          reason:
            "Signal's protocol is closed-source and E2E encrypted. It officially only supports mobile/desktop apps. For bots, you need signal-cli (a Java daemon) that registers a separate phone number as a \"linked device\" or standalone account.",
          steps: [
            {
              title: "Prepare a dedicated phone number",
              body: "A phone number NOT already registered with Signal. Options: a second SIM, a virtual number (e.g. Google Voice in the US, JustCall globally), or a dedicated IoT number. This number will be locked to your signal-cli instance.",
            },
            {
              title: "Install signal-cli in the container",
              body: "Since the AgentBuff container is self-contained, the easiest approach is installing signal-cli in the SAME container — chat with your agent and ask it to download the signal-cli release from github.com/AsamK/signal-cli/releases to ~/.hermes/bin/. The agent has shell + wget tools to do this.",
            },
            {
              title: "Register and verify the number",
              body: "Run via shell in the container: `signal-cli -a +1xxx register` (Signal sends an SMS) → `signal-cli -a +1xxx verify <6-digit-code-from-SMS>`. After verification, signal-cli can send/receive on that number.",
            },
            {
              title: "Connect AgentBuff via agent chat",
              body: "Use the prompt below, replacing the placeholders with the phone number and the absolute path to signal-cli. The agent writes to ~/.hermes/.env, the engine reloads, and you enable the Signal toolset in this tab.",
            },
          ],
        }),
      },
    ],
  },

  /* ── Messaging channels (China / Asia ecosystem) ──────────────── */
  dingtalk: {
    label: "DingTalk (钉钉)",
    description: "DingTalk bot — popular enterprise messaging app in China (Alibaba).",
    icon: "📱",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "channel",
        channel: "dingtalk",
        label: "DingTalk (pairing required)",
      },
    ],
  },
  feishu: {
    label: "Feishu / Lark",
    description: "ByteDance's workspace messaging — chat + docs + meetings + calendar, all integrated.",
    icon: "🪶",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "channel",
        channel: "feishu",
        label: "Feishu / Lark (pairing required)",
      },
    ],
  },
  feishu_doc: {
    label: "Feishu Document",
    description: "Access and edit Feishu/Lark documents (similar to Google Docs).",
    icon: "📄",
    category: "produktivitas",
    bucket: "data",
    requires: [
      {
        kind: "channel",
        channel: "feishu",
        label: "Feishu / Lark (pairing required)",
      },
    ],
  },
  feishu_drive: {
    label: "Feishu Drive",
    description: "Access files in Feishu/Lark Drive (similar to Google Drive).",
    icon: "📁",
    category: "produktivitas",
    bucket: "data",
    requires: [
      {
        kind: "channel",
        channel: "feishu",
        label: "Feishu / Lark (pairing required)",
      },
    ],
  },
  wecom: {
    label: "WeCom (企业微信)",
    description: "WeChat for Work — Tencent's enterprise messaging (popular in China).",
    icon: "💼",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "channel",
        channel: "wecom",
        label: "WeCom (pairing required)",
      },
    ],
  },
  wecom_callback: {
    label: "WeCom Callback",
    description: "Webhook callback handler for WeCom events — receive events without polling.",
    icon: "📞",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "channel",
        channel: "wecom",
        label: "WeCom (pairing required)",
      },
    ],
  },
  "wecom-callback": {
    label: "WeCom Callback",
    description: "Webhook callback handler for WeCom events — receive events without polling.",
    icon: "📞",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "channel",
        channel: "wecom",
        label: "WeCom (pairing required)",
      },
    ],
  },
  weixin: {
    label: "WeChat (微信)",
    description: "Send and receive WeChat messages (consumer version) — chat + Moments + Mini Programs.",
    icon: "💬",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "channel",
        channel: "weixin",
        label: "WeChat (pairing required)",
      },
    ],
  },
  qqbot: {
    label: "QQ Bot",
    description: "QQ bot — Tencent messaging hugely popular among gamers and Gen Z in China.",
    icon: "🐧",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "channel",
        channel: "qqbot",
        label: "QQ Bot (pairing required)",
      },
    ],
  },
  yuanbao: {
    label: "Yuanbao (元宝)",
    description: "Tencent's AI assistant service — LLM integration within the Tencent ecosystem.",
    icon: "🤖",
    category: "agen-tools",
    bucket: "agen-tools",
    requires: [
      {
        kind: "channel",
        channel: "yuanbao",
        label: "Yuanbao / Tencent (setup required)",
      },
    ],
  },

  /* ── Smart home / IoT ──────────────────────────────────────────── */
  homeassistant: {
    label: "Home Assistant",
    description: "Control your smart home — turn on lights, AC, set thermostat, read sensors, and more.",
    icon: "🏠",
    category: "otomasi",
    bucket: "lain",
    requires: [
      {
        kind: "env",
        name: "HASS_URL",
        label: "Home Assistant instance URL",
        setupGuide: envGuide({
          envName: "HASS_URL",
          serviceName: "Home Assistant",
          docsUrl: "https://www.home-assistant.io/integrations/api/",
          customSteps: [
            {
              title: "Note your Home Assistant URL",
              body: "Nabu Casa cloud: https://xxxx.ui.nabu.casa. Self-hosted local: http://homeassistant.local:8123 or http://<HA-IP>:8123. Note: if the URL is only reachable on your LAN, the AgentBuff container probably can't reach it — you'll need a reverse proxy / VPN / tunnel to HA.",
            },
            {
              title: "Ask your agent to write to .env",
              body: "Use the prompt below, replacing the placeholder with the full URL (including protocol + port). Repeat this step for HASS_TOKEN in the next card.",
            },
          ],
        }),
      },
      {
        kind: "env",
        name: "HASS_TOKEN",
        label: "Long-Lived Access Token",
        setupGuide: envGuide({
          envName: "HASS_TOKEN",
          serviceName: "Home Assistant",
          docsUrl: "https://developers.home-assistant.io/docs/auth_api/#long-lived-access-token",
          customSteps: [
            {
              title: "Generate a Long-Lived Access Token",
              body: "Log into Home Assistant → click your profile avatar (bottom-left) → scroll to the \"Long-Lived Access Tokens\" section → click \"Create Token\". Give it a name (e.g. \"AgentBuff\"), then copy the token — it's only shown once.",
            },
            {
              title: "Ask your agent to write to .env",
              body: "Use the prompt below, replacing the placeholder with the token you just copied.",
            },
            {
              title: "Check here",
              body: "Wait ~5 seconds, refresh this tab — the badge should turn 🟢 READY. Start by telling your agent to \"turn on the living room lights\".",
            },
          ],
        }),
      },
    ],
  },

  /* ── Google ecosystem ──────────────────────────────────────────── */
  google_meet: {
    label: "Google Meet",
    description: "Schedule, join, and manage Google Meet meetings — automatically invite participants.",
    icon: "📹",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [{ kind: "env", name: "GOOGLE_SERVICE_ACCOUNT_JSON", label: "Service Account JSON (Google Workspace)" }],
  },
  gmail: {
    label: "Gmail",
    description: "Read, send, reply, label, and archive Gmail emails.",
    icon: "📧",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [{ kind: "env", name: "GOOGLE_OAUTH_TOKEN", label: "Gmail OAuth token" }],
  },
  google_calendar: {
    label: "Google Calendar",
    description: "Create and manage calendar events — invite attendees, set reminders, sync timezones.",
    icon: "📅",
    category: "produktivitas",
    bucket: "agen-tools",
    requires: [{ kind: "env", name: "GOOGLE_OAUTH_TOKEN", label: "Google Calendar OAuth token" }],
  },
  gcal: {
    label: "Google Calendar",
    description: "Create and manage calendar events — invite attendees, set reminders, sync timezones.",
    icon: "📅",
    category: "produktivitas",
    bucket: "agen-tools",
    requires: [{ kind: "env", name: "GOOGLE_OAUTH_TOKEN", label: "Google Calendar OAuth token" }],
  },
  google_drive: {
    label: "Google Drive",
    description: "Upload, download, share, and organize files in Google Drive.",
    icon: "📁",
    category: "produktivitas",
    bucket: "data",
    requires: [
      {
        kind: "mcp-server",
        name: "gdrive",
        label: "Google Drive MCP connector",
        setupGuide: mcpGuide({ mcpName: "gdrive", serviceName: "Google Drive" }),
      },
    ],
  },
  gdrive: {
    label: "Google Drive",
    description: "Upload, download, share, and organize files in Google Drive.",
    icon: "📁",
    category: "produktivitas",
    bucket: "data",
    requires: [
      {
        kind: "mcp-server",
        name: "gdrive",
        label: "Google Drive MCP connector",
        setupGuide: mcpGuide({ mcpName: "gdrive", serviceName: "Google Drive" }),
      },
    ],
  },
  google_docs: {
    label: "Google Docs",
    description: "Create, edit, and share Google Docs from your agent.",
    icon: "📝",
    category: "produktivitas",
    bucket: "data",
    requires: [{ kind: "env", name: "GOOGLE_OAUTH_TOKEN", label: "Google Docs OAuth token" }],
  },
  google_sheets: {
    label: "Google Sheets",
    description: "Read and write Google Sheets spreadsheets — auto-generate reports, dashboards, and logs.",
    icon: "📊",
    category: "produktivitas",
    bucket: "data",
    requires: [{ kind: "env", name: "GOOGLE_OAUTH_TOKEN", label: "Google Sheets OAuth token" }],
  },

  /* ── Hiburan / lifestyle ───────────────────────────────────────── */
  spotify: {
    label: "Spotify",
    description: "Control Spotify playback and access your library — play, pause, skip, create playlists.",
    icon: "🎵",
    category: "kreatif",
    bucket: "lain",
    requires: [
      {
        kind: "env",
        name: "SPOTIFY_CLIENT_ID",
        label: "Spotify Client ID",
        setupGuide: envGuide({
          envName: "SPOTIFY_CLIENT_ID",
          serviceName: "Spotify",
          getKeyUrl: "https://developer.spotify.com/dashboard",
          docsUrl: "https://developer.spotify.com/documentation/web-api/concepts/apps",
          customSteps: [
            {
              title: "Create an app in the Spotify Developer Dashboard",
              body: "Go to developer.spotify.com/dashboard and sign in with your Spotify account. Click \"Create app\", fill in the name and description. For the Redirect URI: use anything (e.g. https://example.com/callback) — it's only used later when exchanging a code for a refresh token in the OAuth flow.",
            },
            {
              title: "Copy the Client ID",
              body: "After the app is created, click its name → Settings tab → Client ID is shown at the top. Copy it.",
            },
            {
              title: "Ask your agent to write to .env",
              body: "Use the prompt below, replacing the placeholder with the Client ID. Repeat this for SPOTIFY_CLIENT_SECRET and SPOTIFY_REFRESH_TOKEN in the next cards.",
            },
          ],
        }),
      },
      {
        kind: "env",
        name: "SPOTIFY_CLIENT_SECRET",
        label: "Spotify Client Secret",
        setupGuide: envGuide({
          envName: "SPOTIFY_CLIENT_SECRET",
          serviceName: "Spotify",
          getKeyUrl: "https://developer.spotify.com/dashboard",
          customSteps: [
            {
              title: "Reveal the Client Secret",
              body: "In the Spotify Developer Dashboard → your app → Settings tab → click \"View client secret\" below the Client ID. Copy it.",
            },
            {
              title: "Ask your agent to write to .env",
              body: "Use the prompt below, replacing the placeholder with the Client Secret you just copied.",
            },
          ],
        }),
      },
      {
        kind: "env",
        name: "SPOTIFY_REFRESH_TOKEN",
        label: "Refresh token (OAuth)",
        setupGuide: envGuide({
          envName: "SPOTIFY_REFRESH_TOKEN",
          serviceName: "Spotify",
          docsUrl: "https://developer.spotify.com/documentation/web-api/tutorials/code-flow",
          customSteps: [
            {
              title: "Exchange an Authorization Code for a Refresh Token",
              body: "This is the trickiest step — you need the OAuth Authorization Code Flow. Easiest way: use the python-spotipy library → `import spotipy; auth = spotipy.SpotifyOAuth(client_id, client_secret, redirect_uri, scope='user-modify-playback-state user-read-playback-state playlist-modify-private'); auth.get_access_token()` — the library returns a long refresh_token. Follow the full tutorial in the Docs link below.",
            },
            {
              title: "Ask your agent to write to .env",
              body: "Use the prompt below, replacing the placeholder with the refresh_token you just generated. After this, your agent can play/pause/skip, etc.",
            },
          ],
        }),
      },
    ],
  },
  youtube: {
    label: "YouTube",
    description: "Search videos, read transcripts, fetch metadata, or auto-upload to YouTube.",
    icon: "📺",
    category: "kreatif",
    bucket: "lain",
  },
  reddit: {
    label: "Reddit",
    description: "Browse subreddits, read posts and comments, post yourself, or reply.",
    icon: "🟧",
    category: "komunikasi",
    bucket: "lain",
  },
  twitter: {
    label: "X / Twitter",
    description: "Post tweets, read your timeline, search, or monitor mentions.",
    icon: "🐦",
    category: "komunikasi",
    bucket: "komunikasi",
  },
  x: {
    label: "X / Twitter",
    description: "Post tweets, read your timeline, search, or monitor mentions.",
    icon: "🐦",
    category: "komunikasi",
    bucket: "komunikasi",
  },

  /* ── Productivity SaaS ─────────────────────────────────────────── */
  notion: {
    label: "Notion",
    description: "Read and create Notion pages, query databases, edit blocks — fully integrated workspace.",
    icon: "📔",
    category: "produktivitas",
    bucket: "data",
    requires: [
      {
        kind: "mcp-server",
        name: "notion",
        label: "Notion MCP connector",
        setupGuide: mcpGuide({ mcpName: "notion", serviceName: "Notion" }),
      },
    ],
  },
  obsidian: {
    label: "Obsidian",
    description: "Read and write Obsidian notes from a local vault — links, tags, and backlinks preserved.",
    icon: "💎",
    category: "produktivitas",
    bucket: "data",
  },
  linear: {
    label: "Linear",
    description: "Create and manage issues, sprints, and projects in Linear (startup-friendly issue tracker).",
    icon: "📊",
    category: "produktivitas",
    bucket: "agen-tools",
  },
  jira: {
    label: "Jira",
    description: "Create and manage issues, sprints, and projects in Atlassian Jira.",
    icon: "🎫",
    category: "produktivitas",
    bucket: "agen-tools",
  },
  airtable: {
    label: "Airtable",
    description: "Read and write rows in an Airtable base — the spreadsheet-meets-database combo.",
    icon: "🗃️",
    category: "produktivitas",
    bucket: "data",
  },
  todoist: {
    label: "Todoist",
    description: "Create, complete, and manage tasks in Todoist — natural language task list.",
    icon: "☑️",
    category: "produktivitas",
    bucket: "agen-tools",
  },
  trello: {
    label: "Trello",
    description: "Manage Trello boards — create cards, move columns, attach files, add comments.",
    icon: "📋",
    category: "produktivitas",
    bucket: "agen-tools",
  },

  /* ── Code & DevOps ─────────────────────────────────────────────── */
  github: {
    label: "GitHub",
    description: "Read, create, and edit issues, PRs, repos, files, or review code on GitHub.",
    icon: "🐙",
    category: "developer",
    bucket: "developer",
    requires: [
      {
        kind: "mcp-server",
        name: "github",
        label: "GitHub MCP connector",
        setupGuide: mcpGuide({ mcpName: "github", serviceName: "GitHub" }),
      },
    ],
  },
  gitlab: {
    label: "GitLab",
    description: "Manage merge requests, issues, pipelines, and repos on GitLab.",
    icon: "🦊",
    category: "developer",
    bucket: "developer",
  },
  docker: {
    label: "Docker",
    description: "Build, run, stop, and manage Docker containers from your agent.",
    icon: "🐳",
    category: "developer",
    bucket: "developer",
  },

  /* ── Database & data ───────────────────────────────────────────── */
  postgres: {
    label: "PostgreSQL",
    description: "Query, read, and write a PostgreSQL database from your agent — SQL on autopilot.",
    icon: "🐘",
    category: "data",
    bucket: "data",
  },
  postgresql: {
    label: "PostgreSQL",
    description: "Query, read, and write a PostgreSQL database from your agent — SQL on autopilot.",
    icon: "🐘",
    category: "data",
    bucket: "data",
  },
  mysql: {
    label: "MySQL",
    description: "Query, read, and write a MySQL database from your agent.",
    icon: "🐬",
    category: "data",
    bucket: "data",
  },
  sqlite: {
    label: "SQLite",
    description: "Query, read, and write a local SQLite database.",
    icon: "💾",
    category: "data",
    bucket: "data",
  },
  redis: {
    label: "Redis",
    description: "Read, write, and cache key-value data in Redis (fast in-memory store).",
    icon: "🟥",
    category: "data",
    bucket: "data",
  },

  /* ── E-commerce / payments / finance ───────────────────────────── */
  shopify: {
    label: "Shopify",
    description: "Manage products, orders, and customers in your Shopify store — e-commerce automation.",
    icon: "🛒",
    category: "produktivitas",
    bucket: "lain",
  },
  midtrans: {
    label: "Midtrans",
    description: "Create invoices and check payment status via Midtrans (QRIS/GoPay/OVO/DANA).",
    icon: "💸",
    category: "data",
    bucket: "lain",
  },

  /* ── Default for completely-unknown ─────────────────────────────── */
  /* ── More common toolsets (caught in fallback before) ──────────── */
  search: {
    label: "Web Search",
    description: "Search Google / DuckDuckGo / Brave and retrieve result snippets.",
    icon: "🔍",
    category: "riset",
    bucket: "data",
  },
  session_search: {
    label: "Search Past Sessions",
    description: "Search content from the agent's old chat sessions — find context or answers from previous conversations.",
    icon: "🔎",
    category: "agen-tools",
    bucket: "data",
  },
  "session-search": {
    label: "Search Past Sessions",
    description: "Search content from the agent's old chat sessions — find context or answers from previous conversations.",
    icon: "🔎",
    category: "agen-tools",
    bucket: "data",
  },
  x_search: {
    label: "Search X / Twitter",
    description: "Search posts on X (Twitter) — monitor topics, trends, or mentions.",
    icon: "🐦",
    category: "riset",
    bucket: "data",
  },
  "x-search": {
    label: "Search X / Twitter",
    description: "Search posts on X (Twitter) — monitor topics, trends, or mentions.",
    icon: "🐦",
    category: "riset",
    bucket: "data",
  },
  email: {
    label: "Email",
    description: "Read, send, reply to, and archive emails via SMTP/IMAP.",
    icon: "📧",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "channel",
        channel: "email",
        label: "Email Account (SMTP/IMAP)",
      },
    ],
  },
  sms: {
    label: "SMS",
    description: "Send and receive SMS via a gateway provider (Twilio, etc.).",
    icon: "📱",
    category: "komunikasi",
    bucket: "komunikasi",
    requires: [
      {
        kind: "channel",
        channel: "sms",
        label: "SMS Gateway (Twilio, etc.)",
      },
    ],
  },
  video: {
    label: "Video Tools",
    description: "Create and edit short videos from text prompts or image frames.",
    icon: "🎬",
    category: "kreatif",
    bucket: "kreatif",
  },
  audio: {
    label: "Audio Tools",
    description: "Create and edit audio from prompts — narration, music, sound effects.",
    icon: "🎵",
    category: "kreatif",
    bucket: "kreatif",
  },
  webhook: {
    label: "Webhook",
    description: "Receive events from external apps via HTTP webhook — trigger your agent from external events.",
    icon: "📥",
    category: "otomasi",
    bucket: "agen-tools",
    requires: [
      {
        kind: "channel",
        channel: "webhook",
        label: "Webhook Endpoint",
      },
    ],
  },
  webhooks: {
    label: "Webhook",
    description: "Receive events from external apps via HTTP webhook — trigger your agent from external events.",
    icon: "📥",
    category: "otomasi",
    bucket: "agen-tools",
    requires: [
      {
        kind: "channel",
        channel: "webhook",
        label: "Webhook Endpoint",
      },
    ],
  },
  todo: {
    label: "Todo List",
    description: "Create, complete, and manage a simple task list for your agent.",
    icon: "☑️",
    category: "produktivitas",
    bucket: "agen-tools",
  },
  todos: {
    label: "Todo List",
    description: "Create, complete, and manage a simple task list for your agent.",
    icon: "☑️",
    category: "produktivitas",
    bucket: "agen-tools",
  },
  reminders: {
    label: "Reminders",
    description: "Set and manage reminders that notify your agent at a specific time.",
    icon: "⏰",
    category: "produktivitas",
    bucket: "agen-tools",
  },
  notes: {
    label: "Notes",
    description: "Create, read, and organize your agent's notes in the workspace.",
    icon: "📝",
    category: "produktivitas",
    bucket: "data",
  },
  rss: {
    label: "RSS Feed",
    description: "Read and monitor RSS feeds from your agent's favorite blogs and news sources.",
    icon: "📰",
    category: "riset",
    bucket: "data",
  },
  weather: {
    label: "Weather",
    description: "Check current weather and daily forecasts via a weather API provider.",
    icon: "🌦️",
    category: "lain",
    bucket: "lain",
  },
  maps: {
    label: "Maps & Navigation",
    description: "Search locations, routes, and distances via Google Maps / OpenStreetMap.",
    icon: "🗺️",
    category: "lain",
    bucket: "lain",
  },
  location: {
    label: "Location",
    description: "Look up coordinates, geocoding, and reverse geocoding.",
    icon: "📍",
    category: "lain",
    bucket: "lain",
  },
  translate: {
    label: "Translate",
    description: "Translate text between languages using DeepL / Google Translate / LLM.",
    icon: "🌍",
    category: "kreatif",
    bucket: "kreatif",
  },
  ocr: {
    label: "OCR",
    description: "Extract text from images or documents using OCR (Tesseract / cloud vision).",
    icon: "📷",
    category: "data",
    bucket: "data",
  },
  pdf: {
    label: "Read PDF",
    description: "Parse and read PDF contents into text your agent can analyze.",
    icon: "📄",
    category: "data",
    bucket: "data",
  },
  excel: {
    label: "Excel",
    description: "Read and write Excel spreadsheets (.xlsx) from your agent.",
    icon: "📊",
    category: "produktivitas",
    bucket: "data",
  },
  word: {
    label: "Word Document",
    description: "Read and write Word documents (.docx) from your agent.",
    icon: "📝",
    category: "produktivitas",
    bucket: "data",
  },
  csv: {
    label: "CSV",
    description: "Parse and write CSV files — lightweight tabular data.",
    icon: "📊",
    category: "data",
    bucket: "data",
  },
  json: {
    label: "JSON",
    description: "Parse and manipulate JSON data with structural operations.",
    icon: "📦",
    category: "data",
    bucket: "data",
  },
  crypto_wallet: {
    label: "Crypto Wallet",
    description: "Check balances and transfer crypto via a wallet (ETH, BTC, Solana).",
    icon: "₿",
    category: "data",
    bucket: "data",
  },
  paypal: {
    label: "PayPal",
    description: "Send and receive payments and check transactions via PayPal.",
    icon: "💸",
    category: "data",
    bucket: "lain",
  },
  stripe: {
    label: "Stripe",
    description: "Create invoices, check transactions, and manage subscriptions via Stripe.",
    icon: "💳",
    category: "data",
    bucket: "lain",
  },

  /* ── Default for completely-unknown ─────────────────────────────── */
  unknown: {
    label: "Other Tool",
    description: "An additional tool not yet listed in the capability catalog.",
    icon: "🧩",
    category: "lain",
    bucket: "lain",
  },
};

/* ── Skill name translation ──────────────────────────────────────────── */
/*
 * Skills come from agentskills.io ecosystem. Keys use bare name
 * (translateSkill strips brand prefix too).
 */

export const SKILL_VOCAB: Record<string, VocabEntry> = {
  kanban: {
    label: "Quest Board Manager",
    description: "Teaches the agent to manage a SQLite task board — list, create, assign, and complete tasks.",
    icon: "📋",
    category: "produktivitas",
    bucket: "agen-tools",
  },
  "session-forensics": {
    label: "Session Recovery",
    description: "Recover lost context, locate files, and trace progress across disconnected sessions.",
    icon: "🔍",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  agent: {
    label: "Self-Knowledge",
    description: "The agent's self-knowledge about itself and the AgentBuff platform.",
    icon: "🤖",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  "computational-tasks": {
    label: "Math & Computation",
    description: "Handles arithmetic, complex math, and on-the-fly Python scripting.",
    icon: "🧮",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  buff: {
    label: "Buff Knowledge",
    description: "Agent self-knowledge — info about itself and the AgentBuff platform.",
    icon: "🤖",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  "writing-style": {
    label: "Writing Style",
    description: "Write with a consistent style/tone — formal, casual, or any custom voice.",
    icon: "✍️",
    category: "kreatif",
    bucket: "kreatif",
  },
  "code-review": {
    label: "Code Review",
    description: "Review code — find bugs, improve readability, and suggest refactoring.",
    icon: "🔬",
    category: "developer",
    bucket: "developer",
  },
  "data-analysis": {
    label: "Data Analysis",
    description: "Analyze datasets — statistics, visualization, and pattern insights.",
    icon: "📊",
    category: "data",
    bucket: "data",
  },
  research: {
    label: "Deep Research",
    description: "Multi-source research — gather information from the web, cross-check, and summarize.",
    icon: "🔬",
    category: "riset",
    bucket: "data",
  },
};

/* ── Plugin name translation ─────────────────────────────────────────── */
/*
 * Plugin keys (translatePlugin strips brand prefix too).
 */

export const PLUGIN_VOCAB: Record<string, VocabEntry> = {
  multimodal: {
    label: "Universal Multimodal",
    description:
      "Enables the agent to handle voice, images, video, and documents with automatic multi-provider fallback.",
    icon: "🎭",
    category: "kreatif",
    bucket: "kreatif",
  },
  "agentbuff-multimodal": {
    label: "Universal Multimodal",
    description:
      "Enables the agent to handle voice, images, video, and documents with automatic multi-provider fallback.",
    icon: "🎭",
    category: "kreatif",
    bucket: "kreatif",
  },
  achievements: {
    label: "Achievement System",
    description: "Gamification engine — Steam-style achievements when the agent hits milestones.",
    icon: "🏆",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  kanban: {
    label: "Quest Board (Plugin)",
    description: "Integrated multi-agent collaboration board — drag-and-drop task UI in the dashboard.",
    icon: "📋",
    category: "produktivitas",
    bucket: "agen-tools",
  },
  "example-dashboard": {
    label: "Example Dashboard",
    description: "Reference example plugin for developers — a template for building your own dashboard.",
    icon: "📊",
    category: "developer",
    bucket: "developer",
  },
  context_engine: {
    label: "Context Engine",
    description: "Automatically optimizes the context window — keeps the agent focused on relevant information.",
    icon: "🧮",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  image_gen: {
    label: "Image Generation",
    description: "Generate images using multiple backends (OpenAI / xAI / Codex / Imagen).",
    icon: "🎨",
    category: "kreatif",
    bucket: "kreatif",
  },
  video_gen: {
    label: "Video Generation",
    description: "Generate videos using multiple backends (Gemini Veo / Qwen / Moonshot).",
    icon: "🎬",
    category: "kreatif",
    bucket: "kreatif",
  },
  memory: {
    label: "Memory Provider",
    description: "Long-term memory backend — honcho, hindsight, mem0, and more.",
    icon: "🧠",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  "model-providers": {
    label: "Model Providers",
    description: "Additional LLM provider backends — adds more engine model options.",
    icon: "🧠",
    category: "developer",
    bucket: "developer",
  },
  observability: {
    label: "Observability",
    description: "Logs, traces, and metrics for debugging your agent — Langfuse, OpenTelemetry, and more.",
    icon: "📈",
    category: "developer",
    bucket: "developer",
  },
  platforms: {
    label: "Channel Adapters",
    description: "Adapters for additional messaging channels (WhatsApp/Discord/etc.).",
    icon: "📡",
    category: "komunikasi",
    bucket: "komunikasi",
  },
  spotify: {
    label: "Spotify",
    description: "Control Spotify playback and access your library.",
    icon: "🎵",
    category: "kreatif",
    bucket: "lain",
  },
  teams_pipeline: {
    label: "Teams Pipeline",
    description: "Multi-agent / multi-team workflow pipeline — orchestrate complex agent workflows.",
    icon: "👥",
    category: "agen-tools",
    bucket: "agen-tools",
  },
  web: {
    label: "Web Tools",
    description: "Web search, fetch, and extract plugin — a complete set of internet tools in one.",
    icon: "🌐",
    category: "riset",
    bucket: "data",
  },
  google_meet: {
    label: "Google Meet",
    description: "Google Meet integration — automatically schedule and join meetings.",
    icon: "📹",
    category: "komunikasi",
    bucket: "komunikasi",
  },
  "disk-cleanup": {
    label: "Disk Cleanup",
    description: "Clean cache and old files from the container volume to keep disk usage in check.",
    icon: "🧹",
    category: "produktivitas",
    bucket: "agen-tools",
  },
};

/* ── Category & bucket labels ────────────────────────────────────────────── */

export const CATEGORY_LABEL: Record<CapabilityCategory, string> = {
  produktivitas: "Productivity",
  kreatif: "Creative",
  komunikasi: "Communication",
  "agen-tools": "Agent Tools",
  developer: "Developer",
  riset: "Research",
  otomasi: "Automation",
  data: "Data & Files",
  lain: "Other",
};

export const BUCKET_LABEL: Record<CapabilityBucket, string> = {
  data: "📊 Data & Files",
  kreatif: "🎨 Creative",
  komunikasi: "💬 Communication",
  "agen-tools": "🤖 Agent Tools",
  developer: "💻 Developer",
  lain: "🧩 Other",
};

/**
 * SKILL_CATEGORY_META — maps the engine's per-skill `source` field
 * (skills.status row.source, e.g. "mlops", "creative", "finance") to a
 * mass-market Bahasa label + emoji for the categorized skill browser.
 *
 * `source` = the bundled-skill folder name (skills/<source>/<skill>), so it's
 * stable + complete. Unknown sources humanize via skillCategoryMeta(). Keys
 * are lowercase to match the engine.
 */
export const SKILL_CATEGORY_META: Record<string, { label: string; icon: string }> = {
  mlops: { label: "AI & Machine Learning", icon: "🧠" },
  creative: { label: "Creative & Design", icon: "🎨" },
  productivity: { label: "Productivity", icon: "⚡" },
  research: { label: "Research", icon: "🔬" },
  "software-development": { label: "Coding & Software", icon: "💻" },
  finance: { label: "Finance", icon: "💰" },
  "autonomous-ai-agents": { label: "Autonomous Agents", icon: "🤖" },
  devops: { label: "DevOps & Server", icon: "🔧" },
  github: { label: "GitHub", icon: "🐙" },
  media: { label: "Media & Video", icon: "🎬" },
  security: { label: "Security", icon: "🔒" },
  blockchain: { label: "Blockchain & Web3", icon: "⛓️" },
  mcp: { label: "Connectors (MCP)", icon: "🔌" },
  email: { label: "Email", icon: "📧" },
  general: { label: "General", icon: "📦" },
  health: { label: "Health", icon: "🏥" },
  gaming: { label: "Gaming", icon: "🎮" },
  dogfood: { label: "Internal Tools", icon: "🛠️" },
  "red-teaming": { label: "Red Team & Pentest", icon: "🎯" },
  "data-science": { label: "Data Science", icon: "📊" },
  "note-taking": { label: "Notes", icon: "📝" },
  communication: { label: "Communication", icon: "💬" },
  migration: { label: "Data Migration", icon: "🚚" },
  "smart-home": { label: "Smart Home", icon: "🏠" },
  "web-development": { label: "Web Development", icon: "🌐" },
  "social-media": { label: "Social Media", icon: "📱" },
  domain: { label: "Domain & DNS", icon: "🌍" },
  apple: { label: "Apple & macOS", icon: "🍎" },
  diagramming: { label: "Diagramming", icon: "📐" },
  gifs: { label: "GIF & Sticker", icon: "🎞️" },
  yuanbao: { label: "Chat Assistant", icon: "💬" },
};

/** Friendly {label, icon} for a skill `source` category. Humanizes unknowns. */
export function skillCategoryMeta(source: string): { label: string; icon: string } {
  const key = (source || "general").trim().toLowerCase();
  const hit = SKILL_CATEGORY_META[key];
  if (hit) return hit;
  const label =
    key
      .replace(/[-_]+/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .trim() || "Other";
  return { label, icon: "📚" };
}

/* ── Lookup helpers ──────────────────────────────────────────────────── */

const GENERIC_PREFIX = /^(mcp|plugin|channel):/i;
const BRAND_PREFIX = /^(hermes|agentbuff|buff|claw|openclaw)[_-]/i;

/** Strip generic + brand prefixes; returns the bare lookup key. */
export function bareKey(name: string): string {
  const noGeneric = name.replace(GENERIC_PREFIX, "");
  const noBrand = noGeneric.replace(BRAND_PREFIX, "");
  return noBrand.toLowerCase();
}

/** Translate a Hermes toolset name. Returns fallback if unknown. */
export function translateToolset(name: string): VocabEntry {
  const lower = name.toLowerCase();
  const bare = bareKey(name);
  return (
    TOOLSET_VOCAB[bare] ??
    TOOLSET_VOCAB[lower] ??
    TOOLSET_VOCAB[bare.replace(/-/g, "_")] ??
    TOOLSET_VOCAB[bare.replace(/_/g, "-")] ??
    fallbackEntry(name)
  );
}

/** Translate a skill name. */
export function translateSkill(name: string): VocabEntry {
  const lower = name.toLowerCase();
  const bare = bareKey(name);
  return (
    SKILL_VOCAB[bare] ??
    SKILL_VOCAB[lower] ??
    SKILL_VOCAB[name] ??
    fallbackEntry(name)
  );
}

/* ── Skill setup-requirement catalog ───────────────────────────────────
 * Grounded metadata read from every bundled/optional SKILL.md (frontmatter +
 * body) — see skill-meta-data.json. The engine's skills.status does NOT surface
 * structured requirements (all rows report requirements:[], eligible:true even
 * for skills that clearly need an API key), so this catalog is the source of
 * truth for: a clearer Bahasa description, the "BUTUH SETUP" badge, the setup
 * tutorial, and the wizard default-off rule (setup-needed skills start OFF).
 * Generated by a SKILL.md reader — regenerate after a Hermes skill-set bump.
 */
export type SkillSetupKind =
  | "api-key"
  | "cli"
  | "account"
  | "oauth"
  | "mcp"
  | "cloud";

export type SkillSetup = {
  label: string;
  kind: SkillSetupKind;
  envKey: string | null;
  steps: string[];
  chatPrompt?: string;
  docsUrl?: string | null;
};

export type SkillMeta = {
  name: string;
  source: string;
  descId: string;
  needsSetup: boolean;
  setup: SkillSetup | null;
};

const SKILL_META_BY_NAME: Record<string, SkillMeta> = (() => {
  const out: Record<string, SkillMeta> = {};
  const list = (skillMetaRaw as { skills?: SkillMeta[] }).skills ?? [];
  for (const s of list) {
    if (!s || !s.name) continue;
    out[s.name.toLowerCase()] = s;
    // also index by bare key so `agentbuff-x` / `hermes-x` resolve
    const bk = bareKey(s.name);
    if (bk && !(bk in out)) out[bk] = s;
  }
  return out;
})();

/** Lookup the grounded setup-meta for a skill name. null if unknown. */
export function skillMeta(name: string): SkillMeta | null {
  return (
    SKILL_META_BY_NAME[name.toLowerCase()] ??
    SKILL_META_BY_NAME[bareKey(name)] ??
    null
  );
}

/** True when the skill needs external setup (creds/CLI/account) to work. */
export function skillNeedsSetup(name: string): boolean {
  return skillMeta(name)?.needsSetup === true;
}

/**
 * Best Bahasa description for a skill: prefer the grounded catalog `descId`,
 * fall back to the vocab translation, then to the engine-provided raw text.
 */
export function skillDescription(name: string, rawFallback?: string): string {
  const meta = skillMeta(name);
  if (meta?.descId) return meta.descId;
  const v = translateSkill(name);
  if (v.description && !v.description.startsWith("Additional agent capability"))
    return v.description;
  return rawFallback || v.description;
}

/** Translate a plugin key. */
export function translatePlugin(name: string): VocabEntry {
  const lower = name.toLowerCase();
  const bare = bareKey(name);
  return (
    PLUGIN_VOCAB[bare] ??
    PLUGIN_VOCAB[lower] ??
    PLUGIN_VOCAB[name] ??
    fallbackEntry(name)
  );
}

/**
 * Last-resort humanizer for completely-unknown names.
 *
 * Strips brand/generic prefixes, title-cases the rest, and uses
 * keyword regex to assign a meaningful icon + bucket + description.
 * Always returns a non-generic description (no more "Tambahan kemampuan
 * agen — X" wording — that was the failure mode users complained about).
 *
 * IMPORTANT: keyword regex runs against the BARE name (prefix stripped),
 * not the raw lowercase. Otherwise `agentbuff-webhook` would falsely
 * trigger /agent/ and get a "Sub-Agen" description.
 */
const _fallbackCache = new Map<string, VocabEntry>();

function fallbackEntry(name: string): VocabEntry {
  // Memoize: same name → same entry (pure data). Avoids re-running the ~35
  // regex branches below on every render/keystroke for unknown names.
  const cached = _fallbackCache.get(name);
  if (cached) return cached;

  // Humanize: strip prefixes, replace _/- with space, title case
  const cleaned = name
    .replace(GENERIC_PREFIX, "")
    .replace(BRAND_PREFIX, "")
    .replace(/[_-]+/g, " ")
    .trim();
  const label = cleaned
    .split(" ")
    .map((w) => (w.length === 0 ? w : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");

  // Use BARE key (no brand prefix) for keyword matching so `agentbuff-X`
  // doesn't trigger the /agent/ pattern.
  const lower = bareKey(name);
  let description = `Additional agent capability — "${label}".`;
  let icon = "🧩";
  let bucket: CapabilityBucket = "lain";
  let category: CapabilityCategory = "lain";

  // Order matters: more-specific patterns first
  if (/\bocr\b|scan/.test(lower)) {
    description = `Scan / OCR — extract text from images or documents via ${label}.`;
    icon = "📷";
    bucket = "data";
    category = "data";
  } else if (/translate|translation|terjemah/.test(lower)) {
    description = `Translate text between languages via ${label}.`;
    icon = "🌍";
    bucket = "kreatif";
    category = "kreatif";
  } else if (/email|mail|smtp|imap|gmail|outlook/.test(lower)) {
    description = `Read and send emails via ${label}.`;
    icon = "📧";
    bucket = "komunikasi";
    category = "komunikasi";
  } else if (/sms|whatsapp|telegram|discord|slack|signal|wechat|line|viber|messenger|chat|message/.test(lower)) {
    description = `Send and receive messages via ${label}.`;
    icon = "💬";
    bucket = "komunikasi";
    category = "komunikasi";
  } else if (/calendar|schedule|cron|reminder|alarm|appointment/.test(lower)) {
    description = `Manage schedules, reminders, and calendar events via ${label}.`;
    icon = "⏰";
    bucket = "agen-tools";
    category = "produktivitas";
  } else if (/payment|invoice|finance|money|currency|stripe|midtrans|paypal|billing/.test(lower)) {
    description = `Finance / billing tools via ${label}.`;
    icon = "💸";
    bucket = "data";
    category = "data";
  } else if (/database|postgres|mysql|sqlite|mongo|redis|sql|db\b/.test(lower)) {
    description = `Query and manage databases via ${label}.`;
    icon = "🗄️";
    bucket = "data";
    category = "data";
  } else if (/search|find|google|brave|duckduckgo|bing|cari/.test(lower)) {
    description = `Search the web for information via ${label}.`;
    icon = "🔍";
    bucket = "data";
    category = "riset";
  } else if (/scrape|crawl|extract|parse/.test(lower)) {
    description = `Scrape and extract data from the web via ${label}.`;
    icon = "🕸️";
    bucket = "data";
    category = "riset";
  } else if (/voice|audio|speech|tts|stt|whisper|elevenlabs/.test(lower)) {
    description = `Voice tools — text-to-speech, speech-to-text, or audio processing via ${label}.`;
    icon = "🎙️";
    bucket = "kreatif";
    category = "kreatif";
  } else if (/image|photo|picture|gambar|art|design|paint|figma|canva|dall|midjourney|flux/.test(lower)) {
    description = `Create and edit image content via ${label}.`;
    icon = "🎨";
    bucket = "kreatif";
    category = "kreatif";
  } else if (/video|youtube|vimeo|tiktok|reels|movie/.test(lower)) {
    description = `Create and edit video content via ${label}.`;
    icon = "🎬";
    bucket = "kreatif";
    category = "kreatif";
  } else if (/file|doc|drive|note|notion|obsidian|markdown|pdf|word|excel|sheet/.test(lower)) {
    description = `Access and manage files and documents via ${label}.`;
    icon = "📁";
    bucket = "data";
    category = "produktivitas";
  } else if (/git|github|gitlab|repo|commit|branch|merge|pr\b/.test(lower)) {
    description = `Manage version control and code repositories via ${label}.`;
    icon = "🌿";
    bucket = "developer";
    category = "developer";
  } else if (/debug|trace|log|metrics|observ|monitor/.test(lower)) {
    description = `Monitoring, debugging, and observability via ${label}.`;
    icon = "🐛";
    bucket = "developer";
    category = "developer";
  } else if (/code|script|python|javascript|typescript|java|go\b|rust|bash|shell|exec/.test(lower)) {
    description = `Developer tools / code execution via ${label}.`;
    icon = "💻";
    bucket = "developer";
    category = "developer";
  } else if (/docker|container|kubernetes|k8s|deploy/.test(lower)) {
    description = `Manage containers and deployments via ${label}.`;
    icon = "🐳";
    bucket = "developer";
    category = "developer";
  } else if (/memory|recall|remember|context|embedding|vector/.test(lower)) {
    description = `Manage the agent's long-term memory and context via ${label}.`;
    icon = "🧠";
    bucket = "agen-tools";
    category = "agen-tools";
  } else if (/agent|sub.?agent|delegate|spawn|team|guild/.test(lower)) {
    description = `Manage sub-agent teams and multi-agent collaboration via ${label}.`;
    icon = "👥";
    bucket = "agen-tools";
    category = "agen-tools";
  } else if (/task|todo|plan|kanban|board|project|sprint/.test(lower)) {
    description = `Manage tasks and projects via ${label}.`;
    icon = "📋";
    bucket = "agen-tools";
    category = "produktivitas";
  } else if (/web|browser|url|http|fetch|api\b/.test(lower)) {
    description = `Access the internet / HTTP APIs via ${label}.`;
    icon = "🌐";
    bucket = "data";
    category = "riset";
  } else if (/home|iot|smart|sensor|light|hue|nest/.test(lower)) {
    description = `Control smart home / IoT devices via ${label}.`;
    icon = "🏠";
    bucket = "lain";
    category = "otomasi";
  } else if (/music|spotify|playlist|song|track/.test(lower)) {
    description = `Control music and playlists via ${label}.`;
    icon = "🎵";
    bucket = "lain";
    category = "kreatif";
  } else if (/news|rss|feed/.test(lower)) {
    description = `Read news and RSS feeds via ${label}.`;
    icon = "📰";
    bucket = "data";
    category = "riset";
  } else if (/weather|cuaca/.test(lower)) {
    description = `Check weather and forecasts via ${label}.`;
    icon = "🌦️";
    bucket = "lain";
    category = "lain";
  } else if (/map|location|geo|navig/.test(lower)) {
    description = `Access maps, locations, and navigation via ${label}.`;
    icon = "🗺️";
    bucket = "lain";
    category = "lain";
  } else if (/crypto|bitcoin|eth|blockchain|wallet/.test(lower)) {
    description = `Crypto / blockchain tools via ${label}.`;
    icon = "₿";
    bucket = "data";
    category = "data";
  } else if (/shop|store|commerce|order|product|cart|checkout/.test(lower)) {
    description = `Manage store orders and products via ${label}.`;
    icon = "🛒";
    bucket = "lain";
    category = "produktivitas";
  } else if (/server|gateway|proxy|cluster|host/.test(lower)) {
    description = `Manage server infrastructure via ${label} (internal engine).`;
    icon = "🛰️";
    bucket = "developer";
    category = "developer";
  } else if (/sandbox|safe|secure/.test(lower)) {
    description = `Sandbox / secure environment execution via ${label}.`;
    icon = "🛡️";
    bucket = "developer";
    category = "developer";
  } else if (/cli|terminal|command/.test(lower)) {
    description = `Access the CLI / command-line via ${label}.`;
    icon = "⌨️";
    bucket = "developer";
    category = "developer";
  }

  const entry: VocabEntry = {
    label,
    description,
    icon,
    category,
    bucket,
  };
  _fallbackCache.set(name, entry);
  return entry;
}

/** Get bucket label for grouping. */
export function bucketLabel(bucket: CapabilityBucket): string {
  return BUCKET_LABEL[bucket] ?? BUCKET_LABEL.lain;
}
