"use client";

/**
 * /app/providers — Penyedia AI.
 *
 * Mirrors the engine's /env page EXACTLY (anti-drift): the OAuth logins and the
 * LLM API keys are read straight from the engine's own registries via the
 * bridge, so whatever the engine supports shows up here automatically.
 *
 * Bridge RPCs consumed:
 *   providers.oauthList                       → { providers[] }  (6 canonical)
 *   providers.envCatalog                      → { vars[] }       (LLM key vars)
 *   providers.setEnv      { key, value }       → set any provider env var
 *   providers.deleteEnv   { key }              → delete an env var
 *   providers.oauth.start { provider }         → { flowId }
 *   providers.oauth.poll  { flowId, cursor }   → { status, url, userCode, mode, needsInput, ... }
 *   providers.oauth.relay { flowId, input }    → paste code (pkce / loopback)
 *   providers.oauth.cancel{ flowId }
 *   providers.claudeCreds { token }            → claude-code creds file
 *   providers.qwenCreds   { json }             → qwen oauth_creds.json
 *   providers.oauthDisconnect { id }
 */

import {
  Check,
  Copy,
  Eye,
  EyeOff,
  ExternalLink,
  KeyRound,
  Loader2,
  Lock,
  LogIn,
  Plus,
  RefreshCw,
  ShieldCheck,
  Trash2,
  X,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SectionHeader } from "@/components/app/primitives/section-header";
import { getClient, useAppStore } from "@/lib/app/store";
import { GatewayError } from "@/lib/hermes/browser-gateway";
import { cn } from "@/lib/utils";
import {
  type Tutorial,
  tutorialForKey,
  tutorialForOauth,
} from "./provider-tutorials";

// ── wire types ────────────────────────────────────────────────────────────
type OAuthFlow = "pkce" | "device_code" | "external" | "loopback";
type OAuthProvider = {
  id: string;
  name: string;
  flow: OAuthFlow;
  cliCommand: string;
  docsUrl: string;
  status: {
    loggedIn: boolean;
    sourceLabel?: string | null;
    tokenPreview?: string | null;
    expiresAt?: string | null;
    hasRefreshToken?: boolean;
    error?: string | null;
  };
};
type ProviderCategory = "popular" | "regional" | "coding" | "selfhosted" | "custom";
type EnvVar = {
  key: string;
  canonical?: string;
  isSet: boolean;
  redactedValue?: string | null;
  description: string;
  url?: string | null;
  isPassword: boolean;
  advanced: boolean;
  // Bridge-supplied (2026-06-11) metadata for sectioning + free-tier pill.
  category?: ProviderCategory;
  free?: boolean;
  providerId?: string | null;
  synthetic?: boolean;
};
type PollResult = {
  status: string; // running | success | error | cancelled
  url?: string | null;
  userCode?: string | null;
  mode?: string | null; // device | paste_stdin | loopback
  needsInput?: boolean;
  error?: string | null;
  lines: string[];
  cursor: number;
};

const ACCENT = "from-cyan-400 via-indigo-500 to-fuchsia-500";

// Provider logos (optimized 96px webp, ~1.7KB each, lazy-loaded → page stays light).
const LOGO_BY_BASE: Record<string, string> = {
  GOOGLE: "gemini", GEMINI: "gemini", GLM: "zai", ZAI: "zai", Z: "zai",
  OPENROUTER: "openrouter", DEEPSEEK: "deepseek", ANTHROPIC: "anthropic",
  XAI: "xai", DASHSCOPE: "qwen", KIMI: "kimi", MINIMAX: "minimax",
  NVIDIA: "nvidia", NOVITA: "novita", OLLAMA: "ollama", STEPFUN: "stepfun",
  GMI: "gmi", ARCEEAI: "arcee", KILOCODE: "kilocode", XIAOMI: "xiaomi",
  OPENCODE: "opencode", ALIBABA: "alibaba", AZURE: "azure", LM: "lm",
  OPENAI: "openai", GROQ: "groq", MISTRAL: "mistral", CEREBRAS: "cerebras",
  FIREWORKS: "fireworks",
};
const LOGO_BY_OAUTH: Record<string, string> = {
  anthropic: "anthropic", "claude-code": "claude-code", nous: "nous",
  "openai-codex": "codex", "qwen-oauth": "qwen", "minimax-oauth": "minimax",
  "xai-oauth": "grok",
};
function logoForKey(key: string): string | null {
  const base = key.replace(/_API_KEY$/, "").replace(/_BASE_URL$/, "").split("_")[0];
  const slug = LOGO_BY_BASE[base];
  return slug ? `/images/providers/${slug}.webp` : null;
}
function logoForOauth(id: string): string | null {
  const slug = LOGO_BY_OAUTH[id];
  return slug ? `/images/providers/${slug}.webp` : null;
}

function ProviderLogo({ src, size, fallback }: { src: string | null; size: number; fallback: React.ReactNode }) {
  if (!src) return <>{fallback}</>;
  // Plain <img>: the webp is already tiny + optimized; avoids next/image config.
  // eslint-disable-next-line @next/next/no-img-element
  return (
    <img
      src={src}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
      className="shrink-0 rounded-md object-contain"
      style={{ width: size, height: size }}
    />
  );
}

function rpc<T>(method: string, params?: unknown): Promise<T> {
  const client = getClient();
  if (!client) return Promise.reject(new Error("Belum terhubung ke engine."));
  return client.request<T>(method, params ?? {});
}

function errMsg(e: unknown): string {
  if (e instanceof GatewayError) return e.message || String(e.code);
  if (e instanceof Error) return e.message;
  return "Terjadi kesalahan.";
}

// Saving a key restarts the engine subprocess (~10–30s while it re-scans
// skills). During that window engine-backed RPCs (agents.list / models.list)
// fail transiently — the supervisor reports "subprocess crashed (exit N)",
// "not connected", timeouts, etc. Treat those as "engine is warming up, retry"
// instead of surfacing a scary internal string to the user.
function isEngineWarmingUp(raw: string): boolean {
  const m = (raw || "").toLowerCase();
  return (
    m.includes("crashed") ||
    m.includes("exit ") ||
    m.includes("subprocess") ||
    m.includes("not connected") ||
    m.includes("belum terhubung") ||
    m.includes("restart") ||
    m.includes("not ready") ||
    m.includes("unavailable") ||
    m.includes("timeout") ||
    m.includes("econnreset") ||
    m.includes("engine_down") ||
    m.includes("disconnect")
  );
}

const FLOW_META: Record<OAuthFlow, { label: string; tint: string }> = {
  device_code: { label: "Kode perangkat", tint: "text-cyan-300/80" },
  pkce: { label: "Login browser", tint: "text-indigo-300/80" },
  external: { label: "CLI eksternal", tint: "text-amber-300/80" },
  // loopback (added by Hermes 0.16.0, e.g. xai-oauth): browser login with a
  // local callback — UI-wise the same family as pkce, driven by the bridge
  // OAuthManager relay path (NOT the external/CLI branch).
  loopback: { label: "Login browser", tint: "text-indigo-300/80" },
};

