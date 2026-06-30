"use client";

/**
 * AgentProfilPanel — Tab 1 "Profil"
 *
 * Sections:
 *  1. Identity (avatar/emoji preview, name)
 *  2. Default flag — "Jadikan default" tombol kalau bukan default
 *  3. Workspace (read-only-ish — engine resolves)
 *  4. Model — REAL dropdown dari `models.list` + auth status hint dari
 *     `models.authStatus`. Free-text fallback kalau model gak ada di catalog.
 *  5. Fallback models — chip-style multi-select
 *  6. Quick actions — Copy ID, Hapus agen (kalau bukan default)
 *
 * Save flow: dirty detection + Simpan button at bottom. Calls
 * `agents.update` for identity/model/workspace, separately `setDefault`
 * for default flag.
 */
import {
  Bot,
  Check,
  ChevronDown,
  Copy,
  Loader2,
  Package,
  Save,
  Sparkles,
  Star,
  Trash2,
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
  randomEmoji,
  SUGGESTED_EMOJIS,
} from "./helpers";
import { deleteAgent, updateAgentRich } from "./use-agents-data";
import { AgentCapabilitySummary } from "./agent-capability-summary";
import { THEME_GRADIENT, AGENTBUFF_LOGO } from "./agent-profile";

type ToastSetter = (
  t: { kind: "success" | "error" | "info"; text: string } | null,
) => void;

