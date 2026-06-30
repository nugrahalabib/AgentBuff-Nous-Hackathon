"use client";

// Onboarding Step 5 (live) — mirrors the /app/providers tab, but inside the
// onboarding wizard against the user's JUST-PROVISIONED container.
//
// SECURITY: every RPC goes through getClient() → the GatewayProvider WebSocket →
// /api/ws/hermes, which authenticates the NextAuth session cookie server-side
// and routes ONLY to the caller's own container (port + bridgeToken resolved
// from the DB, never exposed to the browser). A user can reach only their own
// container; the key is written into that isolated container's .env via
// providers.setEnv and is never logged here.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronDown,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  KeyRound,
  Lightbulb,
  Loader2,
  Lock,
  LogIn,
  ShieldCheck,
  X,
} from "lucide-react";
import { getClient, useAppStore } from "@/lib/app/store";
import { GatewayError } from "@/lib/hermes/browser-gateway";
import { cn } from "@/lib/utils";
import {
  tutorialForKey,
  tutorialForOauth,
} from "@/components/app/tabs/provider-tutorials";
import type { OnboardingAnswers } from "@/lib/onboarding/answers";
import { BYOK_PROVIDERS, getByokProvider } from "@/lib/onboarding/byok-providers";
import { useI18n } from "@/lib/i18n/context";
import { PrimaryButton, StepHeader } from "./primitives";

type ByokI18n = ReturnType<typeof useI18n>["t"]["onboarding"]["byok"];

// ── wire types (mirror the providers tab) ──────────────────────────────────
type OAuthFlow = "pkce" | "device_code" | "external" | "loopback";
interface OAuthProvider {
  id: string;
  name: string;
  flow: OAuthFlow;
  cliCommand: string;
  docsUrl: string;
  status: {
    loggedIn: boolean;
    sourceLabel?: string | null;
    tokenPreview?: string | null;
    error?: string | null;
  };
}
interface EnvVar {
  key: string;
  canonical?: string;
  isSet: boolean;
  description: string;
  url?: string | null;
  isPassword: boolean;
  advanced: boolean;
  category?: string;
  free?: boolean;
  providerId?: string | null;
  synthetic?: boolean;
}
interface PollResult {
  status: string; // running | success | error | cancelled
  url?: string | null;
  userCode?: string | null;
  mode?: string | null; // device | paste_stdin | loopback
  needsInput?: boolean;
  error?: string | null;
  lines: string[];
  cursor: number;
}

// ── logo + name helpers (copied from providers-tab; intentionally duplicated
//    so this onboarding component never imports the gateway-coupled tab) ──────
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
const FULL_NAME: Record<string, string> = {
  GOOGLE: "Gemini (Google)", GEMINI: "Gemini (Google)", GLM: "Z.AI / GLM",
  KIMI: "Kimi · Moonshot", MINIMAX: "MiniMax", DASHSCOPE: "Qwen · DashScope",
  NVIDIA: "NVIDIA NIM", OLLAMA: "Ollama Cloud", HF: "Hugging Face",
  LM: "LM Studio / Endpoint Lokal", ARCEEAI: "Arcee AI", KILOCODE: "KiloCode",
  AZURE_FOUNDRY: "Azure Foundry",
};
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
const OAUTH_DISPLAY: Record<string, { name: string; sub: string }> = {
  "openai-codex": { name: "ChatGPT (Codex / Plus)", sub: "Pakai langganan ChatGPT — tanpa kunci API" },
  "claude-code": { name: "Claude (Langganan)", sub: "Pakai langganan Claude Pro/Max — tanpa kunci API" },
  "qwen-oauth": { name: "Qwen (Langganan)", sub: "Login akun Qwen — tanpa kunci API" },
  "minimax-oauth": { name: "MiniMax (Langganan)", sub: "Login akun MiniMax — tanpa kunci API" },
  "xai-oauth": { name: "Grok (Langganan)", sub: "Pakai langganan SuperGrok / Premium+" },
  nous: { name: "Nous (Langganan)", sub: "Login akun Nous Research" },
};
const OAUTH_HIDE = new Set(["anthropic"]);

function rpc<T>(method: string, params?: unknown): Promise<T> {
  const client = getClient();
  if (!client) return Promise.reject(new Error("Belum terhubung."));
  return client.request<T>(method, params ?? {});
}
function errMsg(e: unknown): string {
  if (e instanceof GatewayError) return e.message || String(e.code);
  if (e instanceof Error) return e.message;
  return "Terjadi kesalahan.";
}

