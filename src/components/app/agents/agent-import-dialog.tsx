"use client";

/**
 * AgentImportDialog — restore an agent from a .agentbuff.tar.gz archive.
 *
 * Two input paths:
 *   - File picker: user selects local .tar.gz → we read as base64
 *   - Paste base64: for transferring across machines without download
 *
 * Optional rename + overwrite collision flag.
 */
import {
  AlertTriangle,
  ClipboardPaste,
  Download,
  FileUp,
  Loader2,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { AgentModalShell } from "./agent-modal-shell";
import { type AgentRow, suggestAgentIdFromName } from "./helpers";
import { importAgent } from "./use-agents-data";

const MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB — matches bridge cap

type ToastSetter = (
  t: { kind: "success" | "error" | "info"; text: string } | null,
) => void;

type Mode = "file" | "paste";

export function AgentImportDialog({
  open,
  existingAgents,
  onClose,
  onImported,
  setToast,
}: {
  open: boolean;
  existingAgents: AgentRow[];
  onClose: () => void;
  onImported: (agentId: string) => void;
  setToast: ToastSetter;
}) {
  const fileInput = useRef<HTMLInputElement | null>(null);
  const [mode, setMode] = useState<Mode>("file");
  const [base64, setBase64] = useState("");
  const [filename, setFilename] = useState("");
  const [newId, setNewId] = useState("");
  const [overwrite, setOverwrite] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [decoding, setDecoding] = useState(false);

  useEffect(() => {
    if (!open) {
      setMode("file");
      setBase64("");
      setFilename("");
      setNewId("");
      setOverwrite(false);
      setSubmitting(false);
      setDecoding(false);
    }
  }, [open]);

  const handleFilePicked = async (file: File | null | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) {
      setToast({
        kind: "error",
        text: `File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Max 10 MB.`,
      });
      return;
    }
    setDecoding(true);
    try {
      // FileReader.readAsDataURL decodes off the main thread. The old
      // O(n^2) String.fromCharCode concat loop blocked the UI for seconds
      // near the 10MB cap on low-end Android (target market). (Audit HIGH #7.)
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(reader.error ?? new Error("failed to read file"));
        reader.readAsDataURL(file);
      });
      const comma = dataUrl.indexOf(",");
      setBase64(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
      setFilename(file.name);
      // Try to extract default newId from filename
      const inferred = file.name
        .replace(/\.agentbuff\.tar\.gz$/i, "")
        .replace(/\.tar\.gz$/i, "")
        .replace(/\.zip$/i, "");
      if (inferred && !newId) {
        setNewId(suggestAgentIdFromName(inferred));
      }
    } catch (e) {
      setToast({
        kind: "error",
        text: `Failed to read file: ${(e as Error).message}`,
      });
    } finally {
      setDecoding(false);
    }
  };

  const handlePaste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!text.trim()) {
        setToast({ kind: "error", text: "Clipboard is empty" });
        return;
      }
      setBase64(text.trim());
      setFilename("(from clipboard)");
    } catch {
      setToast({
        kind: "error",
        text: "Browser blocked clipboard access — paste manually",
      });
    }
  };

  const handleSubmit = async () => {
    if (!base64.trim()) return;
    const trimmedNewId = newId.trim();
    if (trimmedNewId) {
      const collision = existingAgents.some((a) => a.id === trimmedNewId);
      if (collision && !overwrite) {
        setToast({
          kind: "error",
          text: `Agent "${trimmedNewId}" already exists — check overwrite or change the id`,
        });
        return;
      }
    }
    setSubmitting(true);
    const res = await importAgent({
      base64: base64.trim(),
      newAgentId: trimmedNewId || undefined,
      overwrite,
    });
    setSubmitting(false);
    if (res.ok) {
      const importedId = res.data.agentId;
      setToast({
        kind: "success",
        text: `Agent "${importedId}" imported successfully`,
      });
      onImported(importedId);
      onClose();
    } else {
      setToast({ kind: "error", text: `Import failed: ${res.error}` });
    }
  };

  const canSubmit = !!base64.trim() && !submitting && !decoding;

  return (
    <AgentModalShell
      open={open}
      onClose={onClose}
      width="md"
      eyebrow="Import agent"
      title="Restore agent from archive"
      subtitle="A .agentbuff.tar.gz file from a previous export or from another user."
      footer={
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[12px] font-semibold text-white/70 hover:text-white"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleSubmit()}
            disabled={!canSubmit}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-[12px] font-bold transition",
              canSubmit
                ? "bg-gradient-to-r from-emerald-400 via-cyan-500 to-indigo-500 text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(16,185,129,0.5)] hover:brightness-110"
                : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-white/40",
            )}
          >
            {submitting ? (
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
            ) : (
              <Upload className="size-3.5" aria-hidden />
            )}
            Import
          </button>
        </div>
      }
    >
      <div className="space-y-4">
        {/* Mode picker */}
        <div className="inline-flex w-full gap-1 rounded-xl border border-white/10 bg-white/[0.02] p-1">
          {(
            [
              { id: "file", label: "From file", icon: FileUp },
              { id: "paste", label: "Paste base64", icon: ClipboardPaste },
            ] as const
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() => setMode(m.id)}
              className={cn(
                "flex-1 inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-1.5 font-mono text-[10.5px] font-bold uppercase tracking-[0.18em] transition",
                mode === m.id
                  ? "bg-gradient-to-r from-cyan-400/20 via-indigo-500/20 to-fuchsia-500/20 text-white shadow-[0_0_0_1px_rgba(34,211,238,0.3)]"
                  : "text-white/55 hover:bg-white/[0.04] hover:text-white/80",
              )}
            >
              <m.icon className="size-3.5" aria-hidden />
              {m.label}
            </button>
          ))}
        </div>

        {mode === "file" ? (
          <div>
            <input
              ref={fileInput}
              type="file"
              accept=".tar.gz,.tgz,application/gzip,application/x-gtar,application/x-tar"
              hidden
              onChange={(e) => void handleFilePicked(e.target.files?.[0])}
            />
            <button
              type="button"
              onClick={() => fileInput.current?.click()}
              disabled={decoding}
              className={cn(
                "flex w-full items-center justify-center gap-2 rounded-xl border-2 border-dashed border-white/15 bg-white/[0.02] px-4 py-8 text-center transition hover:border-cyan-400/40 hover:bg-cyan-400/[0.04] disabled:opacity-60",
              )}
            >
              {decoding ? (
                <Loader2 className="size-5 animate-spin text-white/55" aria-hidden />
              ) : (
                <Download className="size-5 text-cyan-300" aria-hidden />
              )}
              <span className="text-[13px] font-semibold text-white/85">
                {decoding
                  ? "Processing file…"
                  : filename
                    ? `Change: ${filename}`
                    : "Choose a .agentbuff.tar.gz file"}
              </span>
            </button>
            <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.16em] text-white/35">
              Max 10 MB · Must be a tar.gz file produced by Export
            </p>
          </div>
        ) : (
          <div>
            <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
              Base64 archive
            </label>
            <textarea
              value={base64}
              onChange={(e) => {
                setBase64(e.target.value);
                setFilename(e.target.value ? "(pasted manually)" : "");
              }}
              placeholder="paste base64 string here…"
              rows={6}
              className="w-full resize-none rounded-lg border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] text-white placeholder:text-white/35 focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/10"
            />
            <button
              type="button"
              onClick={() => void handlePaste()}
              className="mt-2 inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/70 hover:border-cyan-400/40 hover:text-cyan-200"
            >
              <ClipboardPaste className="size-3" aria-hidden />
              Paste from clipboard
            </button>
          </div>
        )}

        {base64 ? (
          <div className="rounded-xl border border-emerald-400/25 bg-emerald-400/[0.04] px-3 py-2 text-[11.5px] text-emerald-100/85">
            ✓ Ready to import · {(base64.length * 3 / 4 / 1024).toFixed(1)} KB · {filename}
          </div>
        ) : null}

        <div>
          <label className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
            Agent ID (optional)
          </label>
          <input
            type="text"
            value={newId}
            onChange={(e) => setNewId(suggestAgentIdFromName(e.target.value))}
            placeholder="leave blank = use id from archive"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[12px] text-white focus:border-cyan-400/50 focus:outline-none focus:ring-2 focus:ring-cyan-400/10"
          />
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.16em] text-white/40">
            Lowercase alphanumeric + hyphen. 1-40 char.
          </p>
        </div>

        <label className="flex items-start gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.04] px-3 py-2 cursor-pointer">
          <input
            type="checkbox"
            checked={overwrite}
            onChange={(e) => setOverwrite(e.target.checked)}
            className="mt-0.5 size-3.5 shrink-0 accent-amber-400"
          />
          <span className="text-[11.5px] text-amber-100/90">
            <span className="font-mono text-[10px] font-bold uppercase tracking-[0.18em] text-amber-200">
              <AlertTriangle className="-mt-0.5 mr-1 inline-block size-3" aria-hidden />
              Overwrite
            </span>
            <br />
            Replace an agent with the same id if one already exists. The old
            agent's data will be permanently lost.
          </span>
        </label>
      </div>
    </AgentModalShell>
  );
}
