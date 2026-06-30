"use client";

/**
 * AgentOtakPanel — "Otak Agen" tab. The single, clear home for EVERYTHING about
 * an agent's model/intelligence (moved out of Profil so the category is obvious):
 *   1. Model utama   — main model picker (per-agent → profile config model.default)
 *   2. Model cadangan — fallback chain (→ engine fallback_providers, per-agent)
 *   3. Tugas sampingan — auxiliary models per task (→ auxiliary.<task>, per-agent)
 *   4. Lanjutan       — context window override (→ model_context_length)
 *
 * All writes go through updateAgentRich → agents.update → the agent's PROFILE
 * config.yaml (named agent) or root config (default). Verified live: every field
 * lands in the REAL engine field (scripts/_probe-agent-modelcfg.mjs).
 */
import {
  Check,
  ChevronDown,
  ChevronUp,
  Cpu,
  Layers,
  Loader2,
  Save,
  Sparkles,
  Sliders,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  type AgentRow,
  type ModelChoice,
  type ModelAuthProvider,
  findModelById,
  formatModelLabel,
  providerStatusTone,
} from "./helpers";
import { updateAgentRich } from "./use-agents-data";

type ToastSetter = (
  t: { kind: "success" | "error" | "info"; text: string } | null,
) => void;

// The 11 engine side-tasks (auxiliary.<key>), friendly English labels.
const AUX_TASKS: { key: string; label: string; desc: string }[] = [
  { key: "vision", label: "Image Analysis", desc: "Read & describe images" },
  { key: "web_extract", label: "Web Summary", desc: "Extract webpage content" },
  { key: "compression", label: "Memory Saver", desc: "Compress long conversations" },
  { key: "skills_hub", label: "Skill Search", desc: "Search for skills" },
  { key: "approval", label: "Auto-approve", desc: "Smart approval handling" },
  { key: "mcp", label: "MCP Routing", desc: "Select MCP tool" },
  { key: "title_generation", label: "Session Title", desc: "Generate chat title" },
  { key: "triage_specifier", label: "Task Triage", desc: "Sort incoming tasks" },
  { key: "kanban_decomposer", label: "Task Breakdown", desc: "Decompose into kanban" },
  { key: "profile_describer", label: "Agent Description", desc: "Auto-describe agent" },
  { key: "curator", label: "Skill Review", desc: "Audit skill usage" },
];

/** Resolve the per-task selected model id ("" = use main) from the agent row. */
function auxModelFor(
  auxiliary: Record<string, { provider?: string; model?: string }> | undefined,
  key: string,
  mainModel: string,
): string {
  const v = auxiliary?.[key];
  if (!v) return "";
  const prov = (v.provider || "").trim();
  const mdl = (v.model || "").trim();
  // "auto" provider, empty model, or model == main → treated as "use main".
  if (!mdl || prov === "auto" || mdl === mainModel) return "";
  return mdl;
}

