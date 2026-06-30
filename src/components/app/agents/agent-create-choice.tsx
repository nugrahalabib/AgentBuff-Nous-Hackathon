"use client";

/**
 * AgentCreateChoice — single entry-point modal for "+ Baru" with 4
 * upfront choices. Replaces the previous mix of (1) hidden "Mode
 * advanced" link inside the wizard, and (2) separate Import button on
 * the sidebar — both confused users.
 *
 * Flow:
 *   Step "choose"     → 4 cards (Wizard / Form lengkap / Duplikat / Import)
 *   Step "clone-pick" → picker grid of existing agents (only when user
 *                       chose Duplikat — sub-step inside this modal)
 *
 * The other 3 paths are pure delegation: caller closes this modal +
 * opens its dedicated modal (Wizard / Form lengkap / Import) via the
 * onPick* callbacks. Clone is handled inline because it needs a 1-click
 * select-source step before the actual `agents.clone` RPC fires.
 *
 * After clone success, the cloned agent's profile auto-loads via
 * onCreated → user lands on Profil tab and customizes the duplicate
 * inline (no separate "edit clone" form needed).
 */

import {
  ArrowRight,
  CheckCircle2,
  Copy,
  Loader2,
  Sparkles,
  Wand2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  type AgentRow,
  getAgentDisplayName,
  randomEmoji,
  suggestAgentIdFromName,
} from "./helpers";
import { cloneAgent } from "./use-agents-data";

type ToastSetter = (
  t: { kind: "success" | "error" | "info"; text: string } | null,
) => void;

type Step = "choose" | "clone-pick";

type ChoiceId = "wizard" | "clone" | "import";

const CHOICES: Array<{
  id: ChoiceId;
  icon: typeof Wand2;
  iconBg: string;
  iconText: string;
  label: string;
  description: string;
  badge?: string;
  whoFor: string;
}> = [
  {
    id: "wizard",
    icon: Wand2,
    iconBg: "from-cyan-400 to-indigo-500",
    iconText: "text-[#0B0E14]",
    label: "Design your own",
    description: "3 quick steps: pick a role, give it a name, connect a channel.",
    badge: "Recommended",
    whoFor: "Best if this is your first time building an agent.",
  },
  {
    id: "clone",
    icon: Copy,
    iconBg: "from-emerald-400 to-cyan-500",
    iconText: "text-[#0B0E14]",
    label: "Duplicate an existing agent",
    description: "Copy one of your agents, then tweak it a bit in the Profile & Persona tab.",
    whoFor: "Great when you just want a small variant of an agent that's already running.",
  },
  // "Import dari file" sengaja dihilangkan (Chief 2026-06-01): export/import
  // ikut bawa skill + plugin (termasuk item marketplace berbayar), jadi mindahin
  // agen antar-akun gratisan jadi gampang. Handler + AgentImportDialog masih ada
  // (tinggal kembalikan entry ini kalau mau diaktifkan lagi).
];

