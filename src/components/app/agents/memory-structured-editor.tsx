"use client";

/**
 * MemoryStructuredEditor — entry-based MEMORY.md editor with capacity bar.
 *
 * Mirrors Hermes Desktop's Memory tab UX. Entries are separated by the
 * literal "§" delimiter (bridge ENTRY_DELIMITER). Each entry is a
 * free-form paragraph. Capacity gauge turns amber > 70%, red > 90%.
 *
 * Bridge wire:
 *   agents.memory.entries     → load
 *   agents.memory.addEntry    → append
 *   agents.memory.updateEntry → edit at index
 *   agents.memory.removeEntry → delete at index
 */
import {
  AlertTriangle,
  Brain,
  Check,
  Loader2,
  Pencil,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import {
  addMemoryEntry,
  removeMemoryEntry,
  updateMemoryEntry,
  useAgentMemoryEntries,
} from "./use-agents-data";

type ToastSetter = (
  t: { kind: "success" | "error" | "info"; text: string } | null,
) => void;

export function MemoryStructuredEditor({
  agentId,
  setToast,
}: {
  agentId: string;
  setToast: ToastSetter;
}) {
  const query = useAgentMemoryEntries(agentId);
  const data = query.data;
  const entries = data?.entries ?? [];
  const charCount = data?.charCount ?? 0;
  const charLimit = data?.charLimit ?? 2200;

  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [busyIndex, setBusyIndex] = useState<number | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null);

  // Reset state when agent changes
  useEffect(() => {
    setDraft("");
    setEditIndex(null);
    setEditDraft("");
    setBusyIndex(null);
    setConfirmRemove(null);
  }, [agentId]);

  const pct = Math.min(100, Math.round((charCount / Math.max(1, charLimit)) * 100));
  const tone: "emerald" | "amber" | "red" =
    pct >= 90 ? "red" : pct >= 70 ? "amber" : "emerald";

  const handleAdd = useCallback(async () => {
    const content = draft.trim();
    if (!content) return;
    setAdding(true);
    const res = await addMemoryEntry(agentId, content);
    setAdding(false);
    if (res.ok) {
      setDraft("");
      setToast({ kind: "success", text: "Entry added" });
      void query.refetch();
    } else {
      setToast({ kind: "error", text: res.error });
    }
  }, [agentId, draft, query, setToast]);

  const handleSaveEdit = useCallback(async () => {
    if (editIndex === null) return;
    const content = editDraft.trim();
    if (!content) return;
    setBusyIndex(editIndex);
    const res = await updateMemoryEntry(agentId, editIndex, content);
    setBusyIndex(null);
    if (res.ok) {
      setEditIndex(null);
      setEditDraft("");
      setToast({ kind: "success", text: "Entry saved" });
      void query.refetch();
    } else {
      setToast({ kind: "error", text: res.error });
    }
  }, [agentId, editIndex, editDraft, query, setToast]);

  const handleRemove = useCallback(
    async (index: number) => {
      setBusyIndex(index);
      const res = await removeMemoryEntry(agentId, index);
      setBusyIndex(null);
      setConfirmRemove(null);
      // Clear edit state too — after a delete the indices shift, so a lingering
      // editIndex would point at the wrong entry. (Audit MED.)
      setEditIndex(null);
      setEditDraft("");
      if (res.ok) {
        setToast({ kind: "success", text: "Entry removed" });
        void query.refetch();
      } else {
        setToast({ kind: "error", text: res.error });
      }
    },
    [agentId, query, setToast],
  );

  if (query.loading && entries.length === 0) {
    return (
      <div className="space-y-2">
        <div className="h-16 animate-pulse rounded-xl bg-white/[0.02]" />
        <div className="h-20 animate-pulse rounded-xl bg-white/[0.02]" />
        <div className="h-20 animate-pulse rounded-xl bg-white/[0.02]" />
      </div>
    );
  }

  if (query.error) {
    return (
      <div className="rounded-xl border border-red-500/30 bg-red-500/[0.06] px-4 py-3 text-[12.5px] text-red-100">
        <div className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-red-200">
          Failed to load memory
        </div>
        <p className="mt-1 text-[11.5px] text-red-100/85">{query.error}</p>
        <button
          type="button"
          onClick={() => void query.refetch()}
          className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-red-500/40 bg-red-500/15 px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider text-red-100 hover:bg-red-500/20"
        >
          Refresh
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Capacity bar */}
      <section className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Brain className="size-4 text-indigo-300" aria-hidden />
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-white/85">
              Memory Capacity
            </span>
          </div>
          <span
            className={cn(
              "font-mono text-[11px] tabular-nums",
              tone === "red"
                ? "text-red-200"
                : tone === "amber"
                  ? "text-amber-200"
                  : "text-emerald-200",
            )}
          >
            {charCount.toLocaleString("id-ID")} / {charLimit.toLocaleString("id-ID")}
            <span className="ml-1.5 text-white/45">({pct}%)</span>
          </span>
        </div>
        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/[0.05]">
          <div
            className={cn(
              "h-full rounded-full transition-all",
              tone === "red"
                ? "bg-gradient-to-r from-red-500 to-red-400 shadow-[0_0_10px_-2px_rgba(239,68,68,0.6)]"
                : tone === "amber"
                  ? "bg-gradient-to-r from-amber-400 to-amber-300"
                  : "bg-gradient-to-r from-emerald-400 to-cyan-400",
            )}
            style={{ width: `${pct}%` }}
          />
        </div>
        {tone === "red" ? (
          <p className="mt-2 inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-red-200/85">
            <AlertTriangle className="size-3" aria-hidden />
            Almost full — remove old entries before adding new ones
          </p>
        ) : null}
      </section>

      {/* Add new entry */}
      <section className="rounded-xl border border-white/[0.08] bg-white/[0.02] p-3">
        <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
          Add new entry
        </label>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. Chief prefers concise answers — avoid long paragraphs."
          rows={2}
          className="w-full resize-none rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-white placeholder:text-white/35 focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/10"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void handleAdd();
            }
          }}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
            {draft.length} char · Ctrl+Enter to save
          </span>
          <button
            type="button"
            onClick={() => void handleAdd()}
            disabled={!draft.trim() || adding || charCount + draft.length > charLimit}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12px] font-bold transition",
              draft.trim() && !adding && charCount + draft.length <= charLimit
                ? "bg-gradient-to-r from-emerald-400 via-cyan-500 to-indigo-500 text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(16,185,129,0.5)] hover:brightness-110"
                : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-white/40",
            )}
          >
            {adding ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Plus className="size-3.5" aria-hidden />
            )}
            Add
          </button>
        </div>
      </section>

      {/* Entry list */}
      <section className="space-y-2">
        {entries.length === 0 ? (
          <div className="rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] px-4 py-10 text-center">
            <Brain
              className="mx-auto mb-2 size-7 text-white/25"
              aria-hidden
            />
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
              No memory yet
            </p>
            <p className="mt-1 text-[12px] text-white/55">
              Add the first entry for this agent above. The agent reads memory every session.
            </p>
          </div>
        ) : (
          entries.map((entry) => {
            const isEditing = editIndex === entry.index;
            const isBusy = busyIndex === entry.index;
            const isConfirming = confirmRemove === entry.index;
            return (
              <div
                key={`${entry.index}:${entry.content.slice(0, 40)}`}
                className={cn(
                  "group rounded-xl border bg-white/[0.02] px-3 py-2.5 transition",
                  isEditing
                    ? "border-cyan-400/40 bg-cyan-400/[0.04]"
                    : "border-white/[0.06] hover:border-white/15 hover:bg-white/[0.04]",
                )}
              >
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-indigo-300/80">
                    Entry #{entry.index + 1}
                  </span>
                  {!isEditing ? (
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        type="button"
                        onClick={() => {
                          setEditIndex(entry.index);
                          setEditDraft(entry.content);
                          setConfirmRemove(null);
                        }}
                        className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.03] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/65 hover:border-cyan-400/40 hover:text-cyan-200"
                        title="Edit this entry"
                      >
                        <Pencil className="size-3" aria-hidden />
                        Edit
                      </button>
                      {isConfirming ? (
                        <>
                          <button
                            type="button"
                            onClick={() => void handleRemove(entry.index)}
                            disabled={isBusy}
                            className="inline-flex items-center gap-1 rounded-md bg-red-500 px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase tracking-[0.14em] text-white hover:brightness-110 disabled:opacity-50"
                          >
                            {isBusy ? (
                              <Loader2 className="size-3 animate-spin" aria-hidden />
                            ) : (
                              <Trash2 className="size-3" aria-hidden />
                            )}
                            Confirm?
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmRemove(null)}
                            className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-white/70 hover:text-white"
                          >
                            <X className="size-3" aria-hidden />
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmRemove(entry.index)}
                          className="inline-flex items-center gap-1 rounded-md border border-red-500/30 bg-red-500/[0.06] px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-red-200 hover:border-red-500/50 hover:bg-red-500/15"
                          title="Delete this entry"
                        >
                          <Trash2 className="size-3" aria-hidden />
                          Delete
                        </button>
                      )}
                    </div>
                  ) : null}
                </div>
                {isEditing ? (
                  <>
                    <textarea
                      autoFocus
                      value={editDraft}
                      onChange={(e) => setEditDraft(e.target.value)}
                      rows={3}
                      className="mt-1 w-full resize-none rounded-lg border border-white/10 bg-black/30 px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/10"
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                          e.preventDefault();
                          void handleSaveEdit();
                        }
                        if (e.key === "Escape") {
                          setEditIndex(null);
                          setEditDraft("");
                        }
                      }}
                    />
                    <div className="mt-2 flex items-center justify-between gap-2">
                      <span className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
                        {editDraft.length} char · Ctrl+Enter to save · Esc to cancel
                      </span>
                      <div className="flex gap-1">
                        <button
                          type="button"
                          onClick={() => {
                            setEditIndex(null);
                            setEditDraft("");
                          }}
                          className="inline-flex items-center gap-1 rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/70 hover:text-white"
                        >
                          <X className="size-3" aria-hidden />
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => void handleSaveEdit()}
                          disabled={!editDraft.trim() || isBusy}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] transition",
                            editDraft.trim() && !isBusy
                              ? "bg-emerald-400/20 text-emerald-100 hover:bg-emerald-400/30"
                              : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-white/40",
                          )}
                        >
                          {isBusy ? (
                            <Loader2 className="size-3 animate-spin" aria-hidden />
                          ) : (
                            <Check className="size-3" aria-hidden />
                          )}
                          Save
                        </button>
                      </div>
                    </div>
                  </>
                ) : (
                  <p className="mt-1 whitespace-pre-wrap text-[13px] leading-relaxed text-white/85">
                    {entry.content}
                  </p>
                )}
              </div>
            );
          })
        )}
      </section>
    </div>
  );
}