export function AgentOtakPanel({
  agent,
  modelsList,
  authProviders,
  loadingCatalog,
  onAfterChange,
  setToast,
}: {
  agent: AgentRow;
  modelsList: ModelChoice[];
  authProviders: ModelAuthProvider[];
  loadingCatalog: boolean;
  onAfterChange: () => void;
  setToast: ToastSetter;
}) {
  const initialModel = agent.model?.primary || "";
  const initialFallbacks = agent.model?.fallbacks ?? [];
  const initialAux = useMemo(() => {
    const out: Record<string, string> = {};
    for (const t of AUX_TASKS) {
      out[t.key] = auxModelFor(agent.model?.auxiliary, t.key, initialModel);
    }
    return out;
  }, [agent.model?.auxiliary, initialModel]);
  const initialCtx = agent.model?.contextLength ?? 0;

  const [model, setModel] = useState(initialModel);
  const [fallbacks, setFallbacks] = useState<string[]>(initialFallbacks);
  const [aux, setAux] = useState<Record<string, string>>(initialAux);
  const [ctxLen, setCtxLen] = useState<number>(initialCtx);
  const [saving, setSaving] = useState(false);
  const [openPicker, setOpenPicker] = useState<string | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);

  // Re-seed only on a real agent switch (mirrors profil-panel guard).
  const syncedRef = useRef(agent.id);
  useEffect(() => {
    if (syncedRef.current === agent.id) return;
    syncedRef.current = agent.id;
    setModel(agent.model?.primary || "");
    setFallbacks(agent.model?.fallbacks ?? []);
    const a: Record<string, string> = {};
    for (const t of AUX_TASKS) {
      a[t.key] = auxModelFor(agent.model?.auxiliary, t.key, agent.model?.primary || "");
    }
    setAux(a);
    setCtxLen(agent.model?.contextLength ?? 0);
  }, [agent]);

  const modelChanged = model !== initialModel;
  const fallbacksChanged =
    JSON.stringify(fallbacks) !== JSON.stringify(initialFallbacks);
  const auxChanged = JSON.stringify(aux) !== JSON.stringify(initialAux);
  const ctxChanged = ctxLen !== initialCtx;
  const dirty = modelChanged || fallbacksChanged || auxChanged || ctxChanged;

  const handleSave = async () => {
    if (!dirty) return;
    setSaving(true);
    const changes: Parameters<typeof updateAgentRich>[2] = {};
    if (modelChanged || fallbacksChanged) {
      changes.model = {
        primary: model.trim() || undefined,
        providerSlug: findModelById(modelsList, model.trim())?.provider || undefined,
        fallbacks,
      };
    }
    if (auxChanged) {
      const auxiliary: Record<string, { provider?: string; model?: string }> = {};
      for (const t of AUX_TASKS) {
        const sel = (aux[t.key] || "").trim();
        auxiliary[t.key] =
          sel && sel !== model.trim()
            ? { model: sel }
            : { provider: "auto", model: "" };
      }
      changes.auxiliary = auxiliary;
    }
    if (ctxChanged) changes.modelContextLength = Math.max(0, ctxLen);

    const res = await updateAgentRich(agent.id, agent, changes);
    setSaving(false);
    if (res.ok) {
      setToast({ kind: "success", text: "Agent brain saved" });
      onAfterChange();
    } else {
      setToast({ kind: "error", text: `Save failed: ${res.error}` });
    }
  };

  const currentModelMeta = findModelById(modelsList, model);
  const overrideCount = AUX_TASKS.filter((t) => (aux[t.key] || "").trim()).length;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {/* ── Model utama ── */}
      <Section
        icon={<Sparkles className="size-3.5 text-cyan-300" />}
        title="Primary Model"
        subtitle="The brain of this agent — the AI model that responds to every chat. Use the default if unsure."
      >
        <Field
          label="Primary model"
          hint={
            currentModelMeta
              ? `Provider: ${currentModelMeta.provider}${currentModelMeta.contextWindow ? " · Context " + currentModelMeta.contextWindow.toLocaleString("en-US") + " tokens" : ""}`
              : model
                ? "Model not found in catalog — provider will be resolved by the engine."
                : "Not set — using default config."
          }
        >
          <ModelPicker
            value={model}
            options={modelsList}
            authProviders={authProviders}
            loading={loadingCatalog}
            open={openPicker === "main"}
            setOpen={(v) => setOpenPicker(v ? "main" : null)}
            onChange={setModel}
          />
        </Field>

        <Field
          label="Fallback models"
          hint="If the primary model is down or errors out, the agent automatically tries these in order."
        >
          <FallbackChips
            values={fallbacks}
            options={modelsList}
            authProviders={authProviders}
            loading={loadingCatalog}
            open={openPicker === "fallback"}
            setOpen={(v) => setOpenPicker(v ? "fallback" : null)}
            onChange={setFallbacks}
          />
        </Field>
      </Section>

      {/* ── Tugas sampingan (auxiliary) ── */}
      <Section
        icon={<Layers className="size-3.5 text-fuchsia-300" />}
        title="Side Tasks"
        subtitle="Background tasks (image analysis, summarization, title generation, etc.) can each use their own model to save cost or run faster. By default they follow THIS AGENT's Primary Model (set above) — not another agent."
      >
        {overrideCount > 0 ? (
          <div className="mb-1 inline-flex items-center gap-1.5 rounded-full border border-fuchsia-400/30 bg-fuchsia-400/[0.08] px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-fuchsia-200">
            {overrideCount} tasks using a custom model
          </div>
        ) : null}
        <div className="divide-y divide-white/[0.05]">
          {AUX_TASKS.map((t) => (
            <AuxRow
              key={t.key}
              label={t.label}
              desc={t.desc}
              value={aux[t.key] || ""}
              options={modelsList}
              loading={loadingCatalog}
              open={openPicker === `aux:${t.key}`}
              setOpen={(v) => setOpenPicker(v ? `aux:${t.key}` : null)}
              onChange={(v) => setAux((m) => ({ ...m, [t.key]: v }))}
            />
          ))}
        </div>
      </Section>

      {/* ── Lanjutan (advanced) ── */}
      <section className="rounded-2xl border border-white/[0.08] bg-white/[0.02]">
        <button
          type="button"
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex w-full items-center gap-2 px-5 py-3.5 text-left"
        >
          <Sliders className="size-3.5 text-white/55" aria-hidden />
          <span className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-white/85">
            Advanced
          </span>
          <ChevronDown
            className={cn(
              "ml-auto size-4 text-white/45 transition-transform",
              advancedOpen && "rotate-180",
            )}
            aria-hidden
          />
        </button>
        {advancedOpen ? (
          <div className="space-y-3 px-5 pb-5">
            <Field
              label="Memory size (context window)"
              hint="Number of tokens the agent can remember in a single conversation. 0 = auto from model (recommended). Set manually only if you know what you're doing."
            >
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  value={Number.isFinite(ctxLen) ? ctxLen : 0}
                  min={0}
                  max={2000000}
                  onChange={(e) => {
                    let n = parseInt(e.target.value, 10);
                    if (!Number.isFinite(n) || n < 0) n = 0;
                    if (n > 2000000) n = 2000000;
                    setCtxLen(n);
                  }}
                  className="w-32 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-right text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
                />
                <span className="text-[11px] text-white/45">
                  {ctxLen > 0 ? "tokens" : "(auto)"}
                </span>
              </div>
            </Field>
          </div>
        ) : null}
      </section>

      {/* ── Save bar ── */}
      <div className="sticky bottom-4 z-10 mt-6">
        <div
          className={cn(
            "flex items-center justify-between gap-3 rounded-xl border px-4 py-2.5 shadow-[0_16px_40px_-16px_rgba(0,0,0,0.8)] backdrop-blur-xl transition-colors",
            dirty
              ? "border-cyan-400/30 bg-[#0B0E14]/90"
              : "border-white/[0.08] bg-[#0B0E14]/80",
          )}
        >
          <span className="flex min-w-0 items-center gap-2 text-[11px]">
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                dirty
                  ? "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]"
                  : "bg-emerald-400/70",
              )}
            />
            <span className="truncate text-white/55">
              {dirty ? "You have unsaved changes" : "All changes saved"}
            </span>
          </span>
          <button
            type="button"
            onClick={handleSave}
            disabled={!dirty || saving}
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-5 py-2 text-[12px] font-bold transition",
              dirty && !saving
                ? "bg-gradient-to-r from-emerald-400 via-cyan-500 to-indigo-500 text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(16,185,129,0.5)] hover:brightness-110"
                : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-white/40",
            )}
          >
            {saving ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Save className="size-3.5" aria-hidden />
            )}
            Save agent brain
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── sub-components ─────────────────────────────────────────────── */

