"use client";

/**
 * SkillCategoryBrowser — Persona-style category sidebar + per-skill toggles.
 *
 * Shared by:
 *   - AgentKemampuanPanel → SkillsSection (existing agent; persists via
 *     agents.skills.set allowlist RPC)
 *   - AgentCapabilityWizard → Step4 skills (new agent; local Set state)
 *
 * Layout mirrors AgentPersonaPanel: a left category rail
 * (grid lg:grid-cols-[240px_1fr]) + a right pane of toggle cards. Each
 * category shows an "X/Y aktif" counter. A global search filters across every
 * category. Optional per-category bulk on/off.
 *
 * PURE presentation: the parent owns the enabled-set + persistence. We never
 * call an RPC here — only `onToggle` / `onBulkToggle`.
 */
import { CircleAlert, Layers, Loader2, Lock, Search } from "lucide-react";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  type SkillSetup,
  skillCategoryMeta,
  skillDescription,
  skillMeta,
  translateSkill,
} from "./vocab";
import { isEssentialSkill } from "./capability-tiers";

/**
 * Setup-readiness verdict for a skill, given which env keys are present.
 *
 * Chief's rule: lock a capability ONLY when its requirement is PROVABLY unmet.
 *   - none   → no external setup needed (usable, on)
 *   - ready  → setup needed + env key detected present (usable, on, SIAP badge)
 *   - locked → setup needed + env key EXISTS but ABSENT (provably unmet → OFF)
 *   - soft   → setup needed but UNDETECTABLE (envKey null: CLI/OAuth/account/
 *              mcp — no env var to check). We can't prove it's unmet, so per
 *              "kecuali yang SUDAH PASTI ke-lock" we DON'T hard-lock it: it's
 *              toggleable + default-on, but still shows the BUTUH SETUP badge +
 *              tutorial so the user knows to configure it.
 */
type SkillReadiness =
  | { kind: "none" }
  | { kind: "ready"; setup: SkillSetup }
  | { kind: "locked"; setup: SkillSetup }
  | { kind: "soft"; setup: SkillSetup };

function resolveSkillReadiness(
  name: string,
  envPresent: ReadonlySet<string>,
): SkillReadiness {
  const meta = skillMeta(name);
  if (!meta || !meta.needsSetup || !meta.setup) return { kind: "none" };
  const setup = meta.setup;
  if (setup.envKey) {
    return envPresent.has(setup.envKey)
      ? { kind: "ready", setup }
      : { kind: "locked", setup };
  }
  // No env var to detect → can't prove unmet → allowed (soft).
  return { kind: "soft", setup };
}

export type SkillBrowserRow = {
  name: string;
  description?: string;
  source?: string;
  emoji?: string;
  /** global-off (engine skills.disabled) — rendered non-toggleable */
  disabled?: boolean;
};

const ALL = "__all__";
const EMPTY_SET: ReadonlySet<string> = new Set();