function ProviderLogo({ src, size, fallback }: { src: string | null; size: number; fallback: React.ReactNode }) {
  if (!src) return <>{fallback}</>;
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

// ── canonical grouping (mirrors providers-tab.tsx groups useMemo EXACTLY) ──
type ProviderCategory = "popular" | "regional" | "coding" | "selfhosted" | "custom";
const CATEGORY_ORDER: ProviderCategory[] = ["popular", "regional", "coding", "selfhosted", "custom"];
const CATEGORY_META: Record<ProviderCategory, { label: string; hint: string }> = {
  popular: { label: "Populer", hint: "Pilihan utama — mulai dari sini" },
  regional: { label: "Regional & Lainnya", hint: "Penyedia Asia & alternatif" },
  coding: { label: "Spesialis Coding", hint: "Dioptimalkan untuk ngoding" },
  selfhosted: { label: "Self-hosted / Lokal", hint: "Server LLM milikmu sendiri" },
  custom: { label: "Lanjutan / Custom", hint: "Endpoint kustom & enterprise" },
};

interface KeyGroup {
  entry: EnvVar;
  groupKeys: string[]; // all aliases incl. canonical — for cleanup on save
  baseUrlVar: EnvVar | null;
}

// Collapse alias env vars into ONE card per canonical provider, drop _BASE_URL
// vars (rendered as companions, not standalone), sort alphabetically. This is
// the exact algorithm the live /app/providers tab uses — replicated, not guessed.
function buildGroups(vars: EnvVar[]): KeyGroup[] {
  const byKey = new Map<string, EnvVar>();
  for (const v of vars) byKey.set(v.key, v);
  const g = new Map<string, EnvVar[]>();
  for (const v of vars) {
    if (!v.key.endsWith("_API_KEY")) continue; // critical: skip _BASE_URL etc.
    const canon = v.canonical || v.key;
    if (!g.has(canon)) g.set(canon, []);
    g.get(canon)!.push(v);
  }
  return [...g.entries()]
    .map(([canon, members]) => {
      const base = byKey.get(canon) ?? members[0];
      const setMember = members.find((m) => m.isSet) ?? null;
      const entry: EnvVar = {
        ...base,
        key: canon,
        isSet: Boolean(setMember),
        advanced: members.every((m) => m.advanced),
      };
      const baseUrlVar =
        members
          .map((m) => byKey.get(m.key.replace(/_API_KEY$/, "_BASE_URL")))
          .find(Boolean) ?? null;
      return { entry, groupKeys: members.map((m) => m.key), baseUrlVar };
    })
    .sort((a, b) => prettyProvider(a.entry.key).localeCompare(prettyProvider(b.entry.key)));
}

// The curated "start here" providers (Groq etc.) flagged recommended in
// byok-providers — surfaced as a "Disarankan" badge + floated to the top of
// their section so a first-time user has a clear pick. The live catalog is
// keyed by the canonical env key; map the Google canonical back to the
// registry's GEMINI key before the lookup.
function isRecommendedKey(canonicalKey: string): boolean {
  const lookupKey =
    canonicalKey === "GOOGLE_API_KEY" ? "GEMINI_API_KEY" : canonicalKey;
  return getByokProvider(lookupKey)?.recommended === true;
}

// The easy/free starting picks (Groq recommended + the free-tier providers),
// surfaced as a STATIC hint row above the live methods so a first-timer sees
// "where do I start" without opening a dropdown. Static byok-providers data, so
// it renders even before the live catalog loads.
const RECOMMENDED_STARTERS = BYOK_PROVIDERS.filter(
  (p) => p.recommended || p.tier === "free",
);

// Collapsible "method" shell — each connection method (login / API key) lives
// behind one of these so the explanation up top has room and a first-timer
// isn't overwhelmed. Collapsed by default; the user opens the one they want.
function MethodSection({
  open,
  onToggle,
  icon,
  label,
  hint,
  children,
}: {
  open: boolean;
  onToggle: () => void;
  icon: ReactNode;
  label: string;
  hint: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-white/10 bg-white/[0.02]">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="flex w-full items-center gap-3 px-3.5 py-3 text-left transition-colors hover:bg-white/[0.03]"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-cyan-300">
          {icon}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-[13px] font-semibold text-white/90">
            {label}
          </span>
          <span className="mt-0.5 block text-[11px] leading-snug text-white/50">
            {hint}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-white/40 transition-transform",
            open && "rotate-180",
          )}
        />
      </button>
      {open ? (
        <div className="border-t border-white/[0.06] p-3">{children}</div>
      ) : null}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════════
export function StepByokLive({
  answers,
  set,
}: {
  answers: OnboardingAnswers;
  set: (patch: Partial<OnboardingAnswers>) => void;
}) {
  const { t } = useI18n();
  const c = t.onboarding.byok;
  const status = useAppStore((s) => s.status);
  const [oauth, setOauth] = useState<OAuthProvider[] | null>(null);
  const [vars, setVars] = useState<EnvVar[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  // Keys the USER explicitly connected THIS session. The platform seeds a
  // default GEMINI_API_KEY into every fresh container, so isSet alone is NOT
  // proof the user connected anything — only keys in this set count as
  // user-connected (this is the fix for the false "1 tersambung").
  const [userSetKeys, setUserSetKeys] = useState<Set<string>>(new Set());
  const [openCats, setOpenCats] = useState<Record<string, boolean>>(() => ({
    popular: true, regional: false, coding: false, selfhosted: false, custom: false,
  }));
  // Both connection methods start COLLAPSED so the explanation up top has room
  // and a first-timer opens only the one they want.
  const [methodOpen, setMethodOpen] = useState<{ oauth: boolean; key: boolean }>({
    oauth: false,
    key: false,
  });

  const handleKeyConnected = useCallback(
    (envKey: string) => {
      setUserSetKeys((prev) => new Set([...prev, envKey]));
      // The connected key is the CANONICAL env key (Google/Gemini collapses to
      // GOOGLE_API_KEY), but the byok registry keys Gemini under GEMINI_API_KEY.
      // Map the known canonical back so the forged-agent model answer resolves a
      // real defaultModel instead of an empty string.
      const lookupKey = envKey === "GOOGLE_API_KEY" ? "GEMINI_API_KEY" : envKey;
      const bp = getByokProvider(lookupKey);
      set({ modelProvider: bp?.id ?? envKey, modelDefault: bp?.defaultModel ?? "" });
    },
    [set],
  );
  const handleOauthConnected = useCallback(
    (id: string) => set({ modelProvider: `oauth:${id}`, modelDefault: "" }),
    [set],
  );

  const load = useCallback(async () => {
    try {
      const [o, e] = await Promise.all([
        rpc<{ providers: OAuthProvider[] }>("providers.oauthList"),
        rpc<{ vars: EnvVar[] }>("providers.envCatalog"),
      ]);
      const os = o.providers ?? [];
      const vs = e.vars ?? [];
      setOauth(os);
      setVars(vs);
      setErr(null);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "ready") load();
  }, [status, load]);

  // Safety net: the container-ready DB gate mounts this step, but the gateway WS
  // `status` is a separate signal — if it never reaches "ready" the load() effect
  // never fires and `loading` would spin forever. Surface the retry path after a
  // deadline so the step ALWAYS reaches an actionable state ("aman pasti dipakai").
  useEffect(() => {
    if (!loading) return;
    const id = setTimeout(() => {
      if (status !== "ready") {
        setLoading(false);
        setErr(c.loadTimeout);
      }
    }, 20000);
    return () => clearTimeout(id);
  }, [loading, status, c.loadTimeout]);

  // Visible providers: OAuth (minus the de-duped shadow entries) + the full LLM
  // key catalog. The key list is rendered inside a scroll container so the long
  // list never stretches the wizard card to the bottom.
  const oauthVisible = (oauth ?? [])
    .filter((p) => !OAUTH_HIDE.has(p.id))
    .sort((a, b) => oauthRank(a.id) - oauthRank(b.id));
  // Canonical-deduped groups (one card per provider, _BASE_URL dropped), bucketed
  // by category — exactly like the providers tab.
  const groups = useMemo(() => buildGroups(vars ?? []), [vars]);
  const byCategory = useMemo(() => {
    const m = new Map<ProviderCategory, KeyGroup[]>();
    for (const cat of CATEGORY_ORDER) m.set(cat, []);
    for (const g of groups) {
      const cat = (g.entry.category as ProviderCategory) ?? "regional";
      (m.get(cat) ?? m.get("regional")!).push(g);
    }
    // Float recommended "start here" providers to the top of their section.
    // groups arrive alpha-sorted and Array.sort is stable, so alpha order is
    // preserved within the recommended / non-recommended partitions.
    for (const cat of CATEGORY_ORDER) {
      m.get(cat)!.sort(
        (a, b) =>
          Number(isRecommendedKey(b.entry.key)) -
          Number(isRecommendedKey(a.entry.key)),
      );
    }
    return m;
  }, [groups]);
  // Honest count: only canonical providers the USER set this session (the
  // platform-seeded default key does NOT count) + real OAuth logins.
  const connectedCount =
    groups.filter((g) => g.entry.isSet && userSetKeys.has(g.entry.key)).length +
    oauthVisible.filter((p) => p.status.loggedIn).length;

  return (
    <div className="flex flex-col gap-4">
      <StepHeader
        icon={<KeyRound className="size-5 text-cyan-300" />}
        headline={c.headline}
        subheadline={c.subheadline}
      />

      {/* Lead with the ONE essential breath (what a provider is + why), then
          gate the full SIM-card story + benefits behind a disclosure — the step
          leads with the action, not a wall (skill: don't describe the UI inside
          it). Nothing deleted; the 90% who just want to pick a brain see one
          line, the 10% who want the story tap "Pelajari kenapa". */}
      <div className="rounded-xl border border-cyan-400/30 bg-cyan-400/[0.07] p-4">
        <div className="flex items-center gap-2">
          <Lightbulb className="size-4 shrink-0 text-amber-300" aria-hidden />
          <p className="text-[13.5px] font-semibold text-cyan-100">
            {c.explainTitle}
          </p>
        </div>
        <p className="mt-2 text-[11.5px] leading-relaxed text-white/70">
          {c.explainIntro}
        </p>
        <details className="group mt-2">
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-[11.5px] font-medium text-cyan-200 transition-colors hover:text-cyan-100 [&::-webkit-details-marker]:hidden">
            {c.explainMore}
            <ChevronDown className="size-3.5 transition-transform group-open:rotate-180" />
          </summary>
          <div className="mt-2 space-y-2 text-[11.5px] leading-relaxed text-white/70">
            {c.explainParas.map((p, i) => (
              <p key={i}>
                <span className="font-semibold text-white/85">{p.lead}</span>{" "}
                {p.text}
              </p>
            ))}
            <ul className="space-y-1.5">
              {c.explainBullets.map((b, i) => (
                <li key={i} className="flex gap-2">
                  <span
                    aria-hidden
                    className="mt-[7px] size-1 shrink-0 rounded-full bg-cyan-300/70"
                  />
                  <span>
                    <span className="font-semibold text-white/85">
                      {b.label}:
                    </span>{" "}
                    {b.text}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </details>
      </div>

      {/* Where to start — easy/free picks surfaced above the methods so a
          first-timer sees them without opening a dropdown. The actual connect
          cards live in the methods below (floated + "Disarankan" badged). */}
      <div className="flex flex-wrap items-center gap-1.5 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] px-3.5 py-2.5">
        <span className="text-[11px] font-medium text-cyan-100">
          {c.recommendedStart}
        </span>
        {/* Nous first — the easiest free pick (login, no key). Highlighted so it
            reads as the hero, matching its "GRATIS · DISARANKAN" card below. */}
        <span className="rounded-full border border-emerald-400/45 bg-emerald-400/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-100">
          Nous (Login)
        </span>
        {RECOMMENDED_STARTERS.map((p) => (
          <span
            key={p.id}
            className="rounded-full border border-white/10 bg-white/[0.06] px-2 py-0.5 text-[11px] font-medium text-white/85"
          >
            {p.label}
          </span>
        ))}
      </div>

      <div className="flex items-start gap-2.5 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3.5 py-2.5">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-300/80" />
        <p className="text-[11.5px] leading-relaxed text-white/55">{c.securityNote}</p>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2.5 py-10 text-white/55">
          <Loader2 className="size-5 animate-spin text-cyan-300" />
          <span className="text-[13px]">{c.loadingProviders}</span>
        </div>
      ) : err ? (
        <div className="rounded-xl border border-red-500/30 bg-red-500/[0.06] p-4 text-center">
          <p className="text-[12px] text-red-200">{err}</p>
          <button
            type="button"
            onClick={() => {
              setLoading(true);
              load();
            }}
            className="mt-2 text-[12px] font-medium text-cyan-300 hover:text-cyan-200"
          >
            {c.retryLoad}
          </button>
        </div>
      ) : (
        <>
          {connectedCount > 0 ? (
            <div className="flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/[0.06] px-3.5 py-2.5">
              <Check className="size-4 text-emerald-400" strokeWidth={3} />
              <p className="text-[12px] font-medium text-emerald-100">
                {c.connectedCount.replace("{n}", String(connectedCount))}
              </p>
            </div>
          ) : null}

          {/* Method 1 — login with an account (no API key). Collapsed by default. */}
          {oauthVisible.length > 0 ? (
            <MethodSection
              open={methodOpen.oauth}
              onToggle={() => setMethodOpen((s) => ({ ...s, oauth: !s.oauth }))}
              icon={<LogIn className="size-4" />}
              label={c.methodOauthLabel}
              hint={c.methodOauthHint}
            >
              <div className="grid gap-2 sm:grid-cols-2">
                {oauthVisible.map((p) => (
                  <OAuthCard
                    key={p.id}
                    provider={p}
                    onDone={load}
                    onConnected={handleOauthConnected}
                    c={c}
                  />
                ))}
              </div>
            </MethodSection>
          ) : null}

          {/* Method 2 — paste an API key. Collapsed by default; inner category
              accordion + scroll box unchanged. */}
          <MethodSection
            open={methodOpen.key}
            onToggle={() => setMethodOpen((s) => ({ ...s, key: !s.key }))}
            icon={<KeyRound className="size-4" />}
            label={c.methodKeyLabel}
            hint={c.methodKeyHint}
          >
            <div className="max-h-[400px] space-y-3 overflow-y-auto rounded-xl border border-white/[0.06] bg-black/20 p-2">
              {CATEGORY_ORDER.map((cat) => {
                const items = byCategory.get(cat) ?? [];
                if (items.length === 0) return null;
                const open = openCats[cat];
                const setN = items.filter(
                  (x) => x.entry.isSet && userSetKeys.has(x.entry.key),
                ).length;
                return (
                  <div key={cat}>
                    <button
                      type="button"
                      onClick={() => setOpenCats((s) => ({ ...s, [cat]: !s[cat] }))}
                      aria-expanded={open}
                      className="flex w-full items-center justify-between rounded-lg px-1.5 py-1 text-left"
                    >
                      <span className="text-[11px] font-semibold uppercase tracking-wider text-white/60">
                        {CATEGORY_META[cat].label}
                        <span className="ml-1.5 font-normal normal-case text-white/35">
                          ({items.length})
                        </span>
                        {setN > 0 ? (
                          <span className="ml-1.5 normal-case text-emerald-300/80">
                            · {setN} terisi
                          </span>
                        ) : null}
                      </span>
                      <ChevronDown
                        className={cn(
                          "size-4 shrink-0 text-white/40 transition-transform",
                          open && "rotate-180",
                        )}
                      />
                    </button>
                    {open ? (
                      <div className="mt-1.5 space-y-2">
                        {items.map((x) => (
                          <KeyCard
                            key={x.entry.key}
                            entry={x.entry}
                            groupKeys={x.groupKeys}
                            baseUrlVar={x.baseUrlVar}
                            onDone={load}
                            onConnected={handleKeyConnected}
                            c={c}
                          />
                        ))}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </MethodSection>

          {/* Skip affordance — BYOK is optional ("kasih otak nanti") */}
          <p className="text-center text-[11.5px] text-white/45">
            Belum siap? Tinggal klik{" "}
            <span className="font-medium text-white/70">Lanjut</span> — kamu bisa
            kasih otak nanti di aplikasi.
          </p>
        </>
      )}
    </div>
  );
}

// ── OAuth card + inline flow ────────────────────────────────────────────────
// Free / recommended OAuth logins. Nous is the hero free pick (login = no key,
// no card hunting) — badged + highlighted + floated first so a first-timer's eye
// lands on the easiest free option.
const FREE_OAUTH = new Set(["nous", "qwen-oauth"]);
const RECOMMENDED_OAUTH = "nous";
function oauthRank(id: string): number {
  if (id === RECOMMENDED_OAUTH) return 0;
  if (FREE_OAUTH.has(id)) return 1;
  return 2;
}

function OAuthCard({
  provider,
  onDone,
  onConnected,
  c,
}: {
  provider: OAuthProvider;
  onDone: () => void;
  onConnected: (id: string) => void;
  c: ByokI18n;
}) {
  const [open, setOpen] = useState(false);
  const display = OAUTH_DISPLAY[provider.id]?.name ?? provider.name;
  const sub = OAUTH_DISPLAY[provider.id]?.sub ?? null;
  const loggedIn = provider.status.loggedIn;
  const isFree = FREE_OAUTH.has(provider.id);
  const isRec = provider.id === RECOMMENDED_OAUTH;

  return (
    <div
      className={cn(
        "rounded-xl border p-3 transition-colors",
        loggedIn
          ? "border-emerald-400/30 bg-emerald-400/[0.05]"
          : isRec
            ? "border-emerald-400/50 bg-emerald-400/[0.07] shadow-[0_0_0_1px_rgba(52,211,153,0.12),0_0_24px_-8px_rgba(52,211,153,0.5)]"
            : "border-white/10 bg-white/[0.03]",
      )}
    >
      <div className="flex items-center gap-2.5">
        <ProviderLogo
          src={logoForOauth(provider.id)}
          size={32}
          fallback={
            <span className="flex size-8 items-center justify-center rounded-md bg-white/5">
              <Lock className="size-4 text-white/40" />
            </span>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <p className="truncate text-[13px] font-semibold text-white">{display}</p>
            {isRec ? (
              <span className="shrink-0 rounded-full border border-emerald-400/45 bg-emerald-400/15 px-1.5 py-0.5 text-[8.5px] font-bold uppercase tracking-wide text-emerald-200">
                {c.freeBadge} · {c.recommendedBadge}
              </span>
            ) : isFree ? (
              <span className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 text-[8.5px] font-semibold text-emerald-200">
                {c.freeBadge}
              </span>
            ) : null}
          </div>
          {sub ? <p className="truncate text-[10.5px] text-white/45">{sub}</p> : null}
        </div>
        {loggedIn ? (
          <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-300">
            <Check className="size-3.5" strokeWidth={3} /> {c.oauthConnected}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((s) => !s)}
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1.5 text-[11px] font-medium text-cyan-200 hover:bg-cyan-400/15"
          >
            <LogIn className="size-3.5" /> {c.oauthLogin}
          </button>
        )}
      </div>
      {open && !loggedIn ? (
        provider.flow === "external" ? (
          <OAuthExternalFlow
            provider={provider}
            c={c}
            onClose={() => setOpen(false)}
            onSuccess={() => {
              setOpen(false);
              onConnected(provider.id);
              onDone();
            }}
          />
        ) : (
          <OAuthFlow
            provider={provider}
            c={c}
            onClose={() => setOpen(false)}
            onSuccess={() => {
              setOpen(false);
              onConnected(provider.id);
              onDone();
            }}
          />
        )
      ) : null}
    </div>
  );
}

function OAuthFlow({
  provider,
  c,
  onClose,
  onSuccess,
}: {
  provider: OAuthProvider;
  c: ByokI18n;
  onClose: () => void;
  onSuccess: () => void;
}) {
  // Mirror /app/providers SubprocessFlow EXACTLY: two effects (start → flowId
  // state → gated poll loop), a `starting` phase, and a visible error box for
  // start OR poll failures. Same wire RPCs, same 1500ms cadence — the only
  // difference vs the tab is this renders inline in the wizard, not in a modal.
  const [flowId, setFlowId] = useState<string | null>(null);
  const [poll, setPoll] = useState<PollResult | null>(null);
  const [relayInput, setRelayInput] = useState("");
  const [relaying, setRelaying] = useState(false);
  const [starting, setStarting] = useState(true);
  const [startErr, setStartErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cursor = useRef(0);
  const flowRef = useRef<string | null>(null);
  const tut = tutorialForOauth(provider.id);

  // start once
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await rpc<{ flowId: string }>("providers.oauth.start", { provider: provider.id });
        if (!alive) {
          // Closed during the start RPC — cancel the just-spawned flow.
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

  // poll loop — gated on flowId so a start() failure never strands a null poll
  useEffect(() => {
    if (!flowId) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const p = await rpc<PollResult>("providers.oauth.poll", { flowId, cursor: cursor.current });
        if (!alive) return;
        cursor.current = p.cursor ?? cursor.current;
        setPoll(p);
        if (p.status === "success") {
          onSuccess();
          return;
        }
        // Surface only a real error; a cancelled flow just stops polling (the
        // user re-opens to retry) — identical to the providers tab.
        if (p.status === "error" || p.status === "cancelled") return;
      } catch {
        // Transient (engine briefly busy right after spawn) — SWALLOW + keep
        // polling. A real failure returns status="error" above (which stops us).
      }
      if (alive) timer = setTimeout(tick, 1500);
    };
    void tick();
    return () => {
      alive = false;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [flowId, provider, onSuccess]);

  const relay = async () => {
    const input = relayInput.trim();
    // Bounded passthrough: a redirect URL or short device code, nothing huge.
    if (!flowId || input.length < 3 || input.length > 2000 || relaying) return;
    setRelaying(true);
    try {
      await rpc("providers.oauth.relay", { flowId, input });
      setRelayInput("");
    } catch (e) {
      setStartErr(errMsg(e));
    } finally {
      setRelaying(false);
    }
  };

  const copyCode = (code: string) => {
    navigator.clipboard?.writeText(code).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      },
      () => {},
    );
  };

  const url = poll?.url ?? null;
  const code = poll?.userCode ?? null;
  const needsInput = Boolean(poll?.needsInput && poll.status === "running");
  const pollErr = poll?.status === "error" ? (poll.error || "Login gagal.") : null;
  const errText = startErr || pollErr;

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-white/10 pt-3">
      {tut ? (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
          <p className="text-[11.5px] font-semibold text-white/80">{tut.title}</p>
          {tut.steps.length ? (
            <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11px] leading-snug text-white/55">
              {tut.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          ) : null}
          {tut.note ? (
            <p className="mt-1.5 text-[11px] font-medium text-emerald-300/90">
              {tut.note}
            </p>
          ) : null}
        </div>
      ) : null}
      {errText ? (
        <div className="rounded-lg border border-red-400/30 bg-red-500/[0.06] px-3 py-2 text-[12px] text-red-200">
          {errText}
        </div>
      ) : starting || !url ? (
        <div className="flex items-center gap-2 text-[12px] text-white/55">
          <Loader2 className="size-4 animate-spin text-cyan-300" /> {c.oauthWaiting}
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-[12px] font-medium text-cyan-200 hover:bg-cyan-400/15"
          >
            <ExternalLink className="size-3.5" /> {c.oauthOpenLink}
          </a>
          <CopyBtn text={url} label="link" />
        </div>
      )}

      {code && !errText ? (
        <div className="rounded-xl border border-cyan-400/40 bg-cyan-400/[0.08] p-3 text-center">
          <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-300/80">
            {c.oauthCode}
          </p>
          <div className="mt-1.5 flex items-center justify-center gap-2">
            <span className="select-all font-mono text-2xl font-bold tracking-[0.18em] text-white">
              {code}
            </span>
            <button
              type="button"
              onClick={() => copyCode(code)}
              aria-label={c.copyCode}
              className="rounded-lg border border-white/15 bg-white/[0.06] p-1.5 text-white/70 transition-colors hover:border-cyan-400/40 hover:text-cyan-200"
            >
              {copied ? <Check className="size-4" /> : <Copy className="size-4" />}
            </button>
          </div>
        </div>
      ) : null}

      {!errText && needsInput ? (
        <div className="flex gap-2">
          <input
            value={relayInput}
            onChange={(e) => setRelayInput(e.target.value.slice(0, 2000))}
            onKeyDown={(e) => { if (e.key === "Enter") void relay(); }}
            placeholder={c.oauthPastePlaceholder}
            className="h-9 flex-1 rounded-lg border border-white/10 bg-white/[0.03] px-3 text-[12px] text-white placeholder:text-white/30 focus:border-cyan-400/70 focus:outline-none"
          />
          <button
            type="button"
            onClick={relay}
            disabled={relayInput.trim().length < 3 || relaying}
            className="rounded-lg border border-cyan-400/30 bg-cyan-400/10 px-3 text-[12px] font-medium text-cyan-200 hover:bg-cyan-400/15 disabled:opacity-50"
          >
            {relaying ? <Loader2 className="size-3.5 animate-spin" /> : c.oauthSubmit}
          </button>
        </div>
      ) : !errText && url ? (
        <div className="flex items-center gap-2 text-[12px] text-emerald-300/80">
          <Loader2 className="size-3.5 animate-spin" /> {c.oauthApprove}
        </div>
      ) : null}

      <button
        type="button"
        onClick={onClose}
        className="self-start text-[11px] font-medium text-white/40 hover:text-white/70"
      >
        {c.oauthCancel}
      </button>
    </div>
  );
}

// Small icon-only copy button — same affordance as the providers-tab CopyBtn,
// kept local so this onboarding component stays decoupled from the tab.
function CopyBtn({ text, label = "teks" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      aria-label={`Salin ${label}`}
      onClick={() =>
        navigator.clipboard?.writeText(text).then(
          () => {
            setDone(true);
            setTimeout(() => setDone(false), 1500);
          },
          () => {},
        )
      }
      className="shrink-0 rounded-lg border border-white/15 bg-white/[0.06] p-1.5 text-white/70 transition-colors hover:border-cyan-400/40 hover:text-cyan-200"
    >
      {done ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
    </button>
  );
}

// External OAuth (claude-code = paste token, qwen-oauth = paste oauth_creds.json).
// These do NOT poll — they take a pasted credential via the SAME proven bridge
// methods the /app/providers tab uses (providers.claudeCreds / providers.qwenCreds).
// Routing here (instead of the generic poll flow) is what fixes the bridge's
// "Login belum berhasil" on Claude/Qwen.
function OAuthExternalFlow({
  provider,
  c,
  onClose,
  onSuccess,
}: {
  provider: OAuthProvider;
  c: ByokI18n;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isClaude = provider.id === "claude-code";
  const hasCli = Boolean(provider.cliCommand);
  const tut = tutorialForOauth(provider.id);

  const submit = async () => {
    if (!value.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isClaude) await rpc("providers.claudeCreds", { token: value.trim() });
      else await rpc("providers.qwenCreds", { json: value.trim() });
      onSuccess();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-3 flex flex-col gap-3 border-t border-white/10 pt-3">
      {tut ? (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
          <p className="text-[11.5px] font-semibold text-white/80">{tut.title}</p>
          {tut.steps.length ? (
            <ol className="mt-1.5 list-decimal space-y-1 pl-4 text-[11px] leading-snug text-white/55">
              {tut.steps.map((s, i) => (
                <li key={i}>{s}</li>
              ))}
            </ol>
          ) : null}
          {tut.note ? (
            <p className="mt-1.5 text-[11px] font-medium text-emerald-300/90">
              {tut.note}
            </p>
          ) : null}
        </div>
      ) : null}

      {hasCli ? (
        <div className="flex items-center gap-2 rounded-lg border border-white/10 bg-black/40 px-3 py-2">
          <code className="min-w-0 flex-1 select-all break-all font-mono text-[11.5px] text-cyan-200">
            {provider.cliCommand}
          </code>
          <CopyBtn text={provider.cliCommand} label="perintah" />
        </div>
      ) : null}

      <textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={isClaude ? 2 : 4}
        placeholder={isClaude ? "Tempel token Claude Code…" : '{ "access_token": "...", ... }'}
        aria-label={isClaude ? "Token Claude Code" : "Isi oauth_creds.json"}
        className="w-full resize-none rounded-lg border border-white/10 bg-black/40 px-2.5 py-2 font-mono text-[11.5px] text-white placeholder:text-white/30 outline-none focus:border-amber-400/60"
      />
      {error ? <p className="text-[12px] text-red-300">{error}</p> : null}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={!value.trim() || busy}
        className="flex w-full items-center justify-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-[12.5px] font-semibold text-[#0B0E14] transition hover:brightness-110 disabled:opacity-50"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
        {c.connectCta}
      </button>
      <button
        type="button"
        onClick={onClose}
        className="self-start text-[11px] font-medium text-white/40 hover:text-white/70"
      >
        {c.oauthCancel}
      </button>
    </div>
  );
}

// ── API key card + inline set ──────────────────────────────────────────────
function KeyCard({
  entry,
  groupKeys,
  baseUrlVar,
  onDone,
  onConnected,
  c,
}: {
  entry: EnvVar;
  groupKeys: string[];
  baseUrlVar: EnvVar | null;
  onDone: () => void;
  onConnected: (envKey: string) => void;
  c: ByokI18n;
}) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState("");
  const [baseVal, setBaseVal] = useState("");
  const [reveal, setReveal] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = prettyProvider(entry.key);
  const recommended = isRecommendedKey(entry.key);
  const tut = tutorialForKey(entry.key, name, entry.url ?? undefined);

  const save = async () => {
    if (value.trim().length < 4) return;
    setSaving(true);
    setError(null);
    try {
      await rpc("providers.setEnv", { key: entry.key, value: value.trim() });
      // Clean up alias keys so there's never a stale second copy (e.g. drop the
      // platform-seeded GEMINI_API_KEY when canonical is GOOGLE_API_KEY).
      for (const k of groupKeys) {
        if (k !== entry.key) await rpc("providers.deleteEnv", { key: k }).catch(() => {});
      }
      if (baseUrlVar && baseVal.trim()) {
        await rpc("providers.setEnv", {
          key: baseUrlVar.key,
          value: baseVal.trim(),
        }).catch(() => {});
      }
      setValue("");
      // setEnv restarts the engine (~10-30s while it re-reads .env). Poll the
      // catalog until THIS key actually reads back isSet, or a deadline — so we
      // never show "still unset" for a key that already saved. The reconnecting
      // RPC queues and resolves once the engine is health-green again.
      const deadline = Date.now() + 18_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1500));
        try {
          const e = await rpc<{ vars?: { key: string; isSet?: boolean }[] }>(
            "providers.envCatalog",
          );
          if ((e.vars ?? []).some((v) => v.key === entry.key && v.isSet)) break;
        } catch {
          /* engine still restarting — keep polling */
        }
      }
      // VALIDATE the key actually WORKS — probe the provider's /models, not just
      // confirm it's set. Definitive-reject-only: block only a confirmed-invalid
      // key; accept valid / unsupported / transient-error so a good key is never
      // false-blocked during the engine warm-up.
      let status = "error";
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const r = await rpc<{ status?: string }>("providers.testKey", {
            key: entry.key,
          });
          status = r.status ?? "error";
          if (status !== "error") break;
        } catch {
          /* engine busy — retry */
        }
        await new Promise((r) => setTimeout(r, 2500));
      }
      if (status === "invalid") {
        // Key is set but the provider rejected it — keep the input open so the
        // user can paste a correct one. NOT marked connected.
        setError(c.invalidKeyLabel);
        return;
      }
      setOpen(false);
      onConnected(entry.key); // user-confirmed connection (honest count)
      onDone();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className={cn(
        "rounded-xl border p-3 transition-colors",
        entry.isSet ? "border-emerald-400/25 bg-emerald-400/[0.04]" : "border-white/10 bg-white/[0.03]",
      )}
    >
      <div className="flex items-center gap-2.5">
        <ProviderLogo
          src={logoForKey(entry.key)}
          size={28}
          fallback={
            <span className="flex size-7 items-center justify-center rounded-md bg-white/5">
              <KeyRound className="size-3.5 text-white/40" />
            </span>
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-[12.5px] font-semibold text-white">{name}</span>
            {recommended ? (
              <span className="rounded-full border border-cyan-400/40 bg-cyan-400/15 px-1.5 py-0.5 text-[8.5px] font-semibold text-cyan-200">
                {c.recommendedBadge}
              </span>
            ) : null}
            {entry.free ? (
              <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 text-[8.5px] font-semibold text-emerald-200">
                {c.freeBadge}
              </span>
            ) : null}
          </div>
        </div>
        {entry.isSet ? (
          <span className="flex items-center gap-1 text-[11px] font-medium text-emerald-300">
            <Check className="size-3.5" strokeWidth={3} /> {c.keySet}
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setOpen((s) => !s)}
            className="rounded-lg border border-white/15 bg-white/[0.04] px-2.5 py-1.5 text-[11px] font-medium text-white/80 hover:border-cyan-400/40"
          >
            {c.setKey}
          </button>
        )}
      </div>

      {open && !entry.isSet ? (
        <div className="mt-3 flex flex-col gap-2 border-t border-white/10 pt-3">
          {tut ? (
            <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/[0.04] p-2.5">
              <p className="mb-1.5 text-[11px] font-semibold text-cyan-200/90">{tut.title}</p>
              <ol className="space-y-1">
                {tut.steps.map((s, i) => (
                  <li key={i} className="flex gap-1.5 text-[11px] leading-snug text-white/65">
                    <span className="font-mono text-[9px] font-bold text-cyan-300">{i + 1}.</span>
                    <span>{s}</span>
                  </li>
                ))}
              </ol>
              {tut.url ? (
                <a
                  href={tut.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-2 inline-flex items-center gap-1 text-[11px] font-medium text-cyan-300 hover:text-cyan-200"
                >
                  <ExternalLink className="size-3" /> {tut.urlLabel ?? c.getKeyLabel}
                </a>
              ) : null}
            </div>
          ) : null}
          <div className="relative">
            <input
              type={reveal ? "text" : "password"}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                if (error) setError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") save();
              }}
              placeholder={c.keyPlaceholder}
              maxLength={400}
              className="h-10 w-full rounded-lg border border-white/10 bg-white/[0.03] pl-3 pr-10 text-[13px] text-white placeholder:text-white/30 focus:border-cyan-400/70 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => setReveal((r) => !r)}
              aria-label={reveal ? c.hideKeyAria : c.showKeyAria}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-white/40 hover:text-white/80"
            >
              {reveal ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {baseUrlVar ? (
            <input
              value={baseVal}
              onChange={(e) => setBaseVal(e.target.value.slice(0, 300))}
              placeholder="Base URL (opsional)"
              className="h-9 w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 text-[12px] text-white placeholder:text-white/30 focus:border-cyan-400/70 focus:outline-none"
            />
          ) : null}
          {error ? <p className="text-[11.5px] text-red-300">{error}</p> : null}
          <div className="flex items-center gap-2">
            <PrimaryButton onClick={save} disabled={value.trim().length < 4} loading={saving}>
              {saving ? c.connectingLabel : c.connectCta}
            </PrimaryButton>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label={c.oauthCancel}
              className="text-[11px] font-medium text-white/40 hover:text-white/70"
            >
              <X className="size-3.5" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
