"use client";

/**
 * MediaSummaryCard — renders a synthetic "media chip" in a user bubble
 * when the original attachment file is no longer available (history
 * rehydrate path) but the bridge-injected text prefix indicates one was
 * present.
 *
 * Why this exists:
 *   * Hermes session storage only persists the prompt TEXT, not the
 *     attachment files. After page refresh / container restart / session
 *     reload, the optimistic `attachments` array on the user message is
 *     gone — but the text still contains `[The user sent a voice message~
 *     ...]` style prefixes the bridge added at send time.
 *   * Rendering that prefix as raw chat prose ("[The user sent...]") is
 *     ugly UX. Telegram/WhatsApp would show a tiny VN bubble with the
 *     transcript instead.
 *   * `parseUserPayload` extracts these prefixes into `mediaSummaries`;
 *     this component renders each summary as a friendly chip.
 *
 * Visual language matches the live attachment cards (`AudioCard`,
 * `VideoCard`, `DocumentCard`) but uses a "memory" treatment — slightly
 * dimmed border, "rekap" label — so users understand the original file
 * is no longer playable/downloadable, just the AI's transcript record.
 */

import {
  AudioLines,
  FileText,
  FileVideo,
  Image as ImageIcon,
} from "lucide-react";
import type { MediaSummary } from "@/lib/app/strip-inbound-meta";
import { cn } from "@/lib/utils";

export function MediaSummaryList({
  summaries,
}: {
  summaries: MediaSummary[];
}) {
  if (!summaries || summaries.length === 0) return null;
  return (
    <div className="flex flex-col items-end gap-1.5">
      {summaries.map((s, i) => (
        <MediaSummaryCard key={i} summary={s} />
      ))}
    </div>
  );
}

function MediaSummaryCard({ summary }: { summary: MediaSummary }) {
  switch (summary.kind) {
    case "audio":
      return <AudioSummary transcript={summary.transcript} />;
    case "video":
      return <VideoSummary description={summary.description} />;
    case "document":
      return (
        <DocumentSummary
          name={summary.name}
          docKind={summary.docKind}
          extractedContent={summary.extractedContent}
        />
      );
    case "image":
      return <ImageSummary description={summary.description} />;
    default:
      return null;
  }
}

// ── Per-kind cards ────────────────────────────────────────────────────────

function AudioSummary({ transcript }: { transcript: string }) {
  return (
    <div className="flex w-full max-w-md flex-col gap-1.5 rounded-2xl rounded-tr-md border border-fuchsia-400/35 bg-[#0B0E14]/80 px-3 py-2.5 shadow-[0_0_0_1px_rgba(217,70,239,0.08)]">
      <div className="flex items-center gap-2">
        <div className="flex size-8 items-center justify-center rounded-full bg-fuchsia-400/20 text-fuchsia-100 shadow-[0_0_10px_rgba(217,70,239,0.3)]">
          <AudioLines className="size-4" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-fuchsia-200/85">
            Voice note
          </span>
          <span className="text-[10px] text-white/40">
            Rekap transkrip — file asli sudah tidak tersimpan
          </span>
        </div>
      </div>
      {transcript ? (
        <p className="whitespace-pre-wrap break-words border-l-2 border-fuchsia-400/30 pl-3 text-sm italic text-white/85">
          &ldquo;{transcript}&rdquo;
        </p>
      ) : (
        <p className="text-xs italic text-white/45">
          (transkrip kosong)
        </p>
      )}
    </div>
  );
}

function VideoSummary({ description }: { description: string }) {
  return (
    <div className="flex w-full max-w-md flex-col gap-1.5 rounded-2xl rounded-tr-md border border-indigo-400/35 bg-[#0B0E14]/80 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div className="flex size-8 items-center justify-center rounded-full bg-indigo-400/20 text-indigo-100">
          <FileVideo className="size-4" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-indigo-200/85">
            Video
          </span>
          <span className="text-[10px] text-white/40">
            Rekap deskripsi — file asli sudah tidak tersimpan
          </span>
        </div>
      </div>
      {description ? (
        <p className="whitespace-pre-wrap break-words border-l-2 border-indigo-400/30 pl-3 text-sm text-white/85">
          {description}
        </p>
      ) : null}
    </div>
  );
}

const DOC_KIND_COLOR: Record<string, { border: string; text: string; bg: string }> = {
  PDF: {
    border: "border-red-400/35",
    text: "text-red-200",
    bg: "bg-red-500/15",
  },
  DOCX: {
    border: "border-blue-400/35",
    text: "text-blue-200",
    bg: "bg-blue-500/15",
  },
  XLSX: {
    border: "border-emerald-400/35",
    text: "text-emerald-200",
    bg: "bg-emerald-500/15",
  },
  PPTX: {
    border: "border-orange-400/35",
    text: "text-orange-200",
    bg: "bg-orange-500/15",
  },
  TXT: {
    border: "border-white/20",
    text: "text-white/85",
    bg: "bg-white/[0.06]",
  },
};

function DocumentSummary({
  name,
  docKind,
  extractedContent,
}: {
  name: string;
  docKind?: string;
  extractedContent?: string;
}) {
  const meta =
    DOC_KIND_COLOR[docKind?.toUpperCase() ?? ""] ?? DOC_KIND_COLOR.TXT;
  return (
    <div
      className={cn(
        "flex w-full max-w-md flex-col gap-1.5 rounded-2xl rounded-tr-md border bg-[#0B0E14]/80 px-3 py-2.5",
        meta.border,
      )}
    >
      <div className="flex items-center gap-2">
        <div
          className={cn(
            "flex size-8 items-center justify-center rounded-lg border",
            meta.border,
            meta.bg,
            meta.text,
          )}
        >
          <FileText className="size-4" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="truncate text-sm font-medium text-white/95">{name}</p>
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
            {docKind ?? "DOC"} · rekap dokumen
          </span>
        </div>
      </div>
      {extractedContent ? (
        <details className="group/doc">
          <summary className="cursor-pointer text-[10px] font-mono uppercase tracking-[0.18em] text-white/45 hover:text-white/70">
            Lihat isi yang ke-extract ▾
          </summary>
          <pre className="mt-2 max-h-60 overflow-auto whitespace-pre-wrap rounded-lg border border-white/10 bg-black/30 p-2 font-mono text-[11px] text-white/75">
            {extractedContent.length > 4000
              ? extractedContent.slice(0, 4000) + "\n\n…(dipotong)"
              : extractedContent}
          </pre>
        </details>
      ) : null}
    </div>
  );
}

function ImageSummary({ description }: { description?: string }) {
  return (
    <div className="flex w-full max-w-md flex-col gap-1.5 rounded-2xl rounded-tr-md border border-cyan-400/35 bg-[#0B0E14]/80 px-3 py-2.5">
      <div className="flex items-center gap-2">
        <div className="flex size-8 items-center justify-center rounded-full bg-cyan-400/20 text-cyan-100">
          <ImageIcon className="size-4" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-200/85">
            Gambar
          </span>
          <span className="text-[10px] text-white/40">
            Rekap — file asli sudah tidak tersimpan
          </span>
        </div>
      </div>
      {description ? (
        <p className="border-l-2 border-cyan-400/30 pl-3 text-sm text-white/85">
          {description}
        </p>
      ) : null}
    </div>
  );
}