export function SkillCategoryBrowser({
  skills,
  enabledSet,
  essentialNames,
  onToggle,
  onBulkToggle,
  busyName,
  loading,
  envPresentKeys,
}: {
  skills: SkillBrowserRow[];
  enabledSet: ReadonlySet<string>;
  /** Skills that are always-on + locked (cannot be toggled off). */
  essentialNames?: ReadonlySet<string>;
  onToggle: (name: string, next: boolean) => void;
  onBulkToggle?: (names: string[], next: boolean) => void;
  busyName?: string | null;
  loading?: boolean;
  /** Env var keys present in the workspace — drives the SIAP vs BUTUH SETUP badge. */
  envPresentKeys?: ReadonlySet<string>;
}) {
  const envPresent = envPresentKeys ?? EMPTY_SET;
  const [activeCat, setActiveCat] = useState<string>(ALL);
  const [inputValue, setInputValue] = useState("");
  const [query, setQuery] = useState("");

  // Debounce search: the filter query updates 150ms after the user stops
  // typing. inputValue drives the visible input (responsive); query drives the
  // heavier visibleRows memo + 78-item grid re-render. (Audit HIGH14-c.)
  useEffect(() => {
    if (inputValue === query) return;
    const id = setTimeout(() => setQuery(inputValue), 150);
    return () => clearTimeout(id);
  }, [inputValue, query]);

  // Rank for sorting: usable skills (ready / no-setup / soft-allowed) come
  // FIRST; only PROVABLY-locked ones sink to the BOTTOM — chief: "yang atas itu
  // yang memang sudah bisa dipakai". 0 = usable, 1 = locked.
  const setupRank = (name: string): number =>
    resolveSkillReadiness(name, envPresent).kind === "locked" ? 1 : 0;

  // Group skills by engine `source` → friendly category.
  const categories = useMemo(() => {
    const m = new Map<string, SkillBrowserRow[]>();
    for (const s of skills) {
      const key = (s.source || "general").trim().toLowerCase() || "general";
      const arr = m.get(key);
      if (arr) arr.push(s);
      else m.set(key, [s]);
    }
    const out = Array.from(m.entries()).map(([source, rows]) => {
      const meta = skillCategoryMeta(source);
      const enabledCount = rows.filter((r) => enabledSet.has(r.name)).length;
      return {
        source,
        label: meta.label,
        icon: meta.icon,
        rows,
        enabledCount,
        total: rows.length,
      };
    });
    out.sort((a, b) => b.total - a.total || a.label.localeCompare(b.label));
    return out;
  }, [skills, enabledSet]);

  const totalEnabled = useMemo(
    () => skills.filter((s) => enabledSet.has(s.name)).length,
    [skills, enabledSet],
  );

  const q = query.trim().toLowerCase();
  const searching = q.length > 0;

  const visibleRows = useMemo(() => {
    let rows: SkillBrowserRow[];
    if (searching) {
      rows = skills.filter((s) => {
        const v = translateSkill(s.name);
        return `${s.name} ${v.label} ${v.description} ${s.description ?? ""}`
          .toLowerCase()
          .includes(q);
      });
    } else if (activeCat === ALL) {
      rows = skills;
    } else {
      rows = categories.find((c) => c.source === activeCat)?.rows ?? [];
    }
    return [...rows].sort((a, b) => {
      const ra = setupRank(a.name);
      const rb = setupRank(b.name);
      if (ra !== rb) return ra - rb; // usable first, needs-setup last
      return translateSkill(a.name).label.localeCompare(
        translateSkill(b.name).label,
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skills, categories, activeCat, searching, q, envPresent]);

  const activeMeta =
    activeCat === ALL ? null : categories.find((c) => c.source === activeCat);
  // Bulk on/off only targets USABLE skills — locked (needs-setup) skills can't
  // be turned on until configured, so they're excluded from "Nyalain semua".
  const bulkNames = visibleRows
    .filter((r) => !r.disabled && setupRank(r.name) === 0)
    .map((r) => r.name);
  const bulkAllOn =
    bulkNames.length > 0 && bulkNames.every((n) => enabledSet.has(n));
  const firstLockedIdx = visibleRows.findIndex((r) => setupRank(r.name) === 1);

  if (loading && skills.length === 0) {
    return (
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
        <div className="space-y-1.5">
          {Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="h-10 animate-pulse rounded-lg bg-white/[0.03]" />
          ))}
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {Array.from({ length: 8 }, (_, i) => (
            <div key={i} className="h-16 animate-pulse rounded-xl bg-white/[0.03]" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[240px_1fr]">
      {/* ── Category rail ── */}
      <aside className="scrollbar-slim min-h-0 lg:max-h-[calc(100vh-280px)] lg:overflow-y-auto">
        <ul className="space-y-1">
          <li>
            <CategoryButton
              icon={<Layers className="size-3.5 text-white/70" aria-hidden />}
              label="All Skills"
              enabledCount={totalEnabled}
              total={skills.length}
              active={activeCat === ALL && !searching}
              onClick={() => {
                setActiveCat(ALL);
                setInputValue("");
                setQuery("");
              }}
            />
          </li>
          {categories.map((c) => (
            <li key={c.source}>
              <CategoryButton
                icon={<span className="text-sm">{c.icon}</span>}
                label={c.label}
                enabledCount={c.enabledCount}
                total={c.total}
                active={activeCat === c.source && !searching}
                onClick={() => {
                  setActiveCat(c.source);
                  setInputValue("");
                  setQuery("");
                }}
              />
            </li>
          ))}
        </ul>
      </aside>

      {/* ── Skills pane ── */}
      <main className="min-w-0 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-0 flex-1">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-white/40"
              aria-hidden
            />
            <input
              type="text"
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              placeholder="Search skills across all categories…"
              className="w-full rounded-lg border border-white/10 bg-white/[0.03] py-2 pl-8 pr-3 text-[13px] text-white placeholder:text-white/35 focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/10"
            />
          </div>
          {onBulkToggle && bulkNames.length > 0 ? (
            <button
              type="button"
              onClick={() => onBulkToggle(bulkNames, !bulkAllOn)}
              className={cn(
                "shrink-0 rounded-md border px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.14em] transition",
                bulkAllOn
                  ? "border-white/10 bg-white/[0.03] text-white/70 hover:text-white"
                  : "border-emerald-400/30 bg-emerald-400/[0.06] text-emerald-100 hover:bg-emerald-400/10",
              )}
            >
              {bulkAllOn ? "Disable all" : "Enable all"}
            </button>
          ) : null}
        </div>

        <div className="flex items-baseline justify-between gap-2">
          <h3 className="truncate font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-white/70">
            {searching
              ? `Results for "${query}"`
              : activeCat === ALL
                ? "All Skills"
                : `${activeMeta?.icon ?? ""} ${activeMeta?.label ?? ""}`}
          </h3>
          <span className="shrink-0 font-mono text-[10px] text-white/40">
            {visibleRows.length} skill
          </span>
        </div>

        {visibleRows.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] px-3 py-8 text-center text-[12px] text-white/55">
            {searching
              ? `No skills matched "${query}".`
              : "This category is empty."}
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {visibleRows.map((s, idx) => {
              const v = translateSkill(s.name);
              const essential =
                (essentialNames?.has(s.name) ?? false) || isEssentialSkill(s.name);
              const on = enabledSet.has(s.name) || essential;
              const readiness = resolveSkillReadiness(s.name, envPresent);
              const showDivider =
                firstLockedIdx > 0 && idx === firstLockedIdx;
              return (
                <Fragment key={s.name}>
                  {showDivider ? (
                    <li className="col-span-full mt-1 flex items-center gap-2 pt-1">
                      <span className="font-mono text-[9.5px] font-bold uppercase tracking-[0.18em] text-amber-200/80">
                        🔒 Setup required
                      </span>
                      <span className="h-px flex-1 bg-amber-400/15" />
                      <span className="font-mono text-[9.5px] text-white/35">
                        {visibleRows.length - firstLockedIdx}
                      </span>
                    </li>
                  ) : null}
                  <SkillToggleCard
                    icon={s.emoji || v.icon}
                    label={v.label}
                    description={skillDescription(s.name, s.description)}
                    categoryLabel={
                      searching
                        ? skillCategoryMeta(s.source || "general").label
                        : null
                    }
                    readiness={readiness}
                    enabled={on}
                    essential={essential}
                    globalOff={!!s.disabled}
                    busy={busyName === s.name}
                    onToggle={() => onToggle(s.name, !on)}
                  />
                </Fragment>
              );
            })}
          </ul>
        )}
      </main>
    </div>
  );
}

function CategoryButton({
  icon,
  label,
  enabledCount,
  total,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  enabledCount: number;
  total: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition",
        active
          ? "border-cyan-400/40 bg-cyan-400/[0.08]"
          : "border-white/[0.06] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]",
      )}
    >
      <span className="flex size-7 shrink-0 items-center justify-center rounded-md border border-white/10 bg-white/[0.04]">
        {icon}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-[12.5px] font-semibold",
          active ? "text-white" : "text-white/80",
        )}
      >
        {label}
      </span>
      <span
        className={cn(
          "shrink-0 font-mono text-[10px]",
          enabledCount > 0 ? "text-emerald-300/90" : "text-white/35",
        )}
      >
        {enabledCount}/{total}
      </span>
    </button>
  );
}

