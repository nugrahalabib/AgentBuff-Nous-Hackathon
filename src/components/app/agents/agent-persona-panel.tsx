"use client";

/**
 * AgentPersonaPanel — Tab 2 "Prompt & Persona"
 *
 * Workspace file editor with mass-market labels. Engine exposes 8 well-known
 * files (IDENTITY/SOUL/AGENTS/TOOLS/USER/HEARTBEAT/MEMORY/BOOTSTRAP).
 *
 * Layout: file list (cards w/ icon + label + subtitle) on left, full-height
 * monospace editor on right. Toolbar: Reset (revert), Simpan, Copy. Dirty
 * indicator on chip + save bar. Empty state when no file selected.
 *
 * Engine wire:
 *   - agents.files.list { agentId } → { files: [...] }
 *   - agents.files.get { agentId, name } → { file: { content } }
 *   - agents.files.set { agentId, name, content }
 *
 * Files belum di-create di workspace di-flag `missing: true` — kita tetep
 * izinin user mulai nulis (kosong dulu, save creates the file).
 */
import {
  AlertTriangle,
  Brain,
  Check,
  FileText,
  Heart,
  Info,
  Layers,
  Loader2,
  RotateCcw,
  Save,
  Scroll,
  User,
  Wand2,
  Wrench,
  Zap,
  Rocket,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  AGENT_FILE_META,
  KNOWN_FILE_ORDER,
  type AgentFileEntry,
  type AgentFileMeta,
  formatBytes,
  formatRelative,
} from "./helpers";
import { MemoryStructuredEditor } from "./memory-structured-editor";
import {
  getAgentFile,
  resetAgentFile,
  setAgentFile,
  useAgentFiles,
} from "./use-agents-data";

const RESETTABLE_FILES = new Set(["SOUL.md"]);
// REAL Hermes location (memory.ts:34-36) — was "MEMORY.md" pre-2026-05-26
const STRUCTURED_FILES = new Set(["memories/MEMORY.md"]);

type ToastSetter = (
  t: { kind: "success" | "error" | "info"; text: string } | null,
) => void;