export function AgentProfilPanel({
  agent,
  isDefault,
  modelsList,
  authProviders,
  loadingCatalog,
  onAfterChange,
  onAfterDelete,
  setToast,
  onJumpToKemampuan,
}: {
  agent: AgentRow;
  isDefault: boolean;
  allAgentIds: string[];
  modelsList: ModelChoice[];
  authProviders: ModelAuthProvider[];
  loadingCatalog: boolean;
  onAfterChange: () => void;
  onAfterDelete: () => void;
  setToast: ToastSetter;
  onJumpToKemampuan?: () => void;
}) {
  // Form state — every field seeded from the agent prop. Effect below
  // re-syncs whenever a different agent is selected (or list refetched).
  const initialName = agent.identity?.name || agent.name || "";
  const initialEmoji = agent.identity?.emoji || "";
  const initialAvatar = agent.identity?.avatar || "";
  const initialModel = agent.model?.primary || "";
  const initialFallbacks = agent.model?.fallbacks ?? [];
  const initialDescription = agent.description || "";

  const [name, setName] = useState(initialName);
  const [emoji, setEmoji] = useState(initialEmoji);
  const [avatar, setAvatar] = useState(initialAvatar);
  const [model, setModel] = useState(initialModel);
  const [fallbacks, setFallbacks] = useState<string[]>(initialFallbacks);
  const [description, setDescription] = useState(initialDescription);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [emojiPickerOpen, setEmojiPickerOpen] = useState(false);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);

  // Re-seed form state only when a DIFFERENT agent is selected. Keying on
  // agent.id (via a ref) means a background list.refetch() — which hands us a
  // NEW agent object with the SAME content — no longer re-runs this effect and
  // silently wipes the user's in-progress edits. (AgentDetail is also keyed by
  // agent.id so the panel remounts on a real switch; this guard is the safety
  // net + the actual fix for same-agent refetch edit-loss.) (Audit HIGH #4.)
  const syncedAgentIdRef = useRef(agent.id);
  useEffect(() => {
    if (syncedAgentIdRef.current === agent.id) return;
    syncedAgentIdRef.current = agent.id;
    setName(agent.identity?.name || agent.name || "");
    setEmoji(agent.identity?.emoji || "");
    setAvatar(agent.identity?.avatar || "");
    setModel(agent.model?.primary || "");
    setFallbacks(agent.model?.fallbacks ?? []);
    setDescription(agent.description || "");
    setConfirmDelete(false);
  }, [agent]);

  const dirty =
    name !== initialName ||
    emoji !== initialEmoji ||
    avatar !== initialAvatar ||
    model !== initialModel ||
    description !== initialDescription ||
    JSON.stringify(fallbacks) !== JSON.stringify(initialFallbacks);

  const handleSave = async () => {
    if (!dirty) return;
    setSaving(true);
    // Build a full subtree merge via updateAgentRich so model.fallbacks
    // and identity.* don't nuke sibling fields.
    const trimmedName = name.trim() || agent.id;
    const trimmedEmoji = emoji.trim();
    const trimmedAvatar = avatar.trim();
    const trimmedModel = model.trim();
    const trimmedDesc = description.trim();
    const res = await updateAgentRich(agent.id, agent, {
      ...(name !== initialName ? { name: trimmedName } : {}),
      ...(description !== initialDescription
        ? { description: trimmedDesc, description_auto: false }
        : {}),
      ...(emoji !== initialEmoji || avatar !== initialAvatar || name !== initialName
        ? {
            identity: {
              name: trimmedName,
              emoji: trimmedEmoji || undefined,
              avatar: trimmedAvatar || undefined,
            },
          }
        : {}),
      ...(model !== initialModel ||
      JSON.stringify(fallbacks) !== JSON.stringify(initialFallbacks)
        ? {
            model: {
              primary: trimmedModel || undefined,
              // Send the provider slug of the group this model was picked from.
              // A model id can live in MULTIPLE provider groups (e.g. "gpt-5.4"
              // exists under openai-codex AND openai AND openai-api); without
              // this the bridge guesses the FIRST match and can route to the
              // wrong provider (verified: gpt-5.4 → openai-codex instead of the
              // user's OpenAI-API key). The picker knows the exact group.
              providerSlug:
                findModelById(modelsList, trimmedModel)?.provider || undefined,
              fallbacks: fallbacks.length ? fallbacks : undefined,
            },
          }
        : {}),
    });
    setSaving(false);
    if (res.ok) {
      setToast({ kind: "success", text: "Agent profile saved" });
      onAfterChange();
    } else {
      setToast({ kind: "error", text: `Save failed: ${res.error}` });
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    const res = await deleteAgent({ agentId: agent.id });
    setDeleting(false);
    if (res.ok) {
      setToast({ kind: "success", text: "Agent deleted" });
      onAfterDelete();
    } else {
      setToast({ kind: "error", text: `Delete failed: ${res.error}` });
    }
  };

  const handleCopyId = async () => {
    try {
      await navigator.clipboard.writeText(agent.id);
      setToast({ kind: "info", text: `ID copied: ${agent.id}` });
    } catch {
      setToast({ kind: "error", text: "Browser blocked clipboard access" });
    }
  };

  const currentModelMeta = findModelById(modelsList, model);
  // Determine which provider auth status applies (best-effort match by
  // model.provider).
  const currentProviderStatus = currentModelMeta
    ? authProviders.find((p) => p.provider === currentModelMeta.provider)
    : undefined;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      {/* ── Capability summary banner ── */}
      <AgentCapabilitySummary
        agent={agent}
        onJumpToKemampuan={onJumpToKemampuan}
      />

      {/* ── Top action row ─ */}
      <section className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={handleCopyId}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/70 transition hover:border-cyan-400/40 hover:bg-white/[0.08] hover:text-white"
          title="Copy agent ID"
        >
          <Copy className="size-3.5" aria-hidden />
          <span className="normal-case tracking-normal">{agent.id}</span>
        </button>

        {/* M1 (2026-05-30): read-only home/specialist indicator. "Agen Utama"
            = the house assistant that answers when no specific agent is picked
            (the engine root profile — fixed per akun). Named agents are
            specialists you talk to on purpose. The old "Jadikan default"
            button wrote the engine active_profile sentinel, which split-
            brained the channel runtime (H1) — removed. */}
        {isDefault ? (
          <span
            className="inline-flex items-center gap-1.5 rounded-lg border border-cyan-400/40 bg-cyan-400/10 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-200"
            title="Main Agent — responds when you haven't selected a specific agent"
          >
            <Star className="size-3.5 fill-cyan-300" aria-hidden />
            Main Agent
          </span>
        ) : (
          <span
            className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-white/45"
            title="Specialist Agent — invoked directly via agent selection or a dedicated channel"
          >
            Specialist Agent
          </span>
        )}

        <div className="flex-1" />

        {/* Export sengaja dihilangkan (Chief 2026-06-01): arsip .tar.gz ikut
            bawa skill + plugin (termasuk item marketplace berbayar) → mindahin
            agen antar-akun gratisan jadi gampang. handleExport/exportAgent
            tinggal dikembalikan kalau mau diaktifkan lagi. */}

        {!isDefault ? (
          confirmDelete ? (
            <div className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/15 px-1.5 py-1">
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleting}
                className="inline-flex items-center gap-1 rounded-md bg-red-500 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-white hover:brightness-110 disabled:opacity-50"
              >
                {deleting ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden />
                ) : (
                  <Trash2 className="size-3" aria-hidden />
                )}
                Delete
              </button>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="rounded-md border border-white/15 bg-white/[0.04] px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-white/70 hover:text-white"
              >
                Cancel
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => setConfirmDelete(true)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/[0.08] px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-red-100 transition hover:border-red-500/50 hover:bg-red-500/15"
              title="Delete this agent"
            >
              <Trash2 className="size-3.5" aria-hidden />
              Delete agent
            </button>
          )
        ) : null}
      </section>

      {/* ── Peran / Description ── */}
      <Section
        title="Role & Description"
        subtitle="A short sentence about this agent. DISPLAYED below the agent name in every chat (if empty, defaults to 'Personal Assistant') — also used by the AI for routing."
      >
        <Field
          id="agent-desc"
          label="Role / short description (shown in chat)"
          hint="Keep it brief — 1 phrase. E.g. 'Personal Assistant', 'AI Copywriter'."
        >
          <input
            id="agent-desc"
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="e.g. Personal Assistant · handles scheduling & WhatsApp CS"
            maxLength={100}
            className={inputCls}
          />
          {/* Live preview — exactly how the name + role render in the chat
              header / bubbles (mirrors profileFromAgent's role fallback). */}
          <div className="mt-2 flex items-center gap-2 rounded-lg border border-white/[0.07] bg-white/[0.02] px-3 py-2">
            <span
              className={cn(
                "flex size-6 shrink-0 items-center justify-center overflow-hidden rounded-full border border-white/10 text-[12px]",
                isDefault
                  ? "bg-[#0B0E14]"
                  : "bg-gradient-to-br " +
                      ((agent.identity?.theme &&
                        THEME_GRADIENT[agent.identity.theme]) ||
                        "from-cyan-400 to-blue-500"),
              )}
            >
              {isDefault ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={AGENTBUFF_LOGO}
                  alt="AgentBuff"
                  className="size-full object-cover"
                />
              ) : (
                emoji || "🤖"
              )}
            </span>
            <span className="min-w-0 truncate text-[12px]">
              <span className="font-semibold text-white/85">
                {name || agent.id}
              </span>
              <span className="px-1 text-white/35">·</span>
              <span className="text-white/55">
                {description.trim() || "Personal Assistant"}
              </span>
            </span>
            <span className="ml-auto shrink-0 font-mono text-[9px] uppercase tracking-[0.16em] text-white/30">
              Preview chat
            </span>
          </div>
          <div className="mt-1 text-right font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
            {description.length}/100
          </div>
        </Field>
      </Section>

      {/* ── Identity ── */}
      <Section title="Identity" subtitle="Avatar and name shown in every conversation.">
        <div className="flex gap-4">
          {/* Avatar preview */}
          <div className="shrink-0">
            <div className="relative flex size-20 items-center justify-center overflow-hidden rounded-2xl border border-white/10 bg-white/[0.04] shadow-[0_8px_24px_-12px_rgba(99,102,241,0.4)]">
              {isDefault ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={AGENTBUFF_LOGO}
                  alt="AgentBuff"
                  className="size-full object-cover"
                />
              ) : avatar ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={avatar}
                  alt={name}
                  className="size-full object-cover"
                  onError={(e) => {
                    (e.target as HTMLImageElement).style.display = "none";
                  }}
                />
              ) : emoji ? (
                <span className="text-4xl">{emoji}</span>
              ) : (
                <Bot className="size-9 text-white/40" aria-hidden />
              )}
            </div>
          </div>
          <div className="flex-1 space-y-3">
            <Field id="agent-name" label="Display name" required>
              <input
                id="agent-name"
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Sora, Buff, Kira…"
                className={inputCls}
              />
            </Field>
            {isDefault ? (
              <div className="rounded-lg border border-cyan-400/20 bg-cyan-400/[0.05] px-3 py-2.5 text-[11.5px] leading-snug text-white/60">
                <span className="font-semibold text-cyan-200">Main Agent</span>{" "}
                uses the AgentBuff logo as its avatar — emoji &amp; avatar are
                locked to keep the brand consistent. Specialist agents (ones you
                create yourself) are free to set their own emoji/avatar.
              </div>
            ) : (
            <div className="grid grid-cols-2 gap-3">
              <Field
                label="Emoji"
                hint="Click to pick from the collection."
              >
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setEmojiPickerOpen((v) => !v)}
                    className="flex w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-left text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
                  >
                    <span className="flex items-center gap-2">
                      {emoji ? (
                        <span className="text-lg">{emoji}</span>
                      ) : (
                        <span className="text-white/40">Pick an emoji…</span>
                      )}
                    </span>
                    <ChevronDown
                      className={cn(
                        "size-4 text-white/55 transition-transform",
                        emojiPickerOpen && "rotate-180",
                      )}
                      aria-hidden
                    />
                  </button>
                  {emojiPickerOpen ? (
                    <div className="absolute left-0 right-0 top-full z-30 mt-1 rounded-lg border border-white/10 bg-[#0B0E14] p-2 shadow-[0_20px_48px_-12px_rgba(0,0,0,0.7)]">
                      <div className="grid grid-cols-8 gap-1">
                        {SUGGESTED_EMOJIS.map((e) => (
                          <button
                            key={e}
                            type="button"
                            onClick={() => {
                              setEmoji(e);
                              setEmojiPickerOpen(false);
                            }}
                            className={cn(
                              "rounded-md p-1.5 text-lg transition hover:bg-white/[0.06]",
                              emoji === e ? "bg-cyan-400/15" : "",
                            )}
                          >
                            {e}
                          </button>
                        ))}
                      </div>
                      <div className="mt-2 flex justify-between border-t border-white/[0.06] pt-2">
                        <button
                          type="button"
                          onClick={() => {
                            setEmoji(randomEmoji());
                            setEmojiPickerOpen(false);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/70 hover:text-white"
                        >
                          <Sparkles className="size-3" aria-hidden />
                          Random
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setEmoji("");
                            setEmojiPickerOpen(false);
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/70 hover:text-white"
                        >
                          <X className="size-3" aria-hidden />
                          Clear
                        </button>
                      </div>
                    </div>
                  ) : null}
                </div>
              </Field>
              <Field
                id="agent-avatar"
                label="Avatar URL"
                hint="Optional — overrides emoji when set."
              >
                <input
                  id="agent-avatar"
                  type="url"
                  value={avatar}
                  onChange={(e) => setAvatar(e.target.value)}
                  onBlur={(e) => {
                    // Allow root-relative paths + http(s) only; reject
                    // javascript:/data:/other schemes that would persist to
                    // disk + render in <img src>. (Audit LOW security.)
                    const v = e.target.value.trim();
                    if (!v || v.startsWith("/")) return;
                    try {
                      const parsed = new URL(v);
                      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
                        setAvatar("");
                      }
                    } catch {
                      /* unparseable → leave for native type=url validation */
                    }
                  }}
                  placeholder="https://…"
                  className={inputCls}
                />
              </Field>
            </div>
            )}
          </div>
        </div>
      </Section>

      {/* ── Engine/model settings MOVED to the "Otak Agen" tab (clearer
          category — model utama + cadangan + tugas sampingan + context). This
          breadcrumb jumps there via the agent-detail hash-nav listener. ── */}
      <a
        href="#tab=otak"
        className="flex items-center gap-3 rounded-2xl border border-cyan-400/20 bg-cyan-400/[0.05] px-5 py-4 transition hover:border-cyan-400/40 hover:bg-cyan-400/[0.09]"
      >
        <Sparkles className="size-4 shrink-0 text-cyan-300" aria-hidden />
        <span className="min-w-0 text-[12px] leading-snug text-white/70">
          <span className="font-semibold text-cyan-200">Configure agent brain →</span>{" "}
          Primary model, fallback models & auxiliary tasks are now in the{" "}
          <span className="font-semibold text-white/90">Agent Brain</span> tab.
        </span>
      </a>

      {/* ── Save bar — self-contained floating action bar (aligned to the
          content width; no negative margins that overflow the card). ── */}
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
              {dirty
                ? "You have unsaved changes"
                : "All changes saved"}
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
            Save profile
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Sub-components ─────────────────────────────────────────────── */