// Neutral fallback so ANY future engine-added flow value can never crash the
// whole Provider tab again (the 0.16.0 "loopback" regression).
const FLOW_FALLBACK = { label: "Login browser", tint: "text-white/70" } as const;

// Exact, unambiguous names for providers that LOOK similar but are genuinely
// different (region / product variant) — so users never see two identical
// labels. Keyed by the env key minus the _API_KEY/_BASE_URL suffix.
const FULL_NAME: Record<string, string> = {
  GOOGLE: "Gemini (Google)",
  GEMINI: "Gemini (Google)",
  GLM: "Z.AI / GLM",
  KIMI: "Kimi · Moonshot (Global)",
  KIMI_CN: "Kimi · Moonshot (China 🇨🇳)",
  KIMI_CODING: "Kimi Coding (paket coding)",
  MINIMAX: "MiniMax (Global)",
  MINIMAX_CN: "MiniMax (China 🇨🇳)",
  OPENCODE_GO: "OpenCode Go ($10/bln langganan)",
  OPENCODE_ZEN: "OpenCode Zen (bayar per-pakai)",
  ALIBABA_CODING_PLAN: "Alibaba (Coding Plan)",
  AZURE_FOUNDRY: "Azure Foundry",
  DASHSCOPE: "Qwen · DashScope (Alibaba)",
  NVIDIA: "NVIDIA NIM",
  OLLAMA: "Ollama Cloud",
  HF: "Hugging Face",
  LM: "LM Studio / Endpoint Lokal",
  ARCEEAI: "Arcee AI",
  KILOCODE: "KiloCode",
};

/** Clear, distinct display name for any provider env key. */
function prettyProvider(key: string): string {
  const base = key.replace(/_API_KEY$/, "").replace(/_BASE_URL$/, "");
  if (FULL_NAME[base]) return FULL_NAME[base];
  const words = base.split("_").filter(Boolean);
  const firstWord: Record<string, string> = {
    OPENROUTER: "OpenRouter", XAI: "xAI", ZAI: "Z.AI", Z: "Z.AI",
    STEPFUN: "StepFun", GMI: "GMI", DEEPSEEK: "DeepSeek", XIAOMI: "Xiaomi MiMo",
    ANTHROPIC: "Anthropic", NOVITA: "Novita", NOUS: "Nous",
  };
  return firstWord[words[0]] ?? words.map((w) => w[0] + w.slice(1).toLowerCase()).join(" ");
}

// UX4 — the engine OAuth catalog ships raw, developer-flavored English names
// ("Anthropic OAuth: Required Extra Usage Credits to Use Subscription",
// "Qwen (via Qwen CLI)", "Nous Portal"). Override with clear Bahasa labels +
// subtitles so awam users understand "pakai langganan" at a glance.
const OAUTH_DISPLAY: Record<string, { name: string; sub: string }> = {
  "openai-codex": { name: "ChatGPT (Codex / Plus)", sub: "Pakai langganan ChatGPT — tanpa kunci API" },
  "claude-code": { name: "Claude (Langganan)", sub: "Pakai langganan Claude Pro/Max — tanpa kunci API" },
  "qwen-oauth": { name: "Qwen (Langganan)", sub: "Login akun Qwen — alternatif kunci DashScope" },
  "minimax-oauth": { name: "MiniMax (Langganan)", sub: "Login akun MiniMax — tanpa kunci API" },
  "xai-oauth": { name: "Grok (Langganan)", sub: "Pakai langganan SuperGrok / Premium+" },
  nous: { name: "Nous (Langganan)", sub: "Login akun Nous Research" },
  // `anthropic` (pkce) duplicates the ANTHROPIC_API_KEY card in the key grid —
  // hidden from the OAuth section via OAUTH_HIDE below.
};
// De-dupe: hide OAuth entries that just shadow a key-grid card.
const OAUTH_HIDE = new Set(["anthropic"]);

function prettyOauthName(p: OAuthProvider): string {
  return OAUTH_DISPLAY[p.id]?.name ?? p.name;
}
function prettyOauthSub(p: OAuthProvider): string | null {
  return OAUTH_DISPLAY[p.id]?.sub ?? null;
}

// UX1 — category sections for the LLM key grid so 30+ providers aren't one
// overwhelming flat wall. Ordered; "popular" first + open by default.
const CATEGORY_META: Record<ProviderCategory, { label: string; hint: string; defaultOpen: boolean }> = {
  popular: { label: "Populer", hint: "Pilihan utama — mulai dari sini", defaultOpen: true },
  regional: { label: "Regional & Lainnya", hint: "Penyedia Asia & alternatif", defaultOpen: false },
  coding: { label: "Spesialis Coding", hint: "Dioptimalkan untuk ngoding", defaultOpen: false },
  selfhosted: { label: "Self-hosted / Lokal", hint: "Server LLM milikmu sendiri", defaultOpen: false },
  custom: { label: "Lanjutan / Custom", hint: "Endpoint kustom & enterprise", defaultOpen: false },
};
const CATEGORY_ORDER: ProviderCategory[] = ["popular", "regional", "coding", "selfhosted", "custom"];

