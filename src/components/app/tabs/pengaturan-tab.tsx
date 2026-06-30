"use client";

/**
 * PengaturanTab — friendly mass-market Settings for /app/pengaturan.
 *
 * Mirrors the Nous desktop Settings surface but trimmed to the controls a
 * non-developer actually wants, in plain Bahasa. EVERY control maps to a REAL
 * engine config field (live-probed on 0.16.0) — nothing fabricated:
 *   - load  : `config.get`  → {value: <full config>} (res.payload.value)
 *   - save  : `config.patch` { patch, restart:true } → persists to config.yaml
 *             AND restarts the engine (~10s) so the change takes effect now.
 *
 * Theme is the one exception — it's a portal (next-themes) preference, not an
 * engine field, so it applies instantly with no save/restart.
 *
 * Dev-only / fake-able controls (raw config JSON, MCP servers, gateway URL,
 * version/about, per-task aux models, etc.) are deliberately NOT here — see
 * memory/settings_page_build_2026-06-12.md for the DO-NOT-BUILD list.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useTheme } from "next-themes";
import {
  BrainCircuit,
  KeyRound,
  Loader2,
  Palette,
  Save,
  Settings as SettingsIcon,
  ShieldCheck,
  Sparkles,
  Volume2,
  X,
} from "lucide-react";
import { useRpc } from "@/lib/app/use-rpc";
import { getClient, useAppStore } from "@/lib/app/store";
import { GatewayError } from "@/lib/hermes/browser-gateway";
import { useI18n } from "@/lib/i18n/context";
import { cn } from "@/lib/utils";
import { ProfileSection } from "@/components/app/settings/profile-section";
import { DangerZone } from "@/components/app/settings/danger-zone";
import {
  SETTINGS_SCROLL_ID,
  settingsDomId,
} from "@/components/app/settings/sections";
import {
  NumberRow,
  Row,
  SELECT_CLS,
  SelectRow,
  ToggleRow,
} from "@/components/app/settings/primitives";
import { VoiceSettings } from "@/components/app/settings/voice-settings";

type Cfg = Record<string, unknown>;

// Curated, VALID IANA timezone ids (engine field `timezone` = IANA, per
// config.py:1795; all resolve via zoneinfo). Indonesia-first, then regional +
// world. "" = follow system (the engine default). Friendly labels; the value
// is always a real IANA id the engine accepts.
const TIMEZONE_IANA: { value: string; label: string }[] = [
  { value: "", label: "" }, // → systemDefault label injected at render
  { value: "Asia/Jakarta", label: "Jakarta · WIB (Asia/Jakarta)" },
  { value: "Asia/Makassar", label: "Makassar/Bali · WITA (Asia/Makassar)" },
  { value: "Asia/Jayapura", label: "Jayapura · WIT (Asia/Jayapura)" },
  { value: "Asia/Singapore", label: "Singapura (Asia/Singapore)" },
  { value: "Asia/Kuala_Lumpur", label: "Malaysia (Asia/Kuala_Lumpur)" },
  { value: "Asia/Bangkok", label: "Bangkok (Asia/Bangkok)" },
  { value: "Asia/Manila", label: "Manila (Asia/Manila)" },
  { value: "Asia/Tokyo", label: "Tokyo (Asia/Tokyo)" },
  { value: "Asia/Shanghai", label: "China (Asia/Shanghai)" },
  { value: "Asia/Hong_Kong", label: "Hong Kong (Asia/Hong_Kong)" },
  { value: "Asia/Kolkata", label: "India (Asia/Kolkata)" },
  { value: "Asia/Dubai", label: "Dubai (Asia/Dubai)" },
  { value: "Europe/London", label: "London (Europe/London)" },
  { value: "Europe/Paris", label: "Eropa Tengah (Europe/Paris)" },
  { value: "America/New_York", label: "New York (America/New_York)" },
  { value: "America/Los_Angeles", label: "Los Angeles (America/Los_Angeles)" },
  { value: "Australia/Sydney", label: "Sydney (Australia/Sydney)" },
  { value: "UTC", label: "UTC" },
];

function timezoneOptions(
  current: string,
  systemLabel: string,
): { value: string; label: string }[] {
  const base = TIMEZONE_IANA.map((o) => ({
    value: o.value,
    label: o.value === "" ? systemLabel : o.label,
  }));
  // Preserve a value the user set elsewhere (e.g. desktop) that isn't curated.
  if (current && !TIMEZONE_IANA.some((o) => o.value === current)) {
    base.push({ value: current, label: current });
  }
  return base;
}

function getPath(obj: Cfg | undefined, path: string): unknown {
  if (!obj) return undefined;
  return path.split(".").reduce<unknown>((o, k) => {
    if (o && typeof o === "object" && k in (o as Record<string, unknown>)) {
      return (o as Record<string, unknown>)[k];
    }
    return undefined;
  }, obj);
}

// Build a nested merge-patch object from a flat { "a.b.c": value } draft.
function buildPatch(draft: Record<string, unknown>): Cfg {
  const out: Cfg = {};
  for (const [path, value] of Object.entries(draft)) {
    const keys = path.split(".");
    let cur = out;
    for (let i = 0; i < keys.length - 1; i++) {
      const k = keys[i];
      if (typeof cur[k] !== "object" || cur[k] === null) cur[k] = {};
      cur = cur[k] as Cfg;
    }
    cur[keys[keys.length - 1]] = value;
  }
  return out;
}

function rpc<T>(method: string, params?: unknown): Promise<T> {
  const client = getClient();
  if (!client) return Promise.reject(new Error("Belum terhubung ke engine."));
  return client.request<T>(method, params ?? {});
}

type SaveState = "idle" | "saving" | "saved" | "failed";

export function PengaturanTab() {
  const { t } = useI18n();
  const s = t.app.settings;
  // Active category (tabbed) — set by the sub-sidebar rail. Only the matching
  // section renders, so categories never stack together.
  const active = useAppStore((st) => st.settingsCategory);
  // Web chat verbosity (client render pref, instant) — vs the channel toggle
  // below which is a staged engine config field (display.tool_progress).
  const showToolProgress = useAppStore((st) => st.showToolProgress);
  const setShowToolProgress = useAppStore((st) => st.setShowToolProgress);

  const { data, loading, error, refetch } = useRpc<{ value: Cfg }>({
    method: "config.get",
  });
  const cfg = data?.value;

  const [draft, setDraft] = useState<Record<string, unknown>>({});
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [saveErr, setSaveErr] = useState<string | null>(null);

  // Current value of a path = staged draft override, else the loaded config.
  const curr = useCallback(
    (path: string): unknown =>
      Object.prototype.hasOwnProperty.call(draft, path)
        ? draft[path]
        : getPath(cfg, path),
    [draft, cfg],
  );
  const setField = useCallback((path: string, value: unknown) => {
    setSaveState("idle");
    setDraft((d) => ({ ...d, [path]: value }));
  }, []);

  const isDirty = Object.keys(draft).length > 0;

  const save = useCallback(async () => {
    if (Object.keys(draft).length === 0) return;
    setSaveState("saving");
    setSaveErr(null);
    try {
      await rpc("config.patch", { patch: buildPatch(draft), restart: true });
      setDraft({});
      setSaveState("saved");
      // Bridge persists to config.yaml synchronously; refetch shows the new
      // values immediately (the engine restart it triggered is backgrounded).
      void refetch();
      window.setTimeout(() => setSaveState("idle"), 2500);
    } catch (e) {
      setSaveState("failed");
      setSaveErr(
        e instanceof GatewayError
          ? e.message || String(e.code)
          : e instanceof Error
            ? e.message
            : s.saveBar.failed,
      );
    }
  }, [draft, refetch, s.saveBar.failed]);

  if (loading && !cfg) {
    return (
      <Centered>
        <Loader2 className="size-5 animate-spin text-cyan-300/70" />
        <span className="text-sm text-white/55">{s.loading}</span>
      </Centered>
    );
  }
  if (error && !cfg) {
    return (
      <Centered>
        <span className="text-sm text-red-300">{s.error}</span>
        <button
          type="button"
          onClick={() => void refetch()}
          className="rounded-lg border border-white/10 bg-white/[0.05] px-3 py-1.5 text-sm text-white/80 transition hover:border-cyan-400/40"
        >
          {s.retry}
        </button>
      </Centered>
    );
  }

  return (
    <div id={SETTINGS_SCROLL_ID} className="relative h-full overflow-y-auto px-4 py-6 xl:px-8">
      <div className="mx-auto flex max-w-2xl flex-col gap-5 pb-28">
        {/* Header */}
        <header className="flex items-start gap-3">
          <div className="relative grid size-9 shrink-0 place-items-center rounded-xl border border-white/10 bg-gradient-to-br from-cyan-400/20 to-fuchsia-500/20">
            <SettingsIcon className="size-4 text-cyan-200" />
          </div>
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-white">{s.title}</h1>
            <p className="mt-0.5 text-sm text-white/50">{s.subtitle}</p>
          </div>
        </header>

        {/* Profil — pinned at the top, always visible (Chief's choice:
            a Profil section inside Pengaturan). Identity + read-only email. */}
        <ProfileSection />

        {/* AI & Model */}
        <Section show={active === "ai"} id={settingsDomId("ai")} icon={<Sparkles className="size-4 text-cyan-300" />} title={s.sections.ai.title} desc={s.sections.ai.desc}>
          <ToggleRow
            label={s.fields.showReasoning.label}
            help={s.fields.showReasoning.help}
            checked={Boolean(curr("display.show_reasoning"))}
            onChange={(v) => setField("display.show_reasoning", v)}
          />
          <SelectRow
            label={s.fields.timezone.label}
            help={s.fields.timezone.help}
            value={String(curr("timezone") ?? "")}
            options={timezoneOptions(
              String(curr("timezone") ?? ""),
              s.fields.timezone.systemDefault,
            )}
            onChange={(v) => setField("timezone", v)}
          />
          {/* Web: instant client render pref (NOT staged). */}
          <ToggleRow
            label={s.fields.webToolProgress.label}
            help={s.fields.webToolProgress.help}
            checked={showToolProgress}
            onChange={setShowToolProgress}
          />
          {/* Channel: staged engine config — gateway checks `!= "off"`. */}
          <ToggleRow
            label={s.fields.channelToolProgress.label}
            help={s.fields.channelToolProgress.help}
            checked={curr("display.tool_progress") !== "off"}
            onChange={(v) => setField("display.tool_progress", v ? "all" : "off")}
          />
        </Section>

        {/* Suara & Bahasa */}
        <Section show={active === "voice"} id={settingsDomId("voice")} icon={<Volume2 className="size-4 text-fuchsia-300" />} title={s.sections.voice.title} desc={s.sections.voice.desc}>
          <VoiceSettings curr={curr} setField={setField} />
        </Section>

        {/* Ingatan AI */}
        <Section show={active === "memory"} id={settingsDomId("memory")} icon={<BrainCircuit className="size-4 text-indigo-300" />} title={s.sections.memory.title} desc={s.sections.memory.desc}>
          <ToggleRow
            label={s.fields.memoryEnabled.label}
            help={s.fields.memoryEnabled.help}
            checked={Boolean(curr("memory.memory_enabled"))}
            onChange={(v) => setField("memory.memory_enabled", v)}
          />
          <ToggleRow
            label={s.fields.userProfile.label}
            help={s.fields.userProfile.help}
            checked={Boolean(curr("memory.user_profile_enabled"))}
            onChange={(v) => setField("memory.user_profile_enabled", v)}
          />
          <ToggleRow
            label={s.fields.compression.label}
            help={s.fields.compression.help}
            checked={Boolean(curr("compression.enabled"))}
            onChange={(v) => setField("compression.enabled", v)}
          />
        </Section>

        {/* Keamanan & Izin */}
        <Section show={active === "safety"} id={settingsDomId("safety")} icon={<ShieldCheck className="size-4 text-emerald-300" />} title={s.sections.safety.title} desc={s.sections.safety.desc}>
          <SelectRow
            label={s.fields.approvalMode.label}
            help={
              {
                manual: s.fields.approvalMode.manualHint,
                smart: s.fields.approvalMode.smartHint,
                off: s.fields.approvalMode.offHint,
              }[String(curr("approvals.mode") ?? "manual")] ??
              s.fields.approvalMode.help
            }
            value={String(curr("approvals.mode") ?? "manual")}
            options={[
              { value: "manual", label: s.fields.approvalMode.manual },
              { value: "smart", label: s.fields.approvalMode.smart },
              { value: "off", label: s.fields.approvalMode.off },
            ]}
            onChange={(v) => setField("approvals.mode", v)}
          />
          <NumberRow
            label={s.fields.approvalTimeout.label}
            help={s.fields.approvalTimeout.help}
            unit={s.fields.approvalTimeout.unit}
            value={Number(curr("approvals.timeout") ?? 60)}
            min={5}
            max={600}
            onChange={(v) => setField("approvals.timeout", v)}
          />
        </Section>

        {/* Tampilan (theme — portal pref, instant) */}
        <Section show={active === "appearance"} id={settingsDomId("appearance")} icon={<Palette className="size-4 text-white/70" />} title={s.sections.appearance.title} desc={s.sections.appearance.desc}>
          <ThemeRow
            label={s.fields.theme.label}
            help={s.fields.theme.help}
            options={[
              { value: "light", label: s.fields.theme.light },
              { value: "dark", label: s.fields.theme.dark },
              { value: "system", label: s.fields.theme.system },
            ]}
          />
          <LanguageRow
            label={s.fields.language.label}
            help={s.fields.language.help}
          />
        </Section>

        {/* Penyedia AI & Kunci → existing page */}
        <Section show={active === "providers"} id={settingsDomId("providers")} icon={<KeyRound className="size-4 text-amber-300" />} title={s.sections.providers.title} desc={s.sections.providers.desc}>
          <div className="pt-1">
            <Link
              href="/app/providers"
              className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.04] px-4 py-2 text-sm font-medium text-white/85 transition hover:border-cyan-400/40 hover:bg-white/[0.08]"
            >
              <KeyRound className="size-4" />
              {s.sections.providers.cta}
            </Link>
          </div>
        </Section>

        {/* Akun — account deletion lives ONLY on its own tab (sidebar category
            "account") so the irreversible "Hapus Akun" can't be mis-clicked from
            another category. DangerZone is its own titled card (no card-in-card). */}
        {active === "account" ? <DangerZone /> : null}
      </div>

      {/* Sticky save bar */}
      {(isDirty || saveState !== "idle") && (
        <div className="pointer-events-none sticky bottom-0 left-0 right-0 flex justify-center px-4 pb-4">
          <div className="pointer-events-auto flex w-full max-w-2xl items-center gap-3 rounded-2xl border border-cyan-400/30 bg-[#0B0E14]/90 px-4 py-3 shadow-[0_18px_50px_-12px_rgba(34,211,238,0.4)] backdrop-blur-xl">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-white/90">
                {saveState === "saving"
                  ? s.saveBar.saving
                  : saveState === "saved"
                    ? s.saveBar.saved
                    : saveState === "failed"
                      ? saveErr || s.saveBar.failed
                      : s.saveBar.dirty}
              </div>
              {saveState !== "failed" && (
                <div className="mt-0.5 truncate text-xs text-white/45">
                  {s.saveBar.applyNote}
                </div>
              )}
            </div>
            {saveState !== "saving" && saveState !== "saved" && (
              <button
                type="button"
                onClick={() => {
                  setDraft({});
                  setSaveState("idle");
                }}
                className="inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs text-white/55 transition hover:text-white/80"
              >
                <X className="size-3.5" />
                {s.saveBar.discard}
              </button>
            )}
            <button
              type="button"
              disabled={saveState === "saving" || !isDirty}
              onClick={() => void save()}
              className={cn(
                "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-semibold transition",
                saveState === "saving"
                  ? "bg-white/10 text-white/50"
                  : "bg-gradient-to-br from-cyan-400 via-indigo-500 to-fuchsia-500 text-[#0B0E14] hover:brightness-110 active:scale-[0.97]",
              )}
            >
              {saveState === "saving" ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Save className="size-4" />
              )}
              {s.saveBar.save}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── primitives ──────────────────────────────────────────────────────────────

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3">
      {children}
    </div>
  );
}