function Section({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.02] p-5">
      <header className="mb-4">
        <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.22em] text-white/85">
          {title}
        </h3>
        {subtitle ? (
          <p className="mt-1 text-[11.5px] text-white/55">{subtitle}</p>
        ) : null}
      </header>
      <div className="space-y-3">{children}</div>
    </section>
  );
}

function Field({
  label,
  hint,
  required,
  id,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  id?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1 flex items-baseline gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/55"
      >
        {label}
        {required ? <span className="text-amber-300">*</span> : null}
      </label>
      {children}
      {hint ? (
        <p className="mt-1 text-[10.5px] leading-snug text-white/45">{hint}</p>
      ) : null}
    </div>
  );
}

function ModelPicker({
  value,
  options,
  authProviders,
  loading,
  open,
  setOpen,
  onChange,
}: {
  value: string;
  options: ModelChoice[];
  authProviders: ModelAuthProvider[];
  loading: boolean;
  open: boolean;
  setOpen: (v: boolean) => void;
  onChange: (next: string) => void;
}) {
  const [search, setSearch] = useState("");
  const [customMode, setCustomMode] = useState(false);

  // Reset transient picker UI when the dropdown closes so the next open starts
  // blank (catalog list, not the custom pane or a stale search). (Audit MED.)
  useEffect(() => {
    if (!open) {
      setSearch("");
      setCustomMode(false);
    }
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
    return Array.from(map.entries()).sort((a, b) =>
      a[0].localeCompare(b[0]),
    );
  }, [options, search]);

  const current = findModelById(options, value);
  const displayLabel = current
    ? formatModelLabel(current)
    : value
      ? `Custom: ${value}`
      : "Default (config)";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Model: ${displayLabel}`}
        className={cn(
          "flex w-full items-center justify-between gap-2 rounded-lg border bg-white/[0.03] px-3 py-2 text-left transition",
          open
            ? "border-cyan-400/50 ring-2 ring-cyan-400/20"
            : "border-white/10 hover:border-white/25",
        )}
      >
        <span className="flex min-w-0 items-center gap-2">
          <Sparkles className="size-3.5 shrink-0 text-cyan-300/85" aria-hidden />
          <span className="truncate text-[13px] font-semibold text-white/90">
            {displayLabel}
          </span>
        </span>
        <ChevronDown
          className={cn(
            "size-4 shrink-0 text-white/55 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
      </button>
      {open ? (
        <div className="absolute left-0 right-0 top-full z-30 mt-1 max-h-80 overflow-hidden rounded-lg border border-white/10 bg-[#0B0E14] shadow-[0_20px_48px_-12px_rgba(0,0,0,0.7)]">
          {customMode ? (
            <div className="p-3">
              <div className="mb-2 flex items-center justify-between">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
                  Custom model id
                </span>
                <button
                  type="button"
                  onClick={() => setCustomMode(false)}
                  className="rounded p-1 text-white/55 hover:bg-white/[0.05] hover:text-white"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              </div>
              <input
                autoFocus
                type="text"
                defaultValue={value}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const v = (e.target as HTMLInputElement).value.trim();
                    onChange(v);
                    setOpen(false);
                    setCustomMode(false);
                  }
                  if (e.key === "Escape") {
                    setCustomMode(false);
                  }
                }}
                placeholder="anthropic/claude-3-7-sonnet"
                className="w-full rounded-md border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
              />
              <p className="mt-2 text-[10px] text-white/45">
                Press Enter to apply. Models outside the catalog are accepted
                if the provider is active.
              </p>
            </div>
          ) : (
            <>
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
                    !value
                      ? "bg-cyan-400/15 text-cyan-100"
                      : "text-white/85 hover:bg-white/[0.04]",
                  )}
                >
                  <span className="text-[13px] font-semibold">
                    Default (config)
                  </span>
                  {!value ? <Check className="size-4 text-cyan-300" aria-hidden /> : null}
                </button>
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
                    const auth = authProviders.find((p) => p.provider === provider);
                    return (
                      <div key={provider} className="my-1">
                        <div className="flex items-center gap-2 px-3 py-1">
                          <span className="font-mono text-[9px] uppercase tracking-[0.2em] text-white/40">
                            {provider}
                          </span>
                          {auth ? <ProviderStatusDot status={auth} /> : null}
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
                                active
                                  ? "bg-cyan-400/15 text-cyan-100"
                                  : "text-white/85 hover:bg-white/[0.04]",
                              )}
                            >
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-[13px] font-semibold">
                                  {m.alias || m.name}
                                </div>
                                <div className="truncate font-mono text-[10px] text-white/45">
                                  {m.id}
                                  {m.contextWindow
                                    ? ` · ${m.contextWindow.toLocaleString("id-ID")} ctx`
                                    : ""}
                                </div>
                              </div>
                              {active ? (
                                <Check
                                  className="size-4 shrink-0 text-cyan-300"
                                  aria-hidden
                                />
                              ) : null}
                            </button>
                          );
                        })}
                      </div>
                    );
                  })
                )}
              </div>
              <div className="border-t border-white/[0.06] p-1">
                <button
                  type="button"
                  onClick={() => setCustomMode(true)}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-[12px] text-white/70 transition hover:bg-white/[0.04] hover:text-cyan-200"
                >
                  <span>Custom model id (advanced)…</span>
                  <ChevronDown className="size-3 -rotate-90" aria-hidden />
                </button>
              </div>
            </>
          )}
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
  onChange,
}: {
  values: string[];
  options: ModelChoice[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");
  const removeAt = (idx: number) => {
    onChange(values.filter((_, i) => i !== idx));
  };
  const add = () => {
    const v = draft.trim();
    if (!v) return;
    if (values.includes(v)) return;
    onChange([...values, v]);
    setDraft("");
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2">
        {values.length === 0 ? (
          <span className="text-[11.5px] text-white/40">
            No fallback models yet.
          </span>
        ) : (
          values.map((v, i) => {
            const meta = findModelById(options, v);
            return (
              <span
                key={`${v}-${i}`}
                className="inline-flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.05] px-2 py-0.5 text-[11px] text-white/85"
              >
                <span>{meta ? meta.alias || meta.name : v}</span>
                <button
                  type="button"
                  onClick={() => removeAt(i)}
                  className="rounded-full text-white/45 hover:text-red-300"
                  aria-label={`Remove ${v}`}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </span>
            );
          })
        )}
        <input
          type="text"
          aria-label="Add fallback model"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          placeholder={values.length === 0 ? "press Enter to add" : ""}
          className="flex-1 min-w-[120px] bg-transparent text-[12.5px] text-white placeholder:text-white/35 focus:outline-none"
        />
      </div>
    </div>
  );
}

const inputCls =
  "w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/10";
