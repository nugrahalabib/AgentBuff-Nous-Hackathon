"use client";

/**
 * Per-kind attachment cards rendered inside chat message bubbles.
 *
 * Each card is the user's primary touch-point for interacting with the
 * file they sent:
 *   * ImageCard — thumbnail with hover-reveal action buttons; click opens
 *     the shared lightbox.
 *   * AudioCard — Telegram/WhatsApp-style custom player (uses the shared
 *     AudioPlayer component).
 *   * VideoCard — inline poster + play overlay + click-expand to fullscreen
 *     video in the lightbox.
 *   * DocumentCard — kind-colored icon + filename + size + Open/Download
 *     buttons. PDFs open inline in the browser's built-in PDF viewer.
 *
 * All cards expose download + open-in-new-tab as primary affordances so
 * the user can always retrieve their original file. Matches the
 * Telegram/WhatsApp/Slack UX baseline chief asked for.
 */

import { useState } from "react";
import {
  Download,
  ExternalLink,
  Eye,
  FileArchive,
  FileText,
  FileSpreadsheet,
  FileType,
  Image as ImageIcon,
  Play,
  Presentation,
  Maximize,
} from "lucide-react";
import { motion } from "framer-motion";
import type { AttachmentPart } from "@/lib/app/attachments";
import { prettyFileSize } from "@/lib/app/attachments";
import { AudioPlayer } from "./attachment-player";
import {
  downloadAttachment,
  openInNewTab,
} from "@/lib/app/attachment-actions";
import { cn } from "@/lib/utils";

// ─────────────────────────────────────────────────────────────────────
// ImageCard
// ─────────────────────────────────────────────────────────────────────

export function ImageCard({
  att,
  onClickPreview,
  size = "default",
}: {
  att: AttachmentPart;
  onClickPreview: () => void;
  /** "default" — full-width single image. "grid" — square in a 2-col grid. */
  size?: "default" | "grid";
}) {
  const [errored, setErrored] = useState(false);

  const onDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    downloadAttachment(att.displayUrl, att.name);
  };
  const onOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    openInNewTab(att.displayUrl);
  };

  if (errored) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-xl border border-white/10 bg-[#0B0E14]/80 px-3 py-6 text-center",
          size === "grid" ? "aspect-square" : "max-h-[280px] w-full",
        )}
      >
        <ImageIcon className="size-6 text-white/30" aria-hidden />
        <p className="line-clamp-1 text-[11px] font-semibold text-white/70">
          {att.name}
        </p>
        <p className="text-[10px] text-white/40">Gambar tidak bisa dimuat</p>
      </div>
    );
  }

  // Outer is `motion.div role="button"` (NOT `<button>`) so we can nest
  // additional `<button>` elements inside (Open / Download action chips)
  // without producing invalid HTML — nested buttons trigger a React
  // dev-mode warning AND cause inconsistent click behaviour across
  // browsers (Safari treats nested click as the OUTER button only).
  const onKeyActivate = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClickPreview();
    }
  };
  return (
    <motion.div
      role="button"
      tabIndex={0}
      onClick={onClickPreview}
      onKeyDown={onKeyActivate}
      whileHover={{ y: -1 }}
      className={cn(
        "group relative cursor-pointer overflow-hidden rounded-xl border border-white/10 bg-white/[0.03] text-left transition hover:border-cyan-400/40 hover:shadow-[0_12px_34px_-12px_rgba(34,211,238,0.45)] focus:outline-none focus:ring-2 focus:ring-cyan-400/40",
        size === "grid" ? "aspect-square w-full" : "w-full max-w-sm",
      )}
      aria-label={`Buka ${att.name}`}
    >
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={att.displayUrl}
        alt={att.name}
        onError={() => setErrored(true)}
        className={cn(
          "block w-full",
          size === "grid" ? "h-full object-cover" : "max-h-[280px] object-cover",
        )}
        loading="lazy"
        decoding="async"
        draggable={false}
      />
      {/* Hover overlay with name + size + action chips */}
      <div className="pointer-events-none absolute inset-0 flex flex-col justify-between bg-gradient-to-t from-black/65 via-black/15 to-black/45 opacity-0 transition group-hover:opacity-100">
        <div className="pointer-events-auto flex justify-end gap-1 p-2">
          <ActionChip onClick={onOpen} title="Buka di tab baru">
            <ExternalLink className="size-3" />
          </ActionChip>
          <ActionChip onClick={onDownload} title="Download">
            <Download className="size-3" />
          </ActionChip>
        </div>
        <div className="px-2.5 pb-2 text-left text-[10px] text-white">
          <p className="truncate font-medium">{att.name}</p>
          {att.sizeBytes ? (
            <p className="opacity-75">{prettyFileSize(att.sizeBytes)}</p>
          ) : null}
        </div>
      </div>
      {/* Always-visible expand hint at top-right (subtle) */}
      <div className="absolute right-2 top-2 rounded-full bg-black/60 p-1 text-white/80 opacity-0 backdrop-blur-md transition group-hover:opacity-100">
        <Maximize className="size-3" />
      </div>
    </motion.div>
  );
}