function Section({
  icon,
  title,
  subtitle,
  children,
}: {
  icon?: React.ReactNode;
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
      <header className="mb-4">
        <h3 className="flex items-center gap-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-white/85">
          {icon}
          {title}
        </h3>
        {subtitle ? (
          <p className="mt-1 text-[11.5px] leading-snug text-white/55">{subtitle}</p>
        ) : null}
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 flex items-baseline gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
        {label}
      </label>
      {children}
      {hint ? (
        <p className="mt-1 text-[10.5px] leading-snug text-white/45">{hint}</p>
      ) : null}
    </div>
  );
}

/** Compact per-task auxiliary row: label + desc + a "use main / pick model" picker. */
function AuxRow({
  label,
  desc,
  value,
  options,
  loading,
  open,
  setOpen,
  onChange,
}: {
  label: string;
  desc: string;
  value: string;
  options: ModelChoice[];
  loading: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  onChange: (v: string) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-1.5">
          <Cpu className="size-3 shrink-0 text-white/35" aria-hidden />
          <span className="text-[12.5px] font-medium text-white/85">{label}</span>
        </div>
        <p className="mt-0.5 pl-[18px] text-[10.5px] leading-snug text-white/40">
          {desc}
        </p>
      </div>
      <div className="w-44 shrink-0">
        <ModelPicker
          value={value}
          options={options}
          authProviders={[]}
          loading={loading}
          open={open}
          setOpen={setOpen}
          onChange={onChange}
          emptyLabel="Follow primary"
          compact
        />
      </div>
    </div>
  );
}

