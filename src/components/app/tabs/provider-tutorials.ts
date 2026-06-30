/**
 * In-UI step-by-step tutorials so non-developer users can connect ANY provider
 * without reading the provider's docs. Keyed by env-var key (API keys) and by
 * OAuth provider id. Every entry gives concrete, numbered steps in Bahasa.
 *
 * Fallback: a key without a bespoke entry still gets a helpful generic tutorial
 * built from its pretty name + official URL (never just "baca dokumentasi").
 */

export type Tutorial = {
  /** Heading shown above the steps, e.g. "Cara dapetin kunci OpenRouter". */
  title: string;
  /** Numbered steps. Keep each short + action-first. */
  steps: string[];
  /** Official link to open (button). */
  url?: string;
  urlLabel?: string;
  /** Optional one-line note (pricing model, gotcha, etc.). */
  note?: string;
};

// ── API-key providers (keyed by env var) ───────────────────────────────────
const KEY: Record<string, Tutorial> = {
  GEMINI_API_KEY: {
    title: "Cara dapetin kunci Gemini (Google)",
    steps: [
      "Buka Google AI Studio (tombol di bawah) lalu login pakai akun Google kamu.",
      "Klik tombol “Get API key” / “Buat kunci API”.",
      "Pilih “Create API key in new project” (atau project yang ada).",
      "Salin kunci yang muncul (diawali AIza…).",
      "Balik ke sini, tempel kunci, klik Simpan.",
    ],
    url: "https://aistudio.google.com/app/apikey",
    urlLabel: "Buka Google AI Studio",
    note: "Perlu akun billing Google untuk pemakaian nyata — model Flash-nya terjangkau.",
  },
  GOOGLE_API_KEY: {
    title: "Cara dapetin kunci Google AI",
    steps: [
      "Buka Google AI Studio (tombol di bawah), login akun Google.",
      "Klik “Get API key” → “Create API key”.",
      "Salin kunci (AIza…) dan tempel di sini.",
    ],
    url: "https://aistudio.google.com/app/apikey",
    urlLabel: "Buka Google AI Studio",
  },
  OPENROUTER_API_KEY: {
    title: "Cara dapetin kunci OpenRouter",
    steps: [
      "Buka openrouter.ai (tombol di bawah) → Sign in (bisa pakai Google/GitHub).",
      "Klik foto profil → “Keys” (atau buka /keys).",
      "Klik “Create Key”, beri nama bebas, lalu “Create”.",
      "Salin kunci (sk-or-…) dan tempel di sini.",
    ],
    url: "https://openrouter.ai/keys",
    urlLabel: "Buka OpenRouter Keys",
    note: "Satu kunci buat akses BANYAK model sekaligus.",
  },
  DEEPSEEK_API_KEY: {
    title: "Cara dapetin kunci DeepSeek",
    steps: [
      "Buka platform.deepseek.com (tombol di bawah) → daftar/login.",
      "Di menu kiri pilih “API keys”.",
      "Klik “Create new API key”, beri nama, “Create”.",
      "Salin kunci (sk-…) — hanya muncul sekali — tempel di sini.",
    ],
    url: "https://platform.deepseek.com/api_keys",
    urlLabel: "Buka DeepSeek Platform",
  },
  ANTHROPIC_API_KEY: {
    title: "Cara dapetin API key Anthropic (Claude)",
    steps: [
      "Buka console.anthropic.com (tombol di bawah) → login.",
      "Buka Settings → “API Keys”.",
      "Klik “Create Key”, beri nama, “Create”.",
      "Salin kunci (sk-ant-…) dan tempel di sini.",
    ],
    url: "https://console.anthropic.com/settings/keys",
    urlLabel: "Buka Anthropic Console",
    note: "Pakai kredit (mahal). Kalau punya langganan Claude, pakai “Login Browser” di atas.",
  },
  XAI_API_KEY: {
    title: "Cara dapetin kunci xAI (Grok)",
    steps: [
      "Buka console.x.ai (tombol di bawah) → login akun X/xAI.",
      "Buka “API Keys” → “Create API Key”.",
      "Salin kunci (xai-…) dan tempel di sini.",
    ],
    url: "https://console.x.ai",
    urlLabel: "Buka xAI Console",
  },
  DASHSCOPE_API_KEY: {
    title: "Cara dapetin kunci Qwen (DashScope)",
    steps: [
      "Buka konsol DashScope/Bailian (tombol di bawah) → login akun Alibaba Cloud.",
      "Cari menu “API-KEY” / “API Keys”.",
      "Klik “Create API Key”, salin kunci (sk-…).",
      "Tempel di sini.",
    ],
    url: "https://bailian.console.alibabacloud.com/?apiKey=1",
    urlLabel: "Buka DashScope",
    note: "Untuk Qwen lewat langganan gratis, pakai “Qwen (CLI)” di bagian Login OAuth.",
  },
  KIMI_API_KEY: {
    title: "Cara dapetin kunci Kimi (Moonshot)",
    steps: [
      "Buka platform.moonshot.ai (tombol di bawah) → daftar/login.",
      "Buka “API Keys” → “Create”.",
      "Salin kunci (sk-…) dan tempel di sini.",
    ],
    url: "https://platform.moonshot.ai/console/api-keys",
    urlLabel: "Buka Moonshot",
  },
  GLM_API_KEY: {
    title: "Cara dapetin kunci GLM (Zhipu)",
    steps: [
      "Buka open.bigmodel.cn (tombol di bawah) → login.",
      "Buka menu “API Keys”, klik buat kunci baru.",
      "Salin kunci dan tempel di sini.",
    ],
    url: "https://open.bigmodel.cn/usercenter/apikeys",
    urlLabel: "Buka Zhipu BigModel",
  },
  ZAI_API_KEY: {
    title: "Cara dapetin kunci Z.AI",
    steps: [
      "Buka z.ai (tombol di bawah) → login.",
      "Buka pengaturan API Keys → buat kunci.",
      "Salin & tempel di sini.",
    ],
    url: "https://z.ai/manage-apikey/apikey-list",
    urlLabel: "Buka Z.AI",
  },
  MINIMAX_API_KEY: {
    title: "Cara dapetin kunci MiniMax",
    steps: [
      "Buka platform.minimax.io (tombol di bawah) → login.",
      "Buka “API Keys” → buat kunci baru.",
      "Salin & tempel di sini.",
    ],
    url: "https://platform.minimax.io/user-center/basic-information/interface-key",
    urlLabel: "Buka MiniMax",
    note: "Kalau mau pakai langganan, pakai “MiniMax (OAuth)” di bagian Login.",
  },
  NVIDIA_API_KEY: {
    title: "Cara dapetin kunci NVIDIA NIM",
    steps: [
      "Buka build.nvidia.com (tombol di bawah) → login akun NVIDIA.",
      "Pilih model apa saja → klik “Get API Key” / “Generate Key”.",
      "Salin kunci (nvapi-…) dan tempel di sini.",
    ],
    url: "https://build.nvidia.com",
    urlLabel: "Buka NVIDIA Build",
  },
  NOVITA_API_KEY: {
    title: "Cara dapetin kunci Novita AI",
    steps: [
      "Buka novita.ai (tombol di bawah) → daftar/login.",
      "Buka “Key Management” / API Keys → buat kunci.",
      "Salin & tempel di sini.",
    ],
    url: "https://novita.ai/settings/key-management",
    urlLabel: "Buka Novita",
  },
  LM_API_KEY: {
    title: "Endpoint lokal (LM Studio / OpenAI-compatible)",
    steps: [
      "Jalankan server model di komputermu (mis. LM Studio → tab “Local Server” → Start).",
      "Catat alamatnya, contoh http://localhost:1234/v1.",
      "Isi “Base URL” dengan alamat itu (di VPS pakai host.docker.internal).",
      "Kunci API biasanya boleh dikosongkan kalau server lokal tidak butuh.",
    ],
    note: "Buat model yang kamu host sendiri — gratis, gak butuh kredit.",
  },
  OLLAMA_API_KEY: {
    title: "Ollama (model lokal)",
    steps: [
      "Install + jalankan Ollama di komputermu (ollama serve).",
      "Isi “Base URL” ke alamat Ollama (default http://localhost:11434/v1).",
      "Kunci API boleh dikosongkan.",
    ],
    note: "Model jalan lokal — gratis.",
  },
  STEPFUN_API_KEY: {
    title: "Cara dapetin kunci StepFun",
    steps: [
      "Buka platform.stepfun.com (tombol di bawah) → daftar/login.",
      "Masuk ke menu “接口密钥 / API Keys”.",
      "Klik buat kunci baru, lalu salin.",
      "Tempel di sini.",
    ],
    url: "https://platform.stepfun.com/",
    urlLabel: "Buka StepFun",
  },
  GMI_API_KEY: {
    title: "Cara dapetin kunci GMI Cloud",
    steps: [
      "Buka gmicloud.ai (tombol di bawah) → daftar/login.",
      "Buka Console → menu “API Keys”.",
      "Klik “Create” / buat kunci baru, salin.",
      "Tempel di sini.",
    ],
    url: "https://www.gmicloud.ai/",
    urlLabel: "Buka GMI Cloud",
  },
  ARCEEAI_API_KEY: {
    title: "Cara dapetin kunci Arcee AI",
    steps: [
      "Buka chat.arcee.ai (tombol di bawah) → login.",
      "Buka pengaturan akun → “API Keys”.",
      "Buat kunci baru, salin, tempel di sini.",
    ],
    url: "https://chat.arcee.ai/",
    urlLabel: "Buka Arcee AI",
  },
  KILOCODE_API_KEY: {
    title: "Cara dapetin kunci KiloCode",
    steps: [
      "Buka kilocode.ai (tombol di bawah) → daftar/login.",
      "Buka Dashboard → menu “API Keys”.",
      "Klik buat kunci baru, salin, tempel di sini.",
    ],
    url: "https://kilocode.ai/",
    urlLabel: "Buka KiloCode",
  },
  XIAOMI_API_KEY: {
    title: "Cara dapetin kunci Xiaomi MiMo",
    steps: [
      "Buka platform.xiaomimimo.com (tombol di bawah) → login.",
      "Buka menu API Keys di pengaturan akun.",
      "Buat kunci baru, salin, tempel di sini.",
    ],
    url: "https://platform.xiaomimimo.com",
    urlLabel: "Buka Xiaomi MiMo",
  },
  KIMI_CN_API_KEY: {
    title: "Cara dapetin kunci Kimi · Moonshot (China)",
    steps: [
      "Buka platform.moonshot.cn (tombol di bawah) — versi China, login akun Moonshot CN.",
      "Masuk ke “用户中心 → API Key 管理”.",
      "Klik “新建” (buat baru), salin kunci (sk-…).",
      "Tempel di sini.",
    ],
    url: "https://platform.moonshot.cn/",
    urlLabel: "Buka Moonshot (China)",
    note: "Ini endpoint China. Untuk global, pakai kartu “Kimi · Moonshot (Global)”.",
  },
  KIMI_CODING_API_KEY: {
    title: "Cara dapetin kunci Kimi Coding",
    steps: [
      "Buka platform.moonshot.ai (tombol di bawah) → login.",
      "Aktifkan paket coding (Kimi for Coding) bila diminta.",
      "Buka “API Keys” → buat kunci, salin.",
      "Tempel di sini.",
    ],
    url: "https://platform.moonshot.ai/",
    urlLabel: "Buka Moonshot",
    note: "Khusus paket coding Kimi.",
  },
  MINIMAX_CN_API_KEY: {
    title: "Cara dapetin kunci MiniMax (China)",
    steps: [
      "Buka minimaxi.com (tombol di bawah) — versi China, login.",
      "Buka “接口密钥 / API Keys”.",
      "Buat kunci baru, salin, tempel di sini.",
    ],
    url: "https://www.minimaxi.com/",
    urlLabel: "Buka MiniMax (China)",
    note: "Endpoint China. Untuk global pakai kartu “MiniMax (Global)”.",
  },
  OPENCODE_ZEN_API_KEY: {
    title: "Cara dapetin kunci OpenCode Zen",
    steps: [
      "Buka opencode.ai/auth (tombol di bawah) → daftar/login.",
      "Buka dashboard → bagian “API Keys” / “Zen”.",
      "Buat kunci, salin, tempel di sini.",
    ],
    url: "https://opencode.ai/auth",
    urlLabel: "Buka OpenCode",
    note: "Model OpenCode Zen — bayar per-pakai.",
  },
  OPENCODE_GO_API_KEY: {
    title: "Cara dapetin kunci OpenCode Go",
    steps: [
      "Buka opencode.ai/auth (tombol di bawah) → daftar/login.",
      "Ambil langganan “Go” ($10/bln) bila diminta.",
      "Buka “API Keys”, buat kunci, salin, tempel di sini.",
    ],
    url: "https://opencode.ai/auth",
    urlLabel: "Buka OpenCode",
    note: "Langganan OpenCode Go — $10/bln untuk model open.",
  },
  ALIBABA_CODING_PLAN_API_KEY: {
    title: "Cara dapetin kunci Alibaba (Coding Plan)",
    steps: [
      "Buka Alibaba Cloud Model Studio / Bailian (tombol di bawah) → login.",
      "Aktifkan paket coding (Qwen Coding Plan).",
      "Buka “API-KEY” → buat kunci (sk-…), salin.",
      "Tempel di sini.",
    ],
    url: "https://bailian.console.alibabacloud.com/?apiKey=1",
    urlLabel: "Buka Alibaba Model Studio",
  },
  AZURE_FOUNDRY_API_KEY: {
    title: "Cara dapetin kunci Azure AI Foundry",
    steps: [
      "Buka ai.azure.com (tombol di bawah) → login akun Azure.",
      "Buat/buka sebuah Project, lalu Deploy model yang kamu mau.",
      "Di halaman deployment, salin “Key” dan “Endpoint”.",
      "Tempel Key di sini; isi “Base URL” dengan Endpoint-nya.",
    ],
    url: "https://ai.azure.com/",
    urlLabel: "Buka Azure AI Foundry",
    note: "Azure agak teknis — butuh akun Azure + deploy model dulu.",
  },
};