function ActionChip({
  onClick,
  title,
  children,
}: {
  onClick: (e: React.MouseEvent) => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="flex size-7 items-center justify-center rounded-md border border-white/15 bg-black/55 text-white transition hover:border-cyan-400/60 hover:bg-cyan-400/20 hover:text-cyan-100"
    >
      {children}
    </button>
  );
}

// ─────────────────────────────────────────────────────────────────────
// AudioCard — uses the shared AudioPlayer
// ─────────────────────────────────────────────────────────────────────

export function AudioCard({ att }: { att: AttachmentPart }) {
  // Only render the player when the URL is something the browser can
  // actually fetch (blob/data/same-origin). Other URLs fall back to a
  // download-only card.
  //
  // SSR safety: `window` is undefined on the server. AudioCard renders
  // inside a client component (chat-thread is "use client") but we
  // belt-and-suspenders the window access with a typeof check.
  const url = att.displayUrl || "";
  const sameOrigin =
    typeof window !== "undefined" &&
    !!window.location?.origin &&
    url.startsWith(window.location.origin);
  // Loopback cross-origin (`http://127.0.0.1:<port>/...` or `localhost`)
  // is the bridge media-serve port. CSP `media-src http://127.0.0.1:*`
  // permits this and `<audio src>` loads cross-origin WITHOUT CORS
  // preflight (HTML5 media element privilege). Bridge already sets
  // `Access-Control-Allow-Origin: *` defensively. Without this whitelist
  // the AudioCard falls back to FallbackDownloadCard the moment
  // backfillMeta (store.ts:2543+) swaps the optimistic blob: URL for the
  // persistent HTTP URL — chief sees a download-only chip on a VN he
  // JUST recorded (Bug 5, observed 2026-05-23).
  const isLoopback = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url);
  const isPlayable =
    url.startsWith("blob:") ||
    url.startsWith("data:") ||
    url.startsWith("/") ||
    sameOrigin ||
    isLoopback;

  if (!isPlayable) {
    return (
      <FallbackDownloadCard
        att={att}
        icon={<FileType className="size-5 text-fuchsia-200" />}
        accentBorder="border-fuchsia-400/30"
        kindLabel="Audio"
      />
    );
  }

  // Voice-notes get a Telegram-style label. Gap #7: prefer the explicit
  // `isVoiceNote` flag the bridge now sets from the agent's [[audio_as_voice]]
  // / TTS reply (and the composer mic for user sends); fall back to the legacy
  // `voice-note-` filename pattern for sessions persisted before the flag.
  const isVoiceNote = att.isVoiceNote ?? att.name.startsWith("voice-note-");
  const label = isVoiceNote ? "Voice note" : null;

  return (
    <AudioPlayer
      src={att.displayUrl}
      filename={att.name}
      label={label}
      variant="compact"
      showDownload
      className="max-w-md"
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// VideoCard
// ─────────────────────────────────────────────────────────────────────

export function VideoCard({
  att,
  onClickPreview,
}: {
  att: AttachmentPart;
  onClickPreview: () => void;
}) {
  const [errored, setErrored] = useState(false);
  const onDownload = (e: React.MouseEvent) => {
    e.stopPropagation();
    downloadAttachment(att.displayUrl, att.name);
  };
  const onOpen = (e: React.MouseEvent) => {
    e.stopPropagation();
    openInNewTab(att.displayUrl);
  };

  if (errored) {
    return (
      <FallbackDownloadCard
        att={att}
        icon={<FileType className="size-5 text-indigo-200" />}
        accentBorder="border-indigo-400/30"
        kindLabel="Video"
      />
    );
  }

  return (
    <motion.div
      whileHover={{ y: -1 }}
      className="group relative max-w-md overflow-hidden rounded-xl border border-indigo-400/30 bg-[#0B0E14]/80 transition hover:border-indigo-400/55 hover:shadow-[0_12px_34px_-12px_rgba(99,102,241,0.45)]"
    >
      {/* Inline `<video>` for inline preview. Click central play icon → expand */}
      <button
        type="button"
        onClick={onClickPreview}
        aria-label={`Putar ${att.name}`}
        className="relative block w-full focus:outline-none"
      >
        <video
          src={att.displayUrl}
          preload="metadata"
          onError={() => setErrored(true)}
          className="block max-h-[260px] w-full bg-black object-cover"
          // eslint-disable-next-line jsx-a11y/media-has-caption
        />
        {/* Centered play overlay */}
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/25 transition group-hover:bg-black/15">
          <div className="flex size-14 items-center justify-center rounded-full bg-indigo-500/80 text-white shadow-[0_0_24px_rgba(99,102,241,0.6)] backdrop-blur-md transition group-hover:scale-110 group-hover:bg-indigo-500">
            <Play className="ml-1 size-6 fill-current" />
          </div>
        </div>
      </button>
      {/* Info strip + action chips */}
      <div className="flex items-center gap-2 border-t border-white/10 bg-[#0B0E14]/80 px-3 py-2">
        <div className="min-w-0 flex-1">
          <p className="truncate text-xs font-medium text-white/90">
            {att.name}
          </p>
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-indigo-200/65">
            Video · {prettyFileSize(att.sizeBytes)}
          </p>
        </div>
        <button
          type="button"
          onClick={onOpen}
          aria-label="Buka di tab baru"
          title="Buka di tab baru"
          className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/65 transition hover:border-cyan-400/40 hover:text-cyan-200"
        >
          <ExternalLink className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={onDownload}
          aria-label="Download video"
          title="Download"
          className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/65 transition hover:border-cyan-400/40 hover:text-cyan-200"
        >
          <Download className="size-3.5" />
        </button>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// DocumentCard — PDF / DOCX / XLSX / PPTX / generic
// ─────────────────────────────────────────────────────────────────────

const DOC_EXTENSION_META: Record<
  string,
  {
    label: string;
    accentBorder: string;
    accentBg: string;
    accentText: string;
    icon: React.ComponentType<{ className?: string }>;
  }
> = {
  pdf: {
    label: "PDF",
    accentBorder: "border-red-400/35",
    accentBg: "bg-red-500/10",
    accentText: "text-red-200",
    icon: FileText,
  },
  doc: {
    label: "DOC",
    accentBorder: "border-blue-400/35",
    accentBg: "bg-blue-500/10",
    accentText: "text-blue-200",
    icon: FileType,
  },
  docx: {
    label: "DOCX",
    accentBorder: "border-blue-400/35",
    accentBg: "bg-blue-500/10",
    accentText: "text-blue-200",
    icon: FileType,
  },
  xls: {
    label: "XLS",
    accentBorder: "border-emerald-400/35",
    accentBg: "bg-emerald-500/10",
    accentText: "text-emerald-200",
    icon: FileSpreadsheet,
  },
  xlsx: {
    label: "XLSX",
    accentBorder: "border-emerald-400/35",
    accentBg: "bg-emerald-500/10",
    accentText: "text-emerald-200",
    icon: FileSpreadsheet,
  },
  ppt: {
    label: "PPT",
    accentBorder: "border-orange-400/35",
    accentBg: "bg-orange-500/10",
    accentText: "text-orange-200",
    icon: Presentation,
  },
  pptx: {
    label: "PPTX",
    accentBorder: "border-orange-400/35",
    accentBg: "bg-orange-500/10",
    accentText: "text-orange-200",
    icon: Presentation,
  },
  zip: {
    label: "ZIP",
    accentBorder: "border-amber-400/35",
    accentBg: "bg-amber-500/10",
    accentText: "text-amber-200",
    icon: FileArchive,
  },
  txt: {
    label: "TXT",
    accentBorder: "border-white/15",
    accentBg: "bg-white/[0.04]",
    accentText: "text-white/85",
    icon: FileText,
  },
  md: {
    label: "MD",
    accentBorder: "border-white/15",
    accentBg: "bg-white/[0.04]",
    accentText: "text-white/85",
    icon: FileText,
  },
  json: {
    label: "JSON",
    accentBorder: "border-white/15",
    accentBg: "bg-white/[0.04]",
    accentText: "text-white/85",
    icon: FileText,
  },
};

function getDocMeta(name: string) {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return (
    DOC_EXTENSION_META[ext] ?? {
      label: ext ? ext.toUpperCase() : "FILE",
      accentBorder: "border-amber-400/35",
      accentBg: "bg-amber-500/10",
      accentText: "text-amber-200",
      icon: FileText,
    }
  );
}

export function DocumentCard({ att }: { att: AttachmentPart }) {
  const meta = getDocMeta(att.name);
  const Icon = meta.icon;
  // PDFs render inline in the browser's PDF viewer — give "Preview" affordance
  // separate from "Open in new tab" so user expects what'll happen.
  const isPdf = meta.label === "PDF";

  const onDownload = () => downloadAttachment(att.displayUrl, att.name);
  const onOpen = () => openInNewTab(att.displayUrl);

  return (
    <motion.div
      whileHover={{ y: -1 }}
      className={cn(
        "group flex w-full max-w-md items-center gap-3 rounded-xl border bg-[#0B0E14]/80 px-3 py-2.5 transition hover:shadow-[0_12px_34px_-12px_rgba(0,0,0,0.45)]",
        meta.accentBorder,
      )}
    >
      {/* Big colored icon block */}
      <div
        className={cn(
          "flex size-12 shrink-0 items-center justify-center rounded-lg border",
          meta.accentBorder,
          meta.accentBg,
        )}
      >
        <Icon className={cn("size-6", meta.accentText)} />
      </div>
      {/* Filename + meta */}
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-white/95">
          {att.name}
        </p>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">
          {meta.label} · {prettyFileSize(att.sizeBytes)}
        </p>
      </div>
      {/* Actions */}
      <div className="flex shrink-0 items-center gap-1">
        <button
          type="button"
          onClick={onOpen}
          aria-label={isPdf ? "Pratinjau PDF" : "Buka di tab baru"}
          title={isPdf ? "Pratinjau PDF di tab baru" : "Buka di tab baru"}
          className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/65 transition hover:border-cyan-400/40 hover:text-cyan-200"
        >
          {isPdf ? <Eye className="size-3.5" /> : <ExternalLink className="size-3.5" />}
        </button>
        <button
          type="button"
          onClick={onDownload}
          aria-label="Download"
          title="Download"
          className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/65 transition hover:border-cyan-400/40 hover:text-cyan-200"
        >
          <Download className="size-3.5" />
        </button>
      </div>
    </motion.div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Shared fallback for unplayable audio / unrenderable video
// ─────────────────────────────────────────────────────────────────────

function FallbackDownloadCard({
  att,
  icon,
  accentBorder,
  kindLabel,
}: {
  att: AttachmentPart;
  icon: React.ReactNode;
  accentBorder: string;
  kindLabel: string;
}) {
  const onDownload = () => downloadAttachment(att.displayUrl, att.name);
  const onOpen = () => openInNewTab(att.displayUrl);
  return (
    <div
      className={cn(
        "flex w-full max-w-md items-center gap-3 rounded-xl border bg-[#0B0E14]/80 px-3 py-2",
        accentBorder,
      )}
    >
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04]">
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium text-white/90">
          {att.name}
        </p>
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/45">
          {kindLabel} · {prettyFileSize(att.sizeBytes)}
        </p>
      </div>
      <button
        type="button"
        onClick={onOpen}
        aria-label="Buka di tab baru"
        title="Buka di tab baru"
        className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/65 transition hover:border-cyan-400/40 hover:text-cyan-200"
      >
        <ExternalLink className="size-3.5" />
      </button>
      <button
        type="button"
        onClick={onDownload}
        aria-label="Download"
        title="Download"
        className="flex size-8 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/65 transition hover:border-cyan-400/40 hover:text-cyan-200"
      >
        <Download className="size-3.5" />
      </button>
    </div>
  );
}