// model.options provider slugs differ from models.authStatus slugs for these,
// so the status-badge lookup must normalize or it silently misses (no badge).
const AUTH_SLUG_BY_MODEL_PROVIDER: Record<string, string> = {
  gemini: "google",
  "openai-api": "openai",
};

function ModelPicker({
  value,
  options,
  authProviders,
  loading,
  open,
  setOpen,
  onChange,
  emptyLabel = "Default (config)",
  compact = false,
  hideEmpty = false,
}: {
  value: string;
  options: ModelChoice[];
  authProviders: ModelAuthProvider[];
  loading: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  onChange: (next: string) => void;
  emptyLabel?: string;
  compact?: boolean;
  hideEmpty?: boolean;
}) {
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) setSearch("");
  }, [open]);

  const grouped = useMemo(() => {
    const q = search.trim().toLowerCase();
    const filtered = options.filter((o) => {
      if (!q) return true;
      return `${o.id} ${o.name} ${o.provider} ${o.alias ?? ""}`
        .toLowerCase()
        .includes(q);
    });
    const map = new Map<string, ModelChoice[]>();
    for (const m of filtered) {
      if (!map.has(m.provider)) map.set(m.provider, []);
      map.get(m.provider)!.push(m);
    }
    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [options, search]);

  const current = findModelById(options, value);
  const displayLabel = current
    ? compact
      ? current.alias || current.name
      : formatModelLabel(current)
    : value
      ? `Custom: ${value}`
      : emptyLabel;

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${displayLabel}`}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border bg-white/[0.03] text-left transition",
          compact ? "px-2.5 py-1.5" : "px-3 py-2",
          open ? "border-cyan-400/50 ring-2 ring-cyan-400/20" : "border-white/10 hover:border-white/25",
        )}
      >
        <span className="flex min-w-0 items-center gap-1.5">
          {!compact ? (
            <Sparkles className="size-3.5 shrink-0 text-cyan-300/85" aria-hidden />
          ) : null}
          <span
            className={cn(
              "truncate font-semibold",
              compact ? "text-[11.5px]" : "text-[13px]",
              value ? "text-white/90" : "text-white/55",
            )}
          >
            {displayLabel}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-3.5 shrink-0 text-white/55 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-30 mt-1 max-h-80 w-72 overflow-hidden rounded-lg border border-white/10 bg-[#0B0E14] shadow-[0_20px_48px_-12px_rgba(0,0,0,0.7)]">
          <div className="border-b border-white/[0.06] p-2">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search models…"
              className="w-full rounded-md border border-white/10 bg-black/30 px-2.5 py-1 text-[12px] text-white focus:border-cyan-400/50 focus:outline-none"
            />
          </div>
          <div role="listbox" aria-label="Select model" className="max-h-56 overflow-y-auto p-1">
            {!hideEmpty ? (
              <button
                type="button"
                role="option"
                aria-selected={!value}
                onClick={() => {
                  onChange("");
                  setOpen(false);
                }}
                className={cn(
                  "flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left transition",
                  !value ? "bg-cyan-400/15 text-cyan-100" : "text-white/85 hover:bg-white/[0.04]",
                )}
              >
                <span className="text-[13px] font-semibold">{emptyLabel}</span>
                {!value ? <Check className="size-4 text-cyan-300" aria-hidden /> : null}
              </button>
            ) : null}
            {loading ? (
              <div className="px-3 py-3 text-center font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
                Loading model catalog…
              </div>
            ) : grouped.length === 0 ? (
              <div className="px-3 py-3 text-center text-[12px] text-white/55">
                No models found
              </div>
            ) : (
              grouped.map(([provider, models]) => {
                const authSlug =
                  AUTH_SLUG_BY_MODEL_PROVIDER[provider] ?? provider;
                const auth = authProviders.find((p) => p.provider === authSlug);
                // Only the `nous` model group is PROVABLY NOUS-supplied. A
                // direct provider group (anthropic/openai/gemini) showing
                // "static" is ambiguous — NOUS writes the same env var
                // (ANTHROPIC_API_KEY, ...) that a BYOK user would, so from the
                // status alone we can't tell a NOUS-provisioned key from a key
                // the user pasted or an oauth they did directly. So we never
                // assume "via NOUS" for them; they keep their real authStatus
                // badge ("Static key" / "Aktif" / "Login").
                const viaNous = provider === "nous";
                return (
                  <div key={provider} className="my-1">
                    <div className="flex items-center gap-2 px-3 py-1">
                      <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
                        {provider}
                      </span>
                      {viaNous ? (
                        <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-emerald-300/80">
                          <span className="size-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.7)]" />
                          via NOUS
                        </span>
                      ) : auth ? (
                        <ProviderStatusDot status={auth} />
                      ) : null}
                    </div>
                    {models.map((m) => {
                      const active = m.id === value;
                      return (
                        <button
                          key={m.id}
                          type="button"
                          role="option"
                          aria-selected={active}
                          onClick={() => {
                            onChange(m.id);
                            setOpen(false);
                          }}
                          className={cn(
                            "flex w-full items-start justify-between gap-3 rounded-md px-3 py-2 text-left transition",
                            active ? "bg-cyan-400/15 text-cyan-100" : "text-white/85 hover:bg-white/[0.04]",
                          )}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-[13px] font-semibold">
                              {m.alias || m.name}
                            </div>
                            <div className="truncate font-mono text-[10px] text-white/45">
                              {m.id}
                              {m.contextWindow
                                ? ` · ${m.contextWindow.toLocaleString("en-US")} ctx`
                                : ""}
                            </div>
                          </div>
                          {active ? (
                            <Check className="size-4 shrink-0 text-cyan-300" aria-hidden />
                          ) : null}
                        </button>
                      );
                    })}
                  </div>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ProviderStatusDot({ status }: { status: ModelAuthProvider }) {
  const { tone, label } = providerStatusTone(status.status);
  const dotCls =
    tone === "emerald"
      ? "bg-emerald-400 shadow-[0_0_8px_rgba(16,185,129,0.7)]"
      : tone === "amber"
        ? "bg-amber-400 shadow-[0_0_8px_rgba(251,191,36,0.7)]"
        : tone === "red"
          ? "bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.7)]"
          : "bg-indigo-400 shadow-[0_0_8px_rgba(129,140,248,0.7)]";
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/55">
      <span className={cn("inline-block size-1.5 rounded-full", dotCls)} />
      {label}
    </span>
  );
}

function FallbackChips({
  values,
  options,
  authProviders,
  loading,
  open,
  setOpen,
  onChange,
}: {
  values: string[];
  options: ModelChoice[];
  authProviders: ModelAuthProvider[];
  loading: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  onChange: (next: string[]) => void;
}) {
  const removeAt = (idx: number) => onChange(values.filter((_, i) => i !== idx));
  const move = (idx: number, dir: -1 | 1) => {
    const j = idx + dir;
    if (j < 0 || j >= values.length) return;
    const next = [...values];
    [next[idx], next[j]] = [next[j], next[idx]];
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {values.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          {values.map((v, i) => {
            const meta = findModelById(options, v);
            return (
              <div
                key={`${v}-${i}`}
                className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-1.5"
              >
                <span className="grid size-5 shrink-0 place-items-center rounded-md bg-white/[0.06] font-mono text-[10px] font-bold text-white/55">
                  {i + 1}
                </span>
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-white/85">
                  {meta ? meta.alias || meta.name : v}
                </span>
                {values.length > 1 ? (
                  <span className="flex shrink-0 items-center">
                    <button
                      type="button"
                      onClick={() => move(i, -1)}
                      disabled={i === 0}
                      aria-label="Move up"
                      className="rounded p-0.5 text-white/35 transition hover:text-cyan-200 disabled:opacity-25"
                    >
                      <ChevronUp className="size-3.5" aria-hidden />
                    </button>
                    <button
                      type="button"
                      onClick={() => move(i, 1)}
                      disabled={i === values.length - 1}
                      aria-label="Move down"
                      className="rounded p-0.5 text-white/35 transition hover:text-cyan-200 disabled:opacity-25"
                    >
                      <ChevronDown className="size-3.5" aria-hidden />
                    </button>
                  </span>
                ) : null}
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  className="shrink-0 rounded p-1 text-white/40 transition hover:text-red-300"
                  aria-label={`Remove ${v}`}
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-[11.5px] text-white/40">No fallback models yet.</p>
      )}
      <ModelPicker
        value=""
        options={options}
        authProviders={authProviders}
        loading={loading}
        open={open}
        setOpen={setOpen}
        onChange={(id) => {
          if (id && !values.includes(id)) onChange([...values, id]);
        }}
        emptyLabel="+ Add fallback model"
        hideEmpty
      />
    </div>
  );
}