function SkillToggleCard({
  icon,
  label,
  description,
  categoryLabel,
  readiness,
  enabled,
  essential,
  globalOff,
  busy,
  onToggle,
}: {
  icon: string;
  label: string;
  description?: string;
  categoryLabel?: string | null;
  readiness: SkillReadiness;
  enabled: boolean;
  essential?: boolean;
  globalOff?: boolean;
  busy?: boolean;
  onToggle: () => void;
}) {
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const isLocked = readiness.kind === "locked"; // provably unmet → lock pill
  const setupReady = readiness.kind === "ready"; // SIAP badge
  // Show the BUTUH SETUP badge + tutorial for BOTH locked (provably unmet) and
  // soft (undetectable) — but only locked actually disables the toggle.
  const showSetupHint = readiness.kind === "locked" || readiness.kind === "soft";
  const setupObj = readiness.kind === "none" ? null : readiness.setup;

  return (
    <li
      className={cn(
        "rounded-xl border p-3 transition",
        essential
          ? "border-emerald-400/40 bg-emerald-400/[0.07]"
          : globalOff
            ? "border-white/[0.04] bg-white/[0.01] opacity-55"
            : enabled
              ? "border-emerald-400/30 bg-emerald-400/[0.05]"
              : isLocked
                ? "border-amber-400/25 bg-amber-400/[0.03]"
                : "border-white/[0.06] bg-white/[0.02]",
      )}
    >
      <div className="flex items-start gap-2.5">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-lg">
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="truncate text-[13px] font-semibold text-white/90">
              {label}
            </span>
            {enabled && !globalOff ? (
              <span className="shrink-0 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0 font-mono text-[9px] uppercase tracking-[0.14em] text-emerald-200">
                on
              </span>
            ) : null}
            {showSetupHint ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-amber-400/40 bg-amber-400/10 px-1.5 py-0 font-mono text-[9px] uppercase tracking-[0.14em] text-amber-200">
                <span className="size-1.5 rounded-full bg-amber-400" />
                needs setup
              </span>
            ) : null}
            {setupReady ? (
              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0 font-mono text-[9px] uppercase tracking-[0.14em] text-emerald-200">
                <span className="size-1.5 rounded-full bg-emerald-400" />
                ready
              </span>
            ) : null}
            {globalOff ? (
              <span className="shrink-0 rounded-full border border-white/10 bg-white/[0.03] px-1.5 py-0 font-mono text-[9px] uppercase tracking-[0.14em] text-white/45">
                globally off
              </span>
            ) : null}
            {categoryLabel ? (
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-white/35">
                {categoryLabel}
              </span>
            ) : null}
          </div>
          {description ? (
            <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-white/55">
              {description}
            </p>
          ) : null}
          {showSetupHint ? (
            <button
              type="button"
              onClick={() => setTutorialOpen((v) => !v)}
              className="mt-1.5 inline-flex items-center gap-1 rounded-md border border-amber-400/30 bg-amber-400/[0.06] px-2 py-0.5 font-mono text-[9px] font-bold uppercase tracking-[0.14em] text-amber-100 hover:border-amber-400/50 hover:bg-amber-400/10"
            >
              {tutorialOpen ? "▼ Close guide" : "▶ How to set up"}
            </button>
          ) : null}
        </div>
        {essential ? (
          // Platform-essential skill: always on, cannot be turned off.
          <span
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-emerald-400/40 bg-emerald-400/[0.10] px-2 text-emerald-100"
            title="Core AgentBuff skill — always active, cannot be disabled"
            aria-label="Always active"
          >
            <Lock className="size-3" aria-hidden />
            <span className="font-mono text-[9px] font-bold uppercase tracking-[0.14em]">
              required
            </span>
          </span>
        ) : isLocked ? (
          // PROVABLY unmet (env key absent): can't turn on until configured.
          // Lock pill instead of switch.
          <span
            className="inline-flex h-6 shrink-0 items-center gap-1 rounded-full border border-amber-400/30 bg-amber-400/[0.06] px-2 text-amber-200/90"
            title="Complete setup before this can be enabled"
            aria-label="Locked — setup required first"
          >
            <Lock className="size-3" aria-hidden />
          </span>
        ) : (
          <button
            type="button"
            onClick={onToggle}
            disabled={busy || globalOff}
            aria-label={enabled ? "Disable skill" : "Enable skill"}
            className={cn(
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition disabled:opacity-50",
              enabled && !globalOff
                ? "border-emerald-400/40 bg-emerald-400/15"
                : "border-white/15 bg-white/[0.03]",
            )}
          >
            {busy ? (
              <Loader2 className="absolute left-1/2 top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 animate-spin text-white/70" />
            ) : (
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full bg-white shadow transition",
                  enabled && !globalOff
                    ? "translate-x-[22px] bg-emerald-300"
                    : "translate-x-0.5",
                )}
              />
            )}
          </button>
        )}
      </div>

      {showSetupHint && tutorialOpen && setupObj ? (
        <SkillSetupTutorial setup={setupObj} skillLabel={label} />
      ) : null}
    </li>
  );
}