// ════════════════════════════════════════════════════════════════════════
export function ProvidersTab() {
  const status = useAppStore((s) => s.status);
  const [oauth, setOauth] = useState<OAuthProvider[] | null>(null);
  const [vars, setVars] = useState<EnvVar[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [activeOauth, setActiveOauth] = useState<OAuthProvider | null>(null);
  // After a key save succeeds → offer to switch the user's agents onto a model
  // from the freshly-added provider (full apply popup).
  const [applyTarget, setApplyTarget] = useState<{ envKey: string; label: string } | null>(null);

  const flash = useCallback((m: string) => {
    setToast(m);
    window.setTimeout(() => setToast((t) => (t === m ? null : t)), 2800);
  }, []);

  const load = useCallback(async () => {
    setErr(null);
    try {
      const [o, e] = await Promise.all([
        rpc<{ providers: OAuthProvider[] }>("providers.oauthList"),
        rpc<{ vars: EnvVar[] }>("providers.envCatalog"),
      ]);
      setOauth(o.providers ?? []);
      setVars(e.vars ?? []);
    } catch (ex) {
      setErr(errMsg(ex));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "ready") void load();
  }, [status, load]);

  if (status !== "ready" || loading) {
    return (
      <div className="flex h-full items-center justify-center text-white/50">
        <Loader2 className="mr-2 size-4 animate-spin" />
        {status !== "ready" ? "Menyambung ke engine…" : "Memuat penyedia…"}
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <SectionHeader
        eyebrow="Penyedia"
        title="Penyedia AI"
        subtitle="Login langganan (OAuth) & kunci API model — tersimpan aman di engine kamu."
        actions={
          <button
            type="button"
            onClick={() => void load()}
            aria-label="Muat ulang"
            className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/55 transition hover:border-cyan-400/40 hover:text-cyan-300"
            title="Muat ulang"
          >
            <RefreshCw className="size-3.5" aria-hidden />
          </button>
        }
      />

      <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto w-full max-w-6xl space-y-6 pb-28">
          <div className="flex items-start gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-[11.5px] text-white/55">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-300/80" aria-hidden />
            <p>
              Kunci & token disimpan terenkripsi di container pribadimu — terisolasi,
              file rahasia (akses owner-only). Perubahan langsung dipakai; engine
              aktif penuh ~10 detik setelah disimpan.
            </p>
          </div>

          {err ? (
            <div
              role="alert"
              className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[12px] text-red-200"
            >
              {err}
            </div>
          ) : null}

          <OAuthLogins
            providers={oauth ?? []}
            onOpen={setActiveOauth}
            onToast={flash}
            onChanged={() => void load()}
          />

          <LlmKeys
            vars={vars ?? []}
            onToast={flash}
            onChanged={() => void load()}
            onApply={(envKey, label) => setApplyTarget({ envKey, label })}
          />
        </div>
      </div>

      <AnimatePresence>
        {applyTarget ? (
          <AgentModelApplyModal
            providerLabel={applyTarget.label}
            onToast={flash}
            onClose={() => setApplyTarget(null)}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {activeOauth ? (
          <OAuthModal
            provider={activeOauth}
            onClose={() => setActiveOauth(null)}
            onToast={flash}
            onDone={() => {
              setActiveOauth(null);
              void load();
            }}
          />
        ) : null}
      </AnimatePresence>

      <AnimatePresence>
        {toast ? (
          <motion.div
            role="status"
            aria-live="polite"
            aria-atomic="true"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 12 }}
            className="fixed bottom-6 left-1/2 z-[200] -translate-x-1/2 rounded-full border border-cyan-400/30 bg-[#0B0E14]/95 px-4 py-2 text-[12px] text-white shadow-[0_8px_30px_-8px_rgba(34,211,238,0.5)] backdrop-blur-xl"
          >
            {toast}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

// ── OAuth logins section ───────────────────────────────────────────────────
function OAuthLogins({
  providers,
  onOpen,
  onToast,
  onChanged,
}: {
  providers: OAuthProvider[];
  onOpen: (p: OAuthProvider) => void;
  onToast: (m: string) => void;
  onChanged: () => void;
}) {
  // De-dupe: hide OAuth entries that shadow a key-grid card (anthropic pkce).
  const shown = providers.filter((p) => !OAUTH_HIDE.has(p.id));
  const connected = shown.filter((p) => p.status.loggedIn).length;
  return (
    <section className="space-y-3" aria-labelledby="oauth-section-heading">
      <div className="flex items-center gap-2">
        <LogIn className="size-3.5 text-cyan-300/80" aria-hidden />
        <h2 id="oauth-section-heading" className="font-display text-sm font-bold">
          Login Penyedia (OAuth)
        </h2>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-white/50">
          {connected}/{shown.length} aktif
        </span>
      </div>
      <p className="-mt-1 text-[11.5px] text-white/45">
        Pakai langganan (ChatGPT/Claude/dll) tanpa kunci API. Pilih penyedia → ikuti langkahnya.
      </p>
      <div className="grid gap-2.5 sm:grid-cols-2">
        {shown.map((p) => (
          <OAuthCard key={p.id} p={p} onOpen={() => onOpen(p)} onToast={onToast} onChanged={onChanged} />
        ))}
      </div>
    </section>
  );
}

function OAuthCard({
  p,
  onOpen,
  onToast,
  onChanged,
}: {
  p: OAuthProvider;
  onOpen: () => void;
  onToast: (m: string) => void;
  onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const connected = p.status.loggedIn;
  const flow = FLOW_META[p.flow] ?? FLOW_FALLBACK;

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await rpc("providers.oauthDisconnect", { id: p.id });
      onToast(`${prettyOauthName(p)} diputuskan.`);
      onChanged();
    } catch (e) {
      onToast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "relative overflow-hidden rounded-xl border p-3.5 transition-all",
        connected
          ? "border-emerald-400/25 bg-emerald-400/[0.04]"
          : "border-white/10 bg-white/[0.03] hover:border-white/20",
      )}
    >
      <div className="flex items-center gap-3">
        <div className="relative shrink-0">
          <ProviderLogo
            src={logoForOauth(p.id)}
            size={36}
            fallback={
              <div
                className={cn(
                  "flex size-9 items-center justify-center rounded-lg border text-[13px]",
                  connected
                    ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-200"
                    : "border-white/10 bg-white/[0.04] text-white/45",
                )}
              >
                {connected ? <Check className="size-4" /> : <Lock className="size-4" />}
              </div>
            }
          />
          {connected ? (
            <span className="absolute -bottom-0.5 -right-0.5 flex size-3.5 items-center justify-center rounded-full border-2 border-[#0B0E14] bg-emerald-400 text-[#0B0E14]">
              <Check className="size-2" strokeWidth={3.5} />
            </span>
          ) : null}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <p className="truncate text-sm font-semibold text-white/90">{prettyOauthName(p)}</p>
            <span className={cn("shrink-0 font-mono text-[9px] uppercase tracking-[0.14em]", flow.tint)}>
              {flow.label}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-white/45">
            {connected
              ? `Terhubung${p.status.sourceLabel ? ` · ${p.status.sourceLabel}` : ""}`
              : prettyOauthSub(p) ?? "Belum terhubung"}
          </p>
        </div>
        {connected ? (
          <button
            type="button"
            onClick={() => void disconnect()}
            disabled={busy}
            className="shrink-0 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-medium text-white/60 transition hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
          >
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : "Putuskan"}
          </button>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              "shrink-0 rounded-lg bg-gradient-to-br px-3 py-1.5 text-[11.5px] font-semibold text-[#0B0E14] transition hover:brightness-110",
              ACCENT,
            )}
          >
            Hubungkan
          </button>
        )}
      </div>
    </div>
  );
}

// ── OAuth modal — one component, branches per flow ──────────────────────────
function OAuthModal({
  provider,
  onClose,
  onToast,
  onDone,
}: {
  provider: OAuthProvider;
  onClose: () => void;
  onToast: (m: string) => void;
  onDone: () => void;
}) {
  const isExternal = provider.flow === "external";
  const panelRef = useRef<HTMLDivElement | null>(null);

  // A11Y1/7 — accessible dialog: trap focus, restore on close, Esc to close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const focusables = panel.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[210] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="oauth-modal-title"
        tabIndex={-1}
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-md overflow-hidden rounded-2xl border border-white/10 bg-[#0B0E14] shadow-[0_24px_80px_-20px_rgba(0,0,0,0.8)] outline-none"
      >
        <div className="flex items-center justify-between border-b border-white/[0.06] px-4 py-3">
          <div className="flex items-center gap-2.5">
            <ProviderLogo src={logoForOauth(provider.id)} size={32} fallback={<></>} />
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-cyan-300/70">
                {FLOW_META[provider.flow]?.label ?? FLOW_FALLBACK.label}
              </p>
              <h2 id="oauth-modal-title" className="text-sm font-bold text-white">
                {prettyOauthName(provider)}
              </h2>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="flex size-7 items-center justify-center rounded-md text-white/45 transition hover:bg-white/5 hover:text-white"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="max-h-[70vh] space-y-3 overflow-y-auto p-4 scrollbar-slim">
          {(() => {
            const tut = tutorialForOauth(provider.id);
            return tut ? <TutorialSteps t={tut} /> : null;
          })()}
          {isExternal ? (
            <ExternalFlow provider={provider} onToast={onToast} onDone={onDone} />
          ) : (
            <SubprocessFlow provider={provider} onToast={onToast} onDone={onDone} />
          )}
        </div>
      </motion.div>
    </motion.div>
  );
}

/** device_code + pkce: spawn `hermes auth add`, poll, show URL + code, relay. */
function SubprocessFlow({
  provider,
  onToast,
  onDone,
}: {
  provider: OAuthProvider;
  onToast: (m: string) => void;
  onDone: () => void;
}) {
  const [flowId, setFlowId] = useState<string | null>(null);
  const [poll, setPoll] = useState<PollResult | null>(null);
  const [paste, setPaste] = useState("");
  const [relaying, setRelaying] = useState(false);
  const [starting, setStarting] = useState(true);
  const [startErr, setStartErr] = useState<string | null>(null);
  const cursorRef = useRef(0);
  const flowRef = useRef<string | null>(null);

  // start once
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await rpc<{ flowId: string }>("providers.oauth.start", { provider: provider.id });
        if (!alive) {
          // Modal closed during the start RPC — cancel the just-spawned flow so
          // it never lingers in the background.
          void rpc("providers.oauth.cancel", { flowId: r.flowId }).catch(() => {});
          return;
        }
        setFlowId(r.flowId);
        flowRef.current = r.flowId;
      } catch (e) {
        if (alive) setStartErr(errMsg(e));
      } finally {
        if (alive) setStarting(false);
      }
    })();
    return () => {
      alive = false;
      const fid = flowRef.current;
      if (fid) void rpc("providers.oauth.cancel", { flowId: fid }).catch(() => {});
    };
  }, [provider.id]);

  // poll loop
  useEffect(() => {
    if (!flowId) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const r = await rpc<PollResult>("providers.oauth.poll", { flowId, cursor: cursorRef.current });
        if (!alive) return;
        cursorRef.current = r.cursor ?? cursorRef.current;
        setPoll(r);
        if (r.status === "success") {
          onToast(`${prettyOauthName(provider)} terhubung ✓`);
          onDone();
          return;
        }
        if (r.status === "error" || r.status === "cancelled") return;
      } catch {
        /* transient */
      }
      // PERF2 — track the timer so unmount cancels the trailing poll RPC.
      if (alive) timer = window.setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [flowId, provider, onToast, onDone]);

  const submitCode = async () => {
    if (!flowId || !paste.trim() || relaying) return;
    setRelaying(true);
    try {
      await rpc("providers.oauth.relay", { flowId, input: paste.trim() });
      setPaste("");
      onToast("Kode dikirim, memverifikasi…");
    } catch (e) {
      onToast(errMsg(e));
    } finally {
      setRelaying(false);
    }
  };

  const url = poll?.url ?? null;
  const code = poll?.userCode ?? null;
  const needsInput = poll?.needsInput && poll.status === "running";

  if (startErr) {
    return <ErrorBox msg={startErr} cli={provider.cliCommand} />;
  }
  if (poll?.status === "error") {
    return <ErrorBox msg={poll.error || "Login gagal."} cli={provider.cliCommand} />;
  }

  return (
    <div className="space-y-3">
      {starting || !url ? (
        <div className="flex items-center gap-2 text-[12px] text-white/55">
          <Loader2 className="size-4 animate-spin" /> Menyiapkan login…
        </div>
      ) : (
        <>
          <p className="text-[12px] text-white/65">
            {provider.flow === "device_code"
              ? "1. Buka link ini, lalu otorisasi (masukkan kode bila diminta):"
              : "1. Buka link ini & otorisasi di browser:"}
          </p>
          <div className="flex items-center gap-2">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-[12px] font-medium text-cyan-200 transition hover:bg-cyan-400/15"
            >
              <ExternalLink className="size-3.5 shrink-0" />
              <span className="truncate">Buka halaman otorisasi</span>
            </a>
            <CopyBtn text={url} onToast={onToast} label="link" />
          </div>

          {code ? (
            <div className="rounded-lg border border-white/10 bg-white/[0.03] p-3">
              <p className="text-[10.5px] uppercase tracking-[0.14em] text-white/40">Kode perangkat</p>
              <div className="mt-1 flex items-center justify-between gap-2">
                <span className="font-mono text-xl font-bold tracking-[0.18em] text-white">{code}</span>
                <CopyBtn text={code} onToast={onToast} label="kode" />
              </div>
            </div>
          ) : null}

          {needsInput ? (
            <div className="space-y-2 rounded-lg border border-indigo-400/25 bg-indigo-400/[0.06] p-3">
              <p className="text-[12px] text-white/70">
                2. Setelah otorisasi, kamu akan dapat <b>kode</b>. Tempel di sini:
              </p>
              <div className="flex items-center gap-2">
                <input
                  value={paste}
                  onChange={(e) => setPaste(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && void submitCode()}
                  placeholder="Tempel kode otorisasi…"
                  aria-label="Kode otorisasi"
                  className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[12px] text-white outline-none focus:border-indigo-400/60"
                />
                <button
                  type="button"
                  onClick={() => void submitCode()}
                  disabled={!paste.trim() || relaying}
                  className="shrink-0 rounded-md bg-indigo-500 px-3 py-1.5 text-[12px] font-semibold text-white transition hover:bg-indigo-400 disabled:opacity-50"
                >
                  {relaying ? <Loader2 className="size-3.5 animate-spin" /> : "Kirim"}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-2 text-[12px] text-emerald-300/80">
              <Loader2 className="size-3.5 animate-spin" /> Menunggu persetujuan di browser…
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** external: claude-code (paste token) + qwen (paste creds JSON). */
function ExternalFlow({
  provider,
  onToast,
  onDone,
}: {
  provider: OAuthProvider;
  onToast: (m: string) => void;
  onDone: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const isClaude = provider.id === "claude-code";

  const submit = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    try {
      if (isClaude) await rpc("providers.claudeCreds", { token: value.trim() });
      else await rpc("providers.qwenCreds", { json: value.trim() });
      onToast(`${prettyOauthName(provider)} terhubung ✓`);
      onDone();
    } catch (e) {
      onToast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  // The engine blanks engine-branded CLI commands ('hermes auth add …'); only a
  // genuine 3rd-party command (e.g. 'claude setup-token') survives. Show the
  // command box only when there's a real command to run.
  const hasCli = Boolean(provider.cliCommand);

  return (
    <div className="space-y-3">
      <p className="text-[12px] text-white/65">
        {isClaude
          ? "Penyedia ini butuh CLI Claude Code. Di komputermu sendiri, jalankan perintah ini lalu salin token hasilnya:"
          : "Penyedia ini butuh Qwen CLI. Login Qwen di komputermu, lalu buka & salin isi file oauth_creds.json:"}
      </p>
      {hasCli ? (
        <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-2">
          <code className="min-w-0 flex-1 truncate font-mono text-[12px] text-cyan-200">
            {provider.cliCommand}
          </code>
          <CopyBtn text={provider.cliCommand} onToast={onToast} label="perintah" />
        </div>
      ) : null}
      <p className="text-[12px] text-white/65">
        {isClaude ? "Tempel token di sini:" : "Tempel isi oauth_creds.json di sini:"}
      </p>
      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={isClaude ? 2 : 4}
        placeholder={isClaude ? "Tempel token Claude Code…" : '{ "access_token": "...", ... }'}
        aria-label={isClaude ? "Token Claude Code" : "Isi oauth_creds.json"}
        className="w-full resize-none rounded-md border border-white/10 bg-black/40 px-2.5 py-2 font-mono text-[11.5px] text-white outline-none focus:border-amber-400/60"
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!value.trim() || busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-[12.5px] font-semibold text-[#0B0E14] transition hover:brightness-110 disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <Check className="size-4" aria-hidden />}
        Hubungkan
      </button>
      {provider.docsUrl ? (
        <a
          href={provider.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="flex items-center justify-center gap-1 text-[11px] text-white/40 transition hover:text-white/70"
        >
          <ExternalLink className="size-3" aria-hidden /> Panduan
        </a>
      ) : null}
    </div>
  );
}

function ErrorBox({ msg, cli }: { msg: string; cli: string }) {
  return (
    <div className="space-y-2" role="alert">
      <div className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-[12px] text-red-200">{msg}</div>
      {cli ? (
        <p className="text-[11px] text-white/40">
          Alternatif manual (di terminal): <span className="font-mono text-white/60">{cli}</span>
        </p>
      ) : null}
    </div>
  );
}

// ── Post-save: apply a model from the new provider to the user's agents ──────
type ApplyAgent = {
  id: string;
  name?: string;
  model?: { primary?: string; provider?: string } & Record<string, unknown>;
};
type ApplyModelProvider = { slug: string; name: string; models: string[] };

function AgentModelApplyModal({
  providerLabel,
  onToast,
  onClose,
}: {
  providerLabel: string;
  onToast: (m: string) => void;
  onClose: () => void;
}) {
  const [agents, setAgents] = useState<ApplyAgent[] | null>(null);
  const [providers, setProviders] = useState<ApplyModelProvider[] | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [bulk, setBulk] = useState("");
  const [reloadTick, setReloadTick] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Resilient load: a key save restarts the engine, so agents.list / models.list
  // fail transiently for ~10–30s. Poll until the engine is back instead of
  // showing a raw crash string + an infinite spinner. Friendly "warming" state
  // throughout; a real (non-transient) error stops + explains; a hard timeout
  // points the user to the manual reload / the Agen tab.
  useEffect(() => {
    let alive = true;
    let timer: number | undefined;
    let attempts = 0;
    const MAX_ATTEMPTS = 20; // ~60s @ 3s — covers a slow skill-scan restart
    const tick = async () => {
      if (!alive) return;
      try {
        const [a, m] = await Promise.all([
          rpc<{ agents?: ApplyAgent[] } | ApplyAgent[]>("agents.list"),
          rpc<{ providers?: ApplyModelProvider[] }>("models.list"),
        ]);
        if (!alive) return;
        setAgents(Array.isArray(a) ? a : (a.agents ?? []));
        setProviders(m.providers ?? []);
        setLoadErr(null);
        return;
      } catch (e) {
        if (!alive) return;
        const msg = errMsg(e);
        if (isEngineWarmingUp(msg) && attempts < MAX_ATTEMPTS) {
          attempts += 1;
          setLoadErr(null);
          timer = window.setTimeout(tick, 3000);
          return;
        }
        // Hard error, or warming that never resolved.
        setLoadErr(
          isEngineWarmingUp(msg)
            ? "Engine masih menyiapkan model (skill/model-mu cukup banyak). Klik “Muat ulang model”, atau atur model nanti di tab Agen."
            : msg,
        );
      }
    };
    void tick();
    return () => {
      alive = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [reloadTick]);

  const reload = useCallback(() => {
    setAgents(null);
    setProviders(null);
    setLoadErr(null);
    setReloadTick((t) => t + 1);
  }, []);

  // Dialog: Esc + focus trap/restore.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== "Tab" || !panel) return;
      const f = panel.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
      );
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      opener?.focus?.();
    };
  }, [onClose]);

  // Flatten model.options → option list (value carries the providerSlug so the
  // engine pins the right provider — a model id can live in multiple groups).
  const flat = useMemo(() => {
    const out: { value: string; model: string; providerName: string }[] = [];
    for (const p of providers ?? []) {
      for (const md of p.models) {
        out.push({ value: `${p.slug}::${md}`, model: md, providerName: p.name });
      }
    }
    return out;
  }, [providers]);

  const applyOne = useCallback(
    async (agent: ApplyAgent, value: string) => {
      if (!value) return;
      const idx = value.indexOf("::");
      const slug = value.slice(0, idx);
      const model = value.slice(idx + 2);
      setBusyId(agent.id);
      try {
        await rpc("agents.update", {
          agentId: agent.id,
          patch: { model: { ...(agent.model ?? {}), primary: model, providerSlug: slug } },
        });
        onToast(`${agent.name ?? agent.id} → ${model}`);
        setAgents((prev) =>
          prev?.map((a) => (a.id === agent.id ? { ...a, model: { ...(a.model ?? {}), primary: model } } : a)) ?? prev,
        );
      } catch (e) {
        const msg = errMsg(e);
        onToast(
          isEngineWarmingUp(msg)
            ? "Engine sedang restart — tunggu beberapa detik lalu coba lagi."
            : msg,
        );
      } finally {
        setBusyId(null);
      }
    },
    [onToast],
  );

  const applyAll = useCallback(async () => {
    if (!bulk || !agents) return;
    for (const a of agents) await applyOne(a, bulk);
  }, [bulk, agents, applyOne]);

  const loading = agents === null && !loadErr;
  const noModels = agents !== null && !loadErr && flat.length === 0;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <motion.div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="apply-modal-title"
        tabIndex={-1}
        initial={{ scale: 0.96, y: 8 }}
        animate={{ scale: 1, y: 0 }}
        exit={{ scale: 0.96, y: 8 }}
        onClick={(e) => e.stopPropagation()}
        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-cyan-400/30 bg-[#0B0E14] shadow-[0_24px_80px_-20px_rgba(0,0,0,0.85)]"
      >
        <div className="flex items-start justify-between gap-3 border-b border-white/[0.06] bg-gradient-to-br from-cyan-400/[0.08] to-fuchsia-500/[0.05] px-4 py-3">
          <div className="min-w-0">
            <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-cyan-300/80">Key aktif</p>
            <h2 id="apply-modal-title" className="text-sm font-bold text-white">
              Pakai model <span className="text-cyan-200">{providerLabel}</span> untuk agen kamu?
            </h2>
            <p className="mt-0.5 text-[11px] text-white/50">
              Pilih model untuk tiap agen. Perubahan langsung kepakai di semua chat &amp; channel agen itu.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Tutup"
            className="flex size-7 shrink-0 items-center justify-center rounded-md text-white/45 transition hover:bg-white/5 hover:text-white"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>

        <div className="scrollbar-slim flex-1 space-y-2.5 overflow-y-auto p-4">
          {loadErr ? (
            <div role="alert" className="space-y-2 rounded-lg border border-amber-400/30 bg-amber-400/[0.08] p-3 text-[12px] text-amber-100/90">
              <p>{loadErr}</p>
              <button
                type="button"
                onClick={reload}
                className="rounded-md border border-amber-400/40 bg-amber-400/10 px-2.5 py-1 text-[11px] font-medium text-amber-100 transition hover:bg-amber-400/20"
              >
                Coba muat ulang
              </button>
            </div>
          ) : null}

          {loading ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Loader2 className="size-5 animate-spin text-cyan-300/80" aria-hidden />
              <p className="text-[12.5px] font-medium text-white/75">Mengaktifkan key &amp; menyiapkan model…</p>
              <p className="max-w-xs text-[11px] text-white/45">
                Engine lagi nyetel ulang biar key barunya kepakai (biasanya ~10–30 detik). Sebentar ya — daftar agen &amp; model muncul otomatis.
              </p>
            </div>
          ) : agents === null ? null : (
            <>
              {noModels ? (
                <div className="rounded-lg border border-amber-400/25 bg-amber-400/[0.06] p-3 text-[11.5px] text-amber-100/80">
                  Model dari penyedia baru biasanya muncul ~10–30 detik setelah disimpan (engine
                  menyesuaikan). Klik <b>Muat ulang model</b> di bawah sebentar lagi.
                </div>
              ) : null}

              {agents && agents.length > 1 && flat.length > 0 ? (
                <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
                  <span className="shrink-0 text-[11px] text-white/55">Terapkan ke semua:</span>
                  <select
                    aria-label="Model untuk semua agen"
                    value={bulk}
                    onChange={(e) => setBulk(e.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-[11.5px] text-white outline-none focus:border-cyan-400/50"
                  >
                    <option value="">— pilih model —</option>
                    {flat.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.model} · {o.providerName}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    onClick={() => void applyAll()}
                    disabled={!bulk || busyId !== null}
                    className="shrink-0 rounded-md bg-gradient-to-br from-cyan-400 to-fuchsia-500 px-2.5 py-1.5 text-[11px] font-semibold text-[#0B0E14] transition hover:brightness-110 disabled:opacity-50"
                  >
                    Terapkan semua
                  </button>
                </div>
              ) : null}

              {(agents ?? []).map((agent) => {
                const current = agent.model?.primary ?? "";
                return (
                  <div key={agent.id} className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] p-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] font-semibold text-white/90">{agent.name ?? agent.id}</p>
                      <p className="truncate font-mono text-[10px] text-white/40">{current || "model default"}</p>
                    </div>
                    <select
                      aria-label={`Model untuk ${agent.name ?? agent.id}`}
                      defaultValue=""
                      disabled={busyId === agent.id || flat.length === 0}
                      onChange={(e) => void applyOne(agent, e.target.value)}
                      className="min-w-0 max-w-[55%] flex-1 rounded-md border border-white/10 bg-black/40 px-2 py-1.5 text-[11.5px] text-white outline-none focus:border-cyan-400/50 disabled:opacity-50"
                    >
                      <option value="">{busyId === agent.id ? "Menyimpan…" : "Ganti model…"}</option>
                      {flat.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.model} · {o.providerName}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}

              {agents && agents.length === 0 ? (
                <p className="py-4 text-center text-[12px] text-white/45">Belum ada agen. Buat agen dulu di tab Agen.</p>
              ) : null}
            </>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-white/[0.06] px-4 py-3">
          <button
            type="button"
            onClick={reload}
            className="rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 text-[11px] text-white/60 transition hover:border-cyan-400/40 hover:text-cyan-300"
          >
            Muat ulang model
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md border border-white/10 px-3 py-1.5 text-[11.5px] text-white/70 transition hover:text-white"
          >
            Selesai
          </button>
        </div>
      </motion.div>
    </motion.div>
  );
}

// ── LLM API keys section ────────────────────────────────────────────────────
function LlmKeys({
  vars,
  onToast,
  onChanged,
  onApply,
}: {
  vars: EnvVar[];
  onToast: (m: string) => void;
  onChanged: () => void;
  onApply: (envKey: string, label: string) => void;
}) {
  const [query, setQuery] = useState("");
  // Per-category collapse — popular open by default, the long tail collapsed so
  // awam users aren't hit with one 30-card wall.
  const [openCats, setOpenCats] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(CATEGORY_ORDER.map((c) => [c, CATEGORY_META[c].defaultOpen])),
  );

  const byKey = useMemo(() => {
    const m = new Map<string, EnvVar>();
    for (const v of vars) m.set(v.key, v);
    return m;
  }, [vars]);

  // Collapse alias env vars (e.g. GEMINI_API_KEY = alias of GOOGLE_API_KEY)
  // into ONE provider card, keyed by the canonical. isSet = any alias set.
  const groups = useMemo(() => {
    const g = new Map<string, EnvVar[]>();
    for (const v of vars) {
      if (!v.key.endsWith("_API_KEY")) continue;
      const canon = v.canonical || v.key;
      if (!g.has(canon)) g.set(canon, []);
      g.get(canon)!.push(v);
    }
    return [...g.entries()]
      .map(([canon, members]) => {
        const base = byKey.get(canon) ?? members[0];
        const setMember = members.find((m) => m.isSet) ?? null;
        const advanced = members.every((m) => m.advanced);
        const entry: EnvVar = {
          ...base,
          key: canon,
          isSet: Boolean(setMember),
          redactedValue: setMember?.redactedValue ?? null,
          advanced,
        };
        const baseUrlVar =
          members
            .map((m) => byKey.get(m.key.replace(/_API_KEY$/, "_BASE_URL")))
            .find(Boolean) ?? null;
        return { entry, groupKeys: members.map((m) => m.key), baseUrlVar };
      })
      .sort((a, b) => prettyProvider(a.entry.key).localeCompare(prettyProvider(b.entry.key)));
  }, [vars, byKey]);

  const setCount = groups.filter((x) => x.entry.isSet).length;

  // Search filter (name + key + description) + bucket by category.
  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      groups.filter((x) => {
        if (!q) return true;
        const hay = `${prettyProvider(x.entry.key)} ${x.entry.key} ${x.entry.description ?? ""}`.toLowerCase();
        return hay.includes(q);
      }),
    [groups, q],
  );
  const byCategory = useMemo(() => {
    const m = new Map<ProviderCategory, typeof filtered>();
    for (const c of CATEGORY_ORDER) m.set(c, []);
    for (const x of filtered) {
      const cat = (x.entry.category ?? "regional") as ProviderCategory;
      (m.get(cat) ?? m.get("regional")!).push(x);
    }
    return m;
  }, [filtered]);

  return (
    <section className="space-y-3" aria-labelledby="llm-section-heading">
      <div className="flex flex-wrap items-center gap-2">
        <KeyRound className="size-3.5 text-fuchsia-300/80" aria-hidden />
        <h2 id="llm-section-heading" className="font-display text-sm font-bold">
          Kunci API Model (LLM)
        </h2>
        <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 font-mono text-[9px] uppercase tracking-[0.16em] text-white/50">
          {setCount} terisi
        </span>
        <div className="relative ml-auto w-full sm:w-56">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cari penyedia…"
            aria-label="Cari penyedia AI"
            className="w-full rounded-md border border-white/10 bg-black/40 px-2.5 py-1.5 text-[11.5px] text-white outline-none placeholder:text-white/35 focus:border-cyan-400/50"
          />
        </div>
      </div>
      <p className="-mt-1 text-[11.5px] text-white/45">
        Pakai kunci API sendiri (BYOK). Mulai dari <strong className="text-white/70">Populer</strong> —
        Gemini & Groq punya tier gratis.
      </p>

      {q && filtered.length === 0 ? (
        <p className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-6 text-center text-[12px] text-white/45">
          Tidak ada penyedia cocok dengan &ldquo;{query}&rdquo;.
        </p>
      ) : null}

      {CATEGORY_ORDER.map((cat) => {
        const items = byCategory.get(cat) ?? [];
        if (items.length === 0) return null;
        const meta = CATEGORY_META[cat];
        // When searching, force every matching section open.
        const open = q ? true : openCats[cat];
        const filledHere = items.filter((x) => x.entry.isSet).length;
        return (
          <div key={cat} className="space-y-2">
            <button
              type="button"
              onClick={() => setOpenCats((s) => ({ ...s, [cat]: !s[cat] }))}
              aria-expanded={open}
              className="flex w-full items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-left transition hover:border-white/15"
            >
              <span className="font-display text-[12.5px] font-bold text-white/90">{meta.label}</span>
              <span className="rounded-full border border-white/10 bg-white/[0.04] px-1.5 font-mono text-[9px] text-white/45">
                {items.length}
              </span>
              {filledHere > 0 ? (
                <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 font-mono text-[9px] text-emerald-200">
                  {filledHere} terisi
                </span>
              ) : null}
              <span className="truncate text-[10.5px] text-white/35">{meta.hint}</span>
              <span className="ml-auto shrink-0 text-white/40">{open ? "−" : "+"}</span>
            </button>
            {open ? (
              <div className="grid gap-2 sm:grid-cols-2">
                {items.map((x) => (
                  <LlmKeyCard
                    key={x.entry.key}
                    entry={x.entry}
                    groupKeys={x.groupKeys}
                    baseUrlVar={x.baseUrlVar}
                    onToast={onToast}
                    onChanged={onChanged}
                    onApply={onApply}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </section>
  );
}

type TestStatus = "idle" | "testing" | "valid" | "invalid" | "unsupported" | "error";

function LlmKeyCard({
  entry,
  groupKeys,
  baseUrlVar,
  onToast,
  onChanged,
  onApply,
}: {
  entry: EnvVar;
  groupKeys: string[];
  baseUrlVar: EnvVar | null;
  onToast: (m: string) => void;
  onChanged: () => void;
  onApply: (envKey: string, label: string) => void;
}) {
  const [keyVal, setKeyVal] = useState("");
  const [baseVal, setBaseVal] = useState("");
  const [reveal, setReveal] = useState(false);
  const [open, setOpen] = useState(false);
  const [test, setTest] = useState<TestStatus>("idle");
  // The validity probe retries across up to ~12s (4×3s); guard set-state so a
  // retry that resolves after the card unmounts can't warn / stomp a remount.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Validity check — probe the provider's /models with the saved key. Retries
  // on a transient failure: the auto-test fires right after a save that restarts
  // the engine, so the bridge can briefly be busy. Retrying avoids a false
  // "Gagal cek". Manual clicks pass a small retry budget too.
  const runTest = useCallback(
    async (retries = 0) => {
      if (!mountedRef.current) return;
      setTest("testing");
      for (let attempt = 0; ; attempt++) {
        try {
          const r = await rpc<{ status: string; modelCount?: number }>("providers.testKey", { key: entry.key });
          if (!mountedRef.current) return;
          const s = r.status;
          if (s === "error" && attempt < retries) {
            await new Promise((res) => setTimeout(res, 3000));
            continue;
          }
          setTest(s === "valid" ? "valid" : s === "invalid" ? "invalid" : s === "unsupported" ? "unsupported" : "error");
          return;
        } catch {
          if (attempt < retries) {
            await new Promise((res) => setTimeout(res, 3000));
            continue;
          }
          if (mountedRef.current) setTest("error");
          return;
        }
      }
    },
    [entry.key],
  );
  // Tutorial shown BY DEFAULT the moment the user opens the input — non-dev
  // users shouldn't have to hunt for "how do I get this key".
  const [showHelp, setShowHelp] = useState(true);
  const [busy, setBusy] = useState(false);

  const saveKey = async () => {
    if (!keyVal.trim() || busy) return;
    setBusy(true);
    try {
      await rpc("providers.setEnv", { key: entry.key, value: keyVal.trim() });
      // Aliased provider (e.g. Gemini): keep the value in the canonical only —
      // drop sibling aliases so there's never a stale second copy.
      for (const k of groupKeys) {
        if (k !== entry.key) await rpc("providers.deleteEnv", { key: k }).catch(() => {});
      }
      if (baseUrlVar && baseVal.trim()) {
        await rpc("providers.setEnv", { key: baseUrlVar.key, value: baseVal.trim() });
      }
      setKeyVal("");
      setBaseVal("");
      setOpen(false);
      onToast(`${prettyProvider(entry.key)} disimpan ✓ — aktif ~10 dtk`);
      onChanged();
      // Validity check (probes the provider directly). Retry to survive the
      // brief engine-restart window the save kicks off.
      void runTest(4);
      // Offer to switch the user's agents onto a model from this provider.
      onApply(entry.key, prettyProvider(entry.key));
    } catch (e) {
      onToast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const del = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // Delete EVERY alias in the group so the provider is truly cleared.
      for (const k of groupKeys.length ? groupKeys : [entry.key]) {
        await rpc("providers.deleteEnv", { key: k }).catch(() => {});
      }
      onToast(`${prettyProvider(entry.key)} dihapus.`);
      onChanged();
    } catch (e) {
      onToast(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cn(
        "rounded-xl border p-3 transition-all",
        entry.isSet ? "border-emerald-400/20 bg-emerald-400/[0.03]" : "border-white/10 bg-white/[0.03]",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          <ProviderLogo
            src={logoForKey(entry.key)}
            size={28}
            fallback={
              <div className="flex size-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-white/40">
                <KeyRound className="size-3.5" />
              </div>
            }
          />
          <div className="min-w-0">
            <p className="truncate text-[12.5px] font-semibold text-white/90">{prettyProvider(entry.key)}</p>
            <p className="truncate text-[10px] text-white/40" title={entry.key}>
              {entry.description || entry.key}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {entry.isSet ? (
            <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-medium text-emerald-200">
              terisi
            </span>
          ) : null}
          {entry.free ? (
            <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-1.5 py-0.5 text-[9px] font-medium text-cyan-200">
              Tier Gratis
            </span>
          ) : null}
        </div>
      </div>

      {entry.isSet && entry.redactedValue ? (
        <p className="mt-1 truncate font-mono text-[10.5px] text-white/40">{entry.redactedValue}</p>
      ) : null}

      {entry.isSet ? (
        <div className="mt-1.5 flex items-center gap-1.5" aria-live="polite">
          {test === "testing" ? (
            <span className="inline-flex items-center gap-1 text-[10px] text-white/45">
              <Loader2 className="size-3 animate-spin" aria-hidden /> Mengecek…
            </span>
          ) : test === "valid" ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 text-[9.5px] font-medium text-emerald-200">
              <Check className="size-2.5" aria-hidden /> Key valid
            </span>
          ) : test === "invalid" ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-red-500/40 bg-red-500/10 px-1.5 py-0.5 text-[9.5px] font-medium text-red-200">
              <X className="size-2.5" aria-hidden /> Key salah / ditolak
            </span>
          ) : test === "error" ? (
            <span className="text-[9.5px] text-amber-300/80">Gagal cek — coba lagi</span>
          ) : test === "unsupported" ? (
            <span className="text-[9.5px] text-white/35">Tersimpan (cek otomatis tak tersedia)</span>
          ) : null}
          {test !== "testing" ? (
            <button
              type="button"
              onClick={() => void runTest(1)}
              className="rounded border border-white/10 px-1.5 py-0.5 text-[9.5px] text-white/45 transition hover:border-cyan-400/40 hover:text-cyan-300"
            >
              Test koneksi
            </button>
          ) : null}
        </div>
      ) : null}

      {open ? (
        <div className="mt-2 space-y-1.5">
          <button
            type="button"
            onClick={() => setShowHelp((s) => !s)}
            className="flex w-full items-center justify-center gap-1 rounded-md border border-cyan-400/20 bg-cyan-400/[0.04] px-2 py-1 text-[10.5px] font-medium text-cyan-200/80 transition hover:bg-cyan-400/10"
          >
            {showHelp ? "Sembunyikan panduan" : "📘 Cara dapetin kunci ini"}
          </button>
          {showHelp ? (
            <TutorialSteps t={tutorialForKey(entry.key, prettyProvider(entry.key), entry.url)} />
          ) : null}
          <div className="relative">
            <input
              type={reveal ? "text" : "password"}
              value={keyVal}
              onChange={(e) => setKeyVal(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !baseUrlVar && void saveKey()}
              placeholder="Tempel kunci API…"
              aria-label={`Kunci API ${prettyProvider(entry.key)}`}
              autoFocus
              className="w-full rounded-md border border-white/10 bg-black/40 py-1.5 pl-2 pr-8 text-[12px] text-white outline-none focus:border-cyan-400/60"
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? "Sembunyikan kunci" : "Tampilkan kunci"}
              aria-pressed={reveal}
              className="absolute right-1 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center rounded text-white/40 transition hover:text-white/80"
            >
              {reveal ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
            </button>
          </div>
          {baseUrlVar ? (
            <input
              value={baseVal}
              onChange={(e) => setBaseVal(e.target.value)}
              placeholder={baseUrlVar.redactedValue ? `Base URL (${baseUrlVar.redactedValue})` : "Base URL (opsional)"}
              aria-label={`Base URL ${prettyProvider(entry.key)} (opsional)`}
              className="w-full rounded-md border border-white/10 bg-black/40 px-2 py-1.5 font-mono text-[11px] text-white outline-none focus:border-cyan-400/60"
            />
          ) : null}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => void saveKey()}
              disabled={!keyVal.trim() || busy}
              className="flex flex-1 items-center justify-center gap-1 rounded-md bg-gradient-to-br from-cyan-400 to-fuchsia-500 px-2 py-1.5 text-[11.5px] font-semibold text-[#0B0E14] transition hover:brightness-110 disabled:opacity-50"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />} Simpan
            </button>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md border border-white/10 px-2 py-1.5 text-[11.5px] text-white/55 transition hover:text-white"
            >
              Batal
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-2 flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="flex flex-1 items-center justify-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1.5 text-[11.5px] font-medium text-white/70 transition hover:border-cyan-400/40 hover:text-cyan-300"
          >
            <Plus className="size-3.5" aria-hidden /> {entry.isSet ? "Ganti" : "Set kunci"}
          </button>
          {entry.isSet ? (
            <button
              type="button"
              onClick={() => void del()}
              disabled={busy}
              className="rounded-md border border-white/10 p-1.5 text-white/40 transition hover:border-red-500/40 hover:text-red-300 disabled:opacity-50"
              aria-label={`Hapus kunci ${prettyProvider(entry.key)}`}
              title="Hapus"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          ) : null}
          {entry.url ? (
            <a
              href={entry.url}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md border border-white/10 p-1.5 text-white/40 transition hover:text-white/80"
              aria-label={`Dapatkan kunci ${prettyProvider(entry.key)} (situs penyedia)`}
              title="Dapatkan kunci"
            >
              <ExternalLink className="size-3.5" aria-hidden />
            </a>
          ) : null}
        </div>
      )}
    </div>
  );
}

function TutorialSteps({ t }: { t: Tutorial }) {
  return (
    <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/[0.04] p-3">
      <p className="mb-2 text-[11.5px] font-semibold text-cyan-200/90">{t.title}</p>
      <ol className="space-y-1.5">
        {t.steps.map((s, i) => (
          <li key={i} className="flex gap-2 text-[11.5px] leading-snug text-white/70">
            <span className="mt-px flex size-4 shrink-0 items-center justify-center rounded-full bg-cyan-400/20 font-mono text-[9px] font-bold text-cyan-200">
              {i + 1}
            </span>
            <span className="break-words">{s}</span>
          </li>
        ))}
      </ol>
      {t.url ? (
        <a
          href={t.url}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-2.5 inline-flex items-center gap-1 rounded-md border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1.5 text-[11px] font-medium text-cyan-200 transition hover:bg-cyan-400/15"
        >
          <ExternalLink className="size-3" /> {t.urlLabel ?? "Buka situs"}
        </a>
      ) : null}
      {t.note ? <p className="mt-2 text-[10.5px] italic leading-snug text-white/45">{t.note}</p> : null}
    </div>
  );
}

function CopyBtn({ text, onToast, label }: { text: string; onToast: (m: string) => void; label: string }) {
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => onToast(`Disalin ${label}`),
          () => onToast("Gagal menyalin"),
        );
      }}
      className="flex size-8 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.04] text-white/55 transition hover:border-cyan-400/40 hover:text-cyan-300"
      aria-label={`Salin ${label}`}
      title="Salin"
    >
      <Copy className="size-3.5" aria-hidden />
    </button>
  );
}