export function AgentCreateChoice({
  open,
  existingAgents,
  onClose,
  onPickWizard,
  onPickImport,
  onCloned,
  setToast,
}: {
  open: boolean;
  existingAgents: AgentRow[];
  onClose: () => void;
  /** Caller closes this + opens wizard modal. */
  onPickWizard: () => void;
  /** Caller closes this + opens import dialog. */
  onPickImport: () => void;
  /** Called after successful clone with the new agent id. Caller usually
   *  selects the agent + closes this modal. */
  onCloned: (newAgentId: string) => void;
  setToast: ToastSetter;
}) {
  const [step, setStep] = useState<Step>("choose");
  const [cloneSourceId, setCloneSourceId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Reset on close
  useEffect(() => {
    if (!open) {
      setStep("choose");
      setCloneSourceId(null);
      setSubmitting(false);
    }
  }, [open]);

  // Esc closes the dialog (mirrors AgentModalShell; the X + backdrop already
  // close). Guarded by !submitting so a clone-in-progress isn't dismissed.
  // (Audit A11Y-4.)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !submitting) onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, submitting, onClose]);

  const existingIds = useMemo(
    () => new Set(existingAgents.map((a) => a.id)),
    [existingAgents],
  );

  if (!open) return null;

  const handlePick = (id: ChoiceId) => {
    if (id === "wizard") {
      onPickWizard();
      return;
    }
    if (id === "import") {
      onPickImport();
      return;
    }
    // clone — sub-step
    setStep("clone-pick");
  };

  const handleClone = async () => {
    if (!cloneSourceId) return;
    const source = existingAgents.find((a) => a.id === cloneSourceId);
    if (!source) return;
    // Generate a unique new id based on source name
    const baseName = getAgentDisplayName(source);
    let candidate = `${suggestAgentIdFromName(baseName)}-copy`;
    let n = 1;
    while (existingIds.has(candidate)) {
      n += 1;
      candidate = `${suggestAgentIdFromName(baseName)}-copy-${n}`;
    }
    setSubmitting(true);
    const res = await cloneAgent({
      sourceId: cloneSourceId,
      newId: candidate,
      name: `${baseName} (Copy)`,
      emoji: source.identity?.emoji || randomEmoji(),
    });
    setSubmitting(false);
    if (res.ok) {
      setToast({
        kind: "success",
        text: `✨ Agent duplicated — you can now customize it in Profile & Persona.`,
      });
      onCloned(res.data.id);
    } else {
      setToast({ kind: "error", text: `Duplicate failed: ${res.error}` });
    }
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/80 p-4 backdrop-blur-md"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-choice-title"
      onClick={onClose}
    >
      <div
        className="flex w-full max-w-2xl flex-col rounded-3xl border border-white/15 bg-[#0B0E14] shadow-[0_32px_96px_-16px_rgba(0,0,0,0.9)]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <header className="flex shrink-0 items-center gap-4 border-b border-white/[0.08] px-6 py-4">
          <div className="flex-1">
            <div className="font-mono text-[10px] font-bold uppercase tracking-[0.24em] text-cyan-300/85">
              ✦ Create New Agent
            </div>
            <h2 id="create-choice-title" className="mt-0.5 font-display text-lg font-bold text-white">
              {step === "choose"
                ? "How would you like to create your agent?"
                : "Choose an agent to duplicate"}
            </h2>
            <p className="mt-0.5 text-[11.5px] text-white/55">
              {step === "choose"
                ? "Pick whatever fits best. You can always come back and choose a different path."
                : "The new agent inherits all capabilities and persona, but gets a fresh ID and name."}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1.5 text-white/55 hover:bg-white/[0.05] hover:text-white"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden />
          </button>
        </header>

        {/* Body */}
        {step === "choose" ? (
          <div className="scrollbar-slim grid min-h-[280px] flex-1 grid-cols-1 gap-2.5 overflow-y-auto p-5 sm:grid-cols-2">
            {CHOICES.map((c) => {
              const Icon = c.icon;
              const disabled =
                (c.id === "clone" && existingAgents.length === 0) || submitting;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => handlePick(c.id)}
                  disabled={disabled}
                  className={cn(
                    "group flex h-full flex-col gap-2 rounded-xl border p-4 text-left transition",
                    disabled
                      ? "cursor-not-allowed border-white/[0.04] bg-white/[0.01] opacity-40"
                      : "border-white/10 bg-white/[0.03] hover:border-cyan-400/40 hover:bg-white/[0.06] hover:shadow-[0_12px_30px_-12px_rgba(99,102,241,0.45)]",
                  )}
                >
                  <div className="flex items-center gap-2">
                    <div
                      className={cn(
                        "flex size-9 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br shadow",
                        c.iconBg,
                        c.iconText,
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-baseline gap-1.5">
                        <span className="text-[13px] font-semibold text-white/95">
                          {c.label}
                        </span>
                        {c.badge ? (
                          <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-1.5 py-0 font-mono text-[9px] uppercase tracking-[0.16em] text-cyan-200">
                            {c.badge}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    <ArrowRight
                      className="size-4 shrink-0 text-white/30 transition group-hover:translate-x-0.5 group-hover:text-cyan-300"
                      aria-hidden
                    />
                  </div>
                  <p className="text-[11.5px] leading-relaxed text-white/65">
                    {c.description}
                  </p>
                  <p className="mt-auto font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
                    {c.id === "clone" && existingAgents.length === 0
                      ? "No agents to copy yet"
                      : c.whoFor}
                  </p>
                </button>
              );
            })}
          </div>
        ) : (
          <ClonePickStep
            agents={existingAgents}
            selected={cloneSourceId}
            onSelect={setCloneSourceId}
            onBack={() => setStep("choose")}
            onConfirm={() => void handleClone()}
            submitting={submitting}
          />
        )}
      </div>
    </div>
  );
}

/* ── Clone source picker step ───────────────────────────────────── */

function ClonePickStep({
  agents,
  selected,
  onSelect,
  onBack,
  onConfirm,
  submitting,
}: {
  agents: AgentRow[];
  selected: string | null;
  onSelect: (id: string) => void;
  onBack: () => void;
  onConfirm: () => void;
  submitting: boolean;
}) {
  return (
    <>
      <div className="scrollbar-slim min-h-[280px] flex-1 overflow-y-auto p-5">
        {agents.length === 0 ? (
          <div className="flex h-full items-center justify-center rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] py-12 text-center">
            <div>
              <div className="mb-2 text-3xl" aria-hidden>
                📦
              </div>
              <div className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-white/65">
                No agents to copy yet
              </div>
              <p className="mt-1 text-[11.5px] text-white/55">
                Create your first agent using the Wizard first.
              </p>
            </div>
          </div>
        ) : (
          <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {agents.map((a) => {
              const active = selected === a.id;
              const name = getAgentDisplayName(a);
              return (
                <li key={a.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(a.id)}
                    disabled={submitting}
                    className={cn(
                      "flex w-full items-start gap-2.5 rounded-xl border p-3 text-left transition",
                      active
                        ? "border-emerald-400/40 bg-emerald-400/[0.06] shadow-[0_0_0_1px_rgba(16,185,129,0.25)]"
                        : "border-white/10 bg-white/[0.03] hover:border-cyan-400/40 hover:bg-white/[0.06]",
                      submitting ? "opacity-50" : "",
                    )}
                  >
                    <div className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-xl">
                      {a.identity?.emoji ?? "🤖"}
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="truncate text-[13px] font-semibold text-white/90">
                          {name}
                        </span>
                        {active ? (
                          <CheckCircle2 className="size-3.5 shrink-0 text-emerald-300" aria-hidden />
                        ) : null}
                      </div>
                      <div className="mt-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
                        {a.id}
                      </div>
                      {a.description ? (
                        <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-white/55">
                          {a.description}
                        </p>
                      ) : null}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {/* Footer */}
      <footer className="flex shrink-0 items-center justify-between gap-2 border-t border-white/[0.08] px-6 py-4">
        <button
          type="button"
          onClick={onBack}
          disabled={submitting}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[12px] font-semibold text-white/70 hover:text-white disabled:opacity-50"
        >
          ← Choose differently
        </button>
        <button
          type="button"
          onClick={onConfirm}
          disabled={!selected || submitting}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-[12px] font-bold transition",
            selected && !submitting
              ? "bg-gradient-to-r from-emerald-400 via-cyan-500 to-indigo-500 text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(16,185,129,0.5)] hover:brightness-110"
              : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-white/40",
          )}
        >
          {submitting ? (
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
          ) : (
            <Sparkles className="size-3.5" aria-hidden />
          )}
          Duplicate now
        </button>
      </footer>
    </>
  );
}