/**
 * Inline setup tutorial — mirrors the channel/tool RequirementsModal style:
 * ordered steps + docs link + "atau suruh agen aja" copy-prompt. Shown when
 * the user expands "Cara pakai" on a skill that still needs external setup.
 */
function SkillSetupTutorial({
  setup,
  skillLabel,
}: {
  setup: SkillSetup;
  skillLabel: string;
}) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    },
    [],
  );
  const chatPrompt =
    setup.chatPrompt ||
    `I want to use the "${skillLabel}" skill. Please guide me through the setup step-by-step and let me know everything I need to prepare.`;
  return (
    <div className="mt-2.5 space-y-2.5 rounded-lg border border-white/10 bg-[#0B0E14]/60 p-3">
      <div className="flex items-start gap-2">
        <CircleAlert className="mt-0.5 size-3.5 shrink-0 text-amber-300" aria-hidden />
        <p className="text-[11.5px] leading-relaxed text-white/75">
          {setup.label}. Once configured, this skill will be immediately available to your agent.
        </p>
      </div>

      <ol className="space-y-1.5 pl-4">
        {setup.steps.map((step, idx) => (
          <li key={idx} className="relative text-[11px] leading-relaxed text-white/70">
            <span className="absolute -left-4 flex size-3.5 items-center justify-center rounded-full bg-amber-400/25 font-mono text-[8px] font-bold text-amber-100">
              {idx + 1}
            </span>
            {step}
          </li>
        ))}
        {setup.envKey ? (
          <li className="relative text-[11px] leading-relaxed text-white/70">
            <span className="absolute -left-4 flex size-3.5 items-center justify-center rounded-full bg-amber-400/25 font-mono text-[8px] font-bold text-amber-100">
              {setup.steps.length + 1}
            </span>
            Save the key in{" "}
            <strong className="text-white/85">Settings → Env</strong> as{" "}
            <code className="rounded bg-white/[0.06] px-1 py-0.5 font-mono text-[10px] text-amber-100">
              {setup.envKey}
            </code>
            .
          </li>
        ) : null}
      </ol>

      {setup.docsUrl ? (
        <a
          href={setup.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/[0.04] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/70 hover:border-white/30 hover:text-white"
        >
          📖 Official docs ↗
        </a>
      ) : null}

      <div className="rounded-md border border-fuchsia-400/20 bg-fuchsia-400/[0.04] p-2.5">
        <div className="mb-1 flex items-center justify-between gap-2">
          <div className="font-mono text-[9.5px] font-bold uppercase tracking-[0.18em] text-fuchsia-200">
            💬 Or just ask your agent:
          </div>
          <button
            type="button"
            onClick={() => {
              void navigator.clipboard.writeText(chatPrompt);
              setCopied(true);
              if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
              copyTimerRef.current = setTimeout(() => setCopied(false), 1500);
            }}
            className="rounded px-1.5 py-0.5 font-mono text-[9.5px] uppercase tracking-[0.16em] text-fuchsia-200 hover:bg-fuchsia-400/15"
          >
            {copied ? "✓ Copied" : "Copy"}
          </button>
        </div>
        <p className="text-[11px] italic leading-relaxed text-white/80">
          &ldquo;{chatPrompt}&rdquo;
        </p>
        <p className="mt-1 text-[10px] text-white/40">
          Paste this in your agent chat — let your agent handle the setup for you.
        </p>
      </div>
    </div>
  );
}