export function AgentPersonaPanel({
  agentId,
  setToast,
}: {
  agentId: string;
  setToast: ToastSetter;
}) {
  const filesQuery = useAgentFiles(agentId);
  const remoteFiles = filesQuery.data?.files ?? [];

  // Merge remote files with known-order so user sees same set every agent
  // (so missing files are still visible as "tap untuk bikin").
  const orderedFiles = useMemo(() => {
    const byName = new Map<string, AgentFileEntry>();
    for (const f of remoteFiles) {
      // Normalize bridge shape → portal AgentFileEntry. The bridge sends
      // `mtime` (epoch SECONDS) and may omit updatedAtMs/missing on older
      // builds; derive them so "Ukuran/Update" + the missing badge are
      // accurate. A file the engine hasn't created yet has mtime === null.
      const raw = f as AgentFileEntry & { mtime?: number | null };
      const updatedAtMs =
        raw.updatedAtMs ??
        (typeof raw.mtime === "number" ? Math.round(raw.mtime * 1000) : undefined);
      const missing =
        raw.missing ?? (raw.mtime == null && !raw.updatedAtMs);
      byName.set(f.name, { ...f, updatedAtMs, missing });
    }
    const out: Array<AgentFileEntry & { meta: AgentFileMeta }> = [];
    for (const known of KNOWN_FILE_ORDER) {
      const meta = AGENT_FILE_META[known];
      if (!meta) continue;
      const entry =
        byName.get(known) ??
        ({
          name: known,
          path: known,
          missing: true,
        } as AgentFileEntry);
      out.push({ ...entry, meta });
    }
    // Append any unknown files (defensive — shouldn't happen normally)
    for (const f of remoteFiles) {
      if (!AGENT_FILE_META[f.name]) {
        out.push({
          ...f,
          meta: {
            filename: f.name,
            title: f.name,
            subtitle: "Other workspace file",
            icon: "info",
            tone: "indigo",
          },
        });
      }
    }
    return out;
  }, [remoteFiles]);

  const [active, setActive] = useState<string | null>(null);
  const [contents, setContents] = useState<Record<string, string>>({});
  const [originals, setOriginals] = useState<Record<string, string>>({});
  const [loadingFile, setLoadingFile] = useState<string | null>(null);
  const [savingFile, setSavingFile] = useState<string | null>(null);
  const [resetting, setResetting] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [memoryMode, setMemoryMode] = useState<"structured" | "raw">("structured");

  // Reset cache when agent changes
  useEffect(() => {
    setActive(null);
    setContents({});
    setOriginals({});
    setConfirmReset(false);
    setMemoryMode("structured");
  }, [agentId]);

  const handleOpen = useCallback(
    async (name: string) => {
      setActive(name);
      if (originals[name] !== undefined) return;
      setLoadingFile(name);
      const res = await getAgentFile(agentId, name);
      setLoadingFile(null);
      if (res.ok) {
        // Bridge returns flat {content} or normalized {file:{content}};
        // accept either shape so old/new bridges both work.
        const raw = res.data as unknown as {
          content?: string;
          file?: { content?: string };
        };
        const text = (raw.file?.content ?? raw.content ?? "") as string;
        setOriginals((p) => ({ ...p, [name]: text }));
        setContents((p) => ({ ...p, [name]: text }));
      } else {
        // missing file → start with empty draft
        setOriginals((p) => ({ ...p, [name]: "" }));
        setContents((p) => ({ ...p, [name]: "" }));
      }
    },
    [agentId, originals],
  );

  const handleSave = useCallback(async () => {
    if (!active) return;
    // Concurrent-save guard: a double-click on Simpan or rapid Ctrl+Enter
    // would otherwise fire two agents.files.set writes with undefined disk
    // ordering (potential corruption). One write at a time. (Audit HIGH #3.)
    if (savingFile) return;
    const content = contents[active] ?? "";
    setSavingFile(active);
    const res = await setAgentFile(agentId, active, content);
    setSavingFile(null);
    if (res.ok) {
      setOriginals((p) => ({ ...p, [active]: content }));
      setToast({ kind: "success", text: `${active} saved` });
      void filesQuery.refetch();
    } else {
      setToast({ kind: "error", text: `Save failed: ${res.error}` });
    }
  }, [active, agentId, contents, filesQuery, setToast, savingFile]);

  const handleReset = useCallback(() => {
    if (!active) return;
    setContents((p) => ({ ...p, [active]: originals[active] ?? "" }));
  }, [active, originals]);

  const handleResetToDefault = useCallback(async () => {
    if (!active || !RESETTABLE_FILES.has(active)) return;
    setResetting(true);
    const res = await resetAgentFile(agentId, active);
    setResetting(false);
    setConfirmReset(false);
    if (res.ok) {
      // Refetch to get the new default content
      const fresh = await getAgentFile(agentId, active);
      if (fresh.ok) {
        // Bridge may return flat {content} or {file:{content}} — mirror
        // handleOpen's defensive read so a flat-shape response doesn't throw
        // (TypeError on fresh.data.file) and silently leave stale content.
        const raw = fresh.data as unknown as {
          content?: string;
          file?: { content?: string };
        };
        const text = (raw.file?.content ?? raw.content ?? "") as string;
        setOriginals((p) => ({ ...p, [active]: text }));
        setContents((p) => ({ ...p, [active]: text }));
      }
      setToast({ kind: "success", text: `${active} reset to default` });
      void filesQuery.refetch();
    } else {
      setToast({ kind: "error", text: `Reset failed: ${res.error}` });
    }
  }, [active, agentId, filesQuery, setToast]);

  const activeContent = active ? contents[active] : undefined;
  const activeOriginal = active ? originals[active] : undefined;
  const activeDirty =
    active !== null &&
    activeContent !== undefined &&
    activeContent !== activeOriginal;

  const activeMeta = active ? AGENT_FILE_META[active] : null;
  const activeEntry = active ? orderedFiles.find((f) => f.name === active) : null;

  return (
    <div className="grid h-full min-h-0 grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
      {/* ── File rail ── */}
      <aside className="scrollbar-slim min-h-0 lg:max-h-[calc(100vh-220px)] lg:overflow-y-auto">
        {filesQuery.loading && remoteFiles.length === 0 ? (
          <div className="space-y-2">
            {[0, 1, 2, 3].map((i) => (
              <div
                key={i}
                className="h-14 animate-pulse rounded-xl bg-white/[0.03]"
              />
            ))}
          </div>
        ) : (
          <ul className="space-y-1.5">
            {orderedFiles.map((f) => {
              const isActive = active === f.name;
              const Icon = iconFor(f.meta.icon);
              return (
                <li key={f.name}>
                  <button
                    type="button"
                    onClick={() => void handleOpen(f.name)}
                    className={cn(
                      "group flex w-full items-start gap-2.5 rounded-lg border px-2.5 py-2 text-left transition",
                      isActive
                        ? toneCls(f.meta.tone, "active")
                        : "border-white/[0.06] bg-white/[0.02] hover:border-white/15 hover:bg-white/[0.04]",
                    )}
                  >
                    <div
                      className={cn(
                        "flex size-8 shrink-0 items-center justify-center rounded-lg border transition",
                        isActive
                          ? toneCls(f.meta.tone, "icon-active")
                          : "border-white/10 bg-white/[0.04] text-white/65",
                      )}
                    >
                      <Icon className="size-4" aria-hidden />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span
                          className={cn(
                            "truncate text-[12.5px] font-semibold",
                            isActive ? "text-white" : "text-white/85",
                          )}
                        >
                          {f.meta.title}
                        </span>
                        {f.missing ? (
                          <span className="shrink-0 rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0 font-mono text-[9px] uppercase tracking-[0.16em] text-amber-200">
                            empty
                          </span>
                        ) : null}
                      </div>
                      <p className="mt-0.5 text-[10.5px] leading-snug text-white/45">
                        {f.meta.subtitle}
                      </p>
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      {/* ── Editor ── */}
      <main className="flex min-h-0 flex-col">
        {active && activeMeta ? (
          <div className="flex h-full min-h-0 flex-col">
            <header className="mb-3 shrink-0">
              <div className="flex items-baseline justify-between gap-2">
                <div>
                  <h3 className="font-display text-lg font-bold text-white">
                    {activeMeta.title}
                  </h3>
                  <p className="text-[12px] text-white/55">
                    {activeMeta.subtitle}
                  </p>
                </div>
                <span className="shrink-0 font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">
                  {activeMeta.filename}
                </span>
              </div>
              {activeEntry ? (
                <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/35">
                  {activeEntry.missing ? (
                    <span className="inline-flex items-center gap-1 text-amber-200/85">
                      <AlertTriangle className="size-3" aria-hidden />
                      File not yet created — save to initialize
                    </span>
                  ) : (
                    <>
                      <span className="inline-flex items-center gap-1 text-emerald-200/85">
                        <Check className="size-3" aria-hidden />
                        Exists in workspace
                      </span>
                      <span>
                        Size:{" "}
                        <span className="text-white/65 normal-case tracking-normal">
                          {formatBytes(activeEntry.size)}
                        </span>
                      </span>
                      <span>
                        Updated:{" "}
                        <span className="text-white/65 normal-case tracking-normal">
                          {formatRelative(activeEntry.updatedAtMs)}
                        </span>
                      </span>
                    </>
                  )}
                  {activeDirty ? (
                    <span className="inline-flex items-center gap-1 text-amber-300">
                      <AlertTriangle className="size-3" aria-hidden />
                      Unsaved changes
                    </span>
                  ) : null}
                </div>
              ) : null}
            </header>

            {STRUCTURED_FILES.has(active) ? (
              /* Memory mode toggle */
              <div className="mb-2 flex shrink-0 items-center gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
                  Mode:
                </span>
                <div className="inline-flex gap-1 rounded-lg border border-white/10 bg-white/[0.02] p-1">
                  <button
                    type="button"
                    onClick={() => setMemoryMode("structured")}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] transition",
                      memoryMode === "structured"
                        ? "bg-indigo-400/15 text-indigo-100"
                        : "text-white/55 hover:bg-white/[0.04] hover:text-white/80",
                    )}
                  >
                    <Layers className="size-3" aria-hidden />
                    Entry
                  </button>
                  <button
                    type="button"
                    onClick={() => setMemoryMode("raw")}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] transition",
                      memoryMode === "raw"
                        ? "bg-indigo-400/15 text-indigo-100"
                        : "text-white/55 hover:bg-white/[0.04] hover:text-white/80",
                    )}
                  >
                    <FileText className="size-3" aria-hidden />
                    Raw
                  </button>
                </div>
                <span className="font-mono text-[9.5px] uppercase tracking-[0.16em] text-white/35">
                  {memoryMode === "structured"
                    ? "edit per entry, capacity validation"
                    : "edit raw text, advanced"}
                </span>
              </div>
            ) : null}

            {STRUCTURED_FILES.has(active) && memoryMode === "structured" ? (
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
                <MemoryStructuredEditor agentId={agentId} setToast={setToast} />
              </div>
            ) : (
              <>
                <div className="relative flex min-h-0 flex-1 flex-col rounded-xl border border-white/10 bg-black/40 shadow-inner">
                  {loadingFile === active ? (
                    <div className="flex flex-1 items-center justify-center font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
                      <Loader2 className="mr-2 size-4 animate-spin" aria-hidden />
                      Loading file contents…
                    </div>
                  ) : (
                    <textarea
                      value={activeContent ?? ""}
                      onChange={(e) =>
                        setContents((p) => ({ ...p, [active]: e.target.value }))
                      }
                      spellCheck={false}
                      placeholder={defaultTemplateFor(active)}
                      className="scrollbar-slim flex-1 resize-none rounded-xl bg-transparent px-4 py-3 font-mono text-[12.5px] leading-relaxed text-white/90 placeholder:text-white/30 focus:outline-none"
                    />
                  )}
                </div>

                <div className="mt-3 flex shrink-0 items-center justify-end gap-2">
                  {RESETTABLE_FILES.has(active) ? (
                    confirmReset ? (
                      <div className="inline-flex items-center gap-1 rounded-lg border border-amber-400/40 bg-amber-400/15 px-1.5 py-1">
                        <button
                          type="button"
                          onClick={() => void handleResetToDefault()}
                          disabled={resetting}
                          className="inline-flex items-center gap-1 rounded-md bg-amber-500 px-2.5 py-1 font-mono text-[10px] font-bold uppercase tracking-wider text-[#0B0E14] hover:brightness-110 disabled:opacity-50"
                        >
                          {resetting ? (
                            <Loader2 className="size-3 animate-spin" aria-hidden />
                          ) : (
                            <Wand2 className="size-3" aria-hidden />
                          )}
                          Confirm reset?
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmReset(false)}
                          className="rounded-md border border-white/15 bg-white/[0.04] px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-white/70 hover:text-white"
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        type="button"
                        onClick={() => setConfirmReset(true)}
                        className="inline-flex items-center gap-1.5 rounded-lg border border-amber-400/30 bg-amber-400/[0.08] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-amber-100 transition hover:border-amber-400/50 hover:bg-amber-400/15"
                        title="Reset SOUL.md to AgentBuff default"
                      >
                        <Wand2 className="size-3.5" aria-hidden />
                        Reset to default
                      </button>
                    )
                  ) : null}
                  <button
                    type="button"
                    onClick={handleReset}
                    disabled={!activeDirty}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/70 transition hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    <RotateCcw className="size-3.5" aria-hidden />
                    Revert
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleSave()}
                    disabled={!activeDirty || savingFile === active}
                    className={cn(
                      "inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-[12px] font-bold transition",
                      activeDirty && savingFile !== active
                        ? "bg-gradient-to-r from-emerald-400 via-cyan-500 to-indigo-500 text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(16,185,129,0.5)] hover:brightness-110"
                        : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-white/40",
                    )}
                  >
                    {savingFile === active ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <Save className="size-3.5" aria-hidden />
                    )}
                    Save
                  </button>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="flex h-full min-h-[280px] flex-1 items-center justify-center rounded-xl border border-dashed border-white/[0.08] bg-white/[0.01] px-6 py-12 text-center">
            <div>
              <FileText className="mx-auto size-10 text-white/25" aria-hidden />
              <div className="mt-3 font-mono text-[10px] uppercase tracking-[0.2em] text-white/40">
                Select a file first
              </div>
              <p className="mt-1 max-w-sm text-[12.5px] text-white/55">
                Click any card on the left to edit. Each file has a different
                purpose — Persona for identity, Soul for core traits,
                Rulebook for SOPs, and so on.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

function iconFor(name: AgentFileMeta["icon"]) {
  switch (name) {
    case "user":
      return User;
    case "scroll":
      return Scroll;
    case "heart":
      return Heart;
    case "wrench":
      return Wrench;
    case "info":
      return Info;
    case "pulse":
      return Zap;
    case "rocket":
      return Rocket;
    case "brain":
      return Brain;
    default:
      return FileText;
  }
}

function toneCls(tone: AgentFileMeta["tone"], variant: "active" | "icon-active") {
  const m: Record<
    AgentFileMeta["tone"],
    Record<"active" | "icon-active", string>
  > = {
    cyan: {
      active: "border-cyan-400/40 bg-cyan-400/[0.08]",
      "icon-active": "border-cyan-400/40 bg-cyan-400/15 text-cyan-200",
    },
    fuchsia: {
      active: "border-fuchsia-400/40 bg-fuchsia-400/[0.08]",
      "icon-active": "border-fuchsia-400/40 bg-fuchsia-400/15 text-fuchsia-200",
    },
    indigo: {
      active: "border-indigo-400/40 bg-indigo-400/[0.08]",
      "icon-active": "border-indigo-400/40 bg-indigo-400/15 text-indigo-200",
    },
    emerald: {
      active: "border-emerald-400/40 bg-emerald-400/[0.08]",
      "icon-active": "border-emerald-400/40 bg-emerald-400/15 text-emerald-200",
    },
    amber: {
      active: "border-amber-400/40 bg-amber-400/[0.08]",
      "icon-active": "border-amber-400/40 bg-amber-400/15 text-amber-200",
    },
    rose: {
      active: "border-rose-400/40 bg-rose-400/[0.08]",
      "icon-active": "border-rose-400/40 bg-rose-400/15 text-rose-200",
    },
  };
  return m[tone][variant];
}

function defaultTemplateFor(filename: string): string {
  switch (filename) {
    case "SOUL.md":
      return (
        "You are <agent name>, an AI assistant for <role>.\n\n" +
        "## Communication style\n- \n\n## Rules\n- "
      );
    case "memories/USER.md":
      // Empty — owner context lives in SOUL.md now; don't auto-inject a
      // "Tentang Chief" template (chief: "ini harusnya kosong").
      return "";
    case "memories/MEMORY.md":
      return "";
    default:
      return "";
  }
}