// ── OAuth providers (keyed by provider id) ──────────────────────────────────
const OAUTH: Record<string, Tutorial> = {
  anthropic: {
    title: "Login Anthropic (Claude) via browser",
    steps: [
      "Klik “Hubungkan” — sebuah link login Claude akan muncul.",
      "Buka link itu di browser, lalu login ke akun Anthropic/Claude kamu.",
      "Klik “Authorize” untuk mengizinkan AgentBuff.",
      "Anthropic akan menampilkan sebuah KODE — salin kode itu.",
      "Balik ke sini, tempel kode di kotak, klik Kirim. Selesai!",
    ],
    note: "Pakai akun Claude kamu langsung — gak perlu nyetel API key manual.",
  },
  nous: {
    title: "Login Nous Portal — GRATIS (kode perangkat)",
    steps: [
      "Klik “Login” — akan muncul tombol link + sebuah kode perangkat.",
      "Buka link itu di browser, lalu daftar/login ke Nous Portal (gratis).",
      "Kalau diminta, masukkan kode perangkat yang ditampilkan di sini.",
      "Klik Authorize. AgentBuff otomatis mendeteksi saat sudah disetujui — beres!",
    ],
    note: "Nous Portal kasih kredit GRATIS untuk akun baru — cukup daftar & login, langsung bisa dipakai tanpa bayar atau kartu kredit.",
  },
  "openai-codex": {
    title: "Login OpenAI Codex (ChatGPT)",
    steps: [
      "Klik “Hubungkan” — muncul link auth.openai.com + kode.",
      "Buka link di browser, login ke akun ChatGPT kamu.",
      "Masukkan/konfirmasi kode lalu Authorize.",
      "AgentBuff otomatis terhubung saat disetujui.",
    ],
    note: "Butuh akses Codex di langganan ChatGPT (Plus/Pro/Team).",
  },
  "minimax-oauth": {
    title: "Login MiniMax (kode perangkat)",
    steps: [
      "Klik “Hubungkan” — muncul link + kode perangkat.",
      "Buka link di browser, login ke akun MiniMax kamu.",
      "Masukkan kode bila diminta, lalu Authorize.",
      "AgentBuff otomatis terhubung saat disetujui.",
    ],
  },
  "claude-code": {
    title: "Hubungkan langganan Claude Code (sekali setup)",
    steps: [
      "Di KOMPUTER kamu, install Claude Code: buka terminal lalu jalankan  npm install -g @anthropic-ai/claude-code",
      "Jalankan perintah:  claude setup-token",
      "Browser akan terbuka — login ke akun Claude (Pro/Max) kamu & izinkan.",
      "Terminal akan menampilkan sebuah TOKEN panjang — salin semuanya.",
      "Balik ke sini, tempel token itu, klik Hubungkan. Cukup sekali — setelah ini PC kamu boleh dimatikan.",
    ],
    note: "Pakai langganan Claude (flat), bukan kredit API. Token disimpan aman di container & auto-refresh.",
  },
  "qwen-oauth": {
    title: "Hubungkan langganan Qwen (sekali setup)",
    steps: [
      "Di KOMPUTER kamu, install Qwen Code CLI:  npm install -g @qwen-code/qwen-code",
      "Jalankan  qwen  lalu pilih login — browser terbuka, login akun Qwen kamu.",
      "Setelah berhasil, buka file  ~/.qwen/oauth_creds.json  (Windows: %USERPROFILE%\\.qwen\\oauth_creds.json).",
      "Salin SELURUH isi file itu (mulai dari { sampai }).",
      "Balik ke sini, tempel isinya, klik Hubungkan. Cukup sekali.",
    ],
    note: "Pakai langganan Qwen gratis. Creds disimpan di container & auto-refresh.",
  },
};

/** Build a helpful generic tutorial for a key that has no bespoke entry. */
function genericKeyTutorial(prettyName: string, url?: string | null): Tutorial {
  return {
    title: `Cara dapetin kunci ${prettyName}`,
    steps: [
      `Buka situs resmi ${prettyName} (tombol di bawah), lalu daftar atau login.`,
      "Cari menu “API Keys” / “Keys” / “Developer” di pengaturan akun.",
      "Buat kunci baru (biasanya tombol “Create” / “Generate”).",
      "Salin kunci yang muncul, lalu tempel di sini & Simpan.",
    ],
    url: url ?? undefined,
    urlLabel: `Buka situs ${prettyName}`,
  };
}

export function tutorialForKey(
  key: string,
  prettyName: string,
  url?: string | null,
): Tutorial {
  return KEY[key] ?? genericKeyTutorial(prettyName, url);
}

export function tutorialForOauth(id: string): Tutorial | null {
  return OAUTH[id] ?? null;
}