function Section({
  id,
  show = true,
  icon,
  title,
  desc,
  children,
}: {
  id?: string;
  show?: boolean;
  icon: React.ReactNode;
  title: string;
  desc: string;
  children: React.ReactNode;
}) {
  if (!show) return null;
  return (
    <section
      id={id}
      className="scroll-mt-4 rounded-2xl border border-white/[0.06] bg-[#0B0E14]/40 p-5 backdrop-blur-xl"
    >
      <div className="mb-0.5 flex items-center gap-2">
        {icon}
        <h2 className="text-base font-semibold text-white">{title}</h2>
      </div>
      <p className="mb-2 text-xs text-white/45">{desc}</p>
      <div className="divide-y divide-white/[0.05]">{children}</div>
    </section>
  );
}

// Theme is a portal preference (next-themes), applied instantly — NOT an engine
// field, so it lives outside the draft/save flow.
function ThemeRow({
  label,
  help,
  options,
}: {
  label: string;
  help?: string;
  options: { value: string; label: string }[];
}) {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  return (
    <Row
      label={label}
      help={help}
      control={
        <select
          className={SELECT_CLS}
          value={mounted ? (theme ?? "system") : "dark"}
          onChange={(e) => setTheme(e.target.value)}
        >
          {options.map((o) => (
            <option key={o.value} value={o.value} className="bg-[#0B0E14] text-white">
              {o.label}
            </option>
          ))}
        </select>
      }
    />
  );
}

// Display language = the i18n locale. Applied INSTANTLY (i18n state +
// localStorage + <html lang>) AND persisted to the user's account
// (user_profile.locale via /api/users/me/profile) so the choice follows them
// across devices/browsers. Option labels are endonyms (shown in their own
// language), so they're intentionally NOT translated.
function LanguageRow({ label, help }: { label: string; help?: string }) {
  const { locale, setLocale } = useI18n();
  const change = (v: string) => {
    const lc: "id" | "en" = v === "en" ? "en" : "id";
    setLocale(lc);
    void fetch("/api/users/me/profile", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ locale: lc }),
    }).catch(() => {
      /* UI already switched; account-sync best-effort */
    });
  };
  return (
    <Row
      label={label}
      help={help}
      control={
        <select
          className={SELECT_CLS}
          value={locale}
          onChange={(e) => change(e.target.value)}
        >
          <option value="id" className="bg-[#0B0E14] text-white">
            Bahasa Indonesia
          </option>
          <option value="en" className="bg-[#0B0E14] text-white">
            English
          </option>
        </select>
      }
    />
  );
}
