"use client";

/**
 * Full-screen lightbox modal for image + video attachments.
 *
 * Image features:
 *   * Zoom in / out / reset via toolbar buttons
 *   * Pan when zoomed (drag with mouse / touch)
 *   * Multi-image carousel — left/right arrows + keyboard ← → keys
 *   * Thumbnail strip at bottom when >1 image
 *   * Download + open-in-new-tab in toolbar
 *
 * Video features:
 *   * Native `<video>` element with native controls (Chrome's video
 *     controls work fine, unlike audio).
 *   * Fullscreen-style modal at 90% viewport
 *   * Download + open-in-new-tab in toolbar
 *
 * Common:
 *   * Backdrop click / Esc → close
 *   * Body scroll lock while open
 *   * Framer Motion enter/exit animations
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  ExternalLink,
  Maximize,
  X,
  ZoomIn,
  ZoomOut,
  ChevronLeft,
  ChevronRight,
} from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { AttachmentPart } from "@/lib/app/attachments";
import { prettyFileSize } from "@/lib/app/attachments";
import { cn } from "@/lib/utils";
import {
  downloadAttachment,
  openInNewTab,
} from "@/lib/app/attachment-actions";

export type LightboxItem = AttachmentPart;

type Props = {
  /** Single item OR a list (for carousel). null = closed. */
  items: LightboxItem[] | null;
  /** Index of currently-shown item in `items`. */
  startIndex?: number;
  onClose: () => void;
};

export function AttachmentLightbox({ items, startIndex = 0, onClose }: Props) {
  const [index, setIndex] = useState(startIndex);
  const panelRef = useRef<HTMLDivElement | null>(null);

  // Only reset index when startIndex itself changes — not on every items
  // identity change (which can happen on parent re-render even when the
  // selection didn't move).
  useEffect(() => {
    setIndex(startIndex);
  }, [startIndex]);

  const open = !!items && items.length > 0;
  const itemsLen = items?.length ?? 0;

  // Body scroll lock + keyboard nav + a11y focus management (A11Y-1). Tied to
  // `open` so we only attach listeners while visible.
  useEffect(() => {
    if (!open) return;
    // Capture the trigger so we can restore focus to it on close.
    const opener = document.activeElement as HTMLElement | null;
    const panel = panelRef.current;
    panel?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (e.key === "ArrowLeft") {
        setIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (e.key === "ArrowRight") {
        setIndex((i) => Math.min(itemsLen - 1, i + 1));
        return;
      }
      // Trap Tab focus inside the dialog (WCAG 2.4.3 / 2.1.2).
      if (e.key !== "Tab" || !panel) return;
      const f = panel.querySelectorAll<HTMLElement>(
        'a[href],button:not([disabled]),textarea,input,select,[tabindex]:not([tabindex="-1"])',
      );
      if (f.length === 0) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      // Restore focus to the trigger if it's still in the DOM.
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [open, itemsLen, onClose]);

  // Always render <AnimatePresence>; toggle the inner motion.div via the
  // `open` flag so the exit animation actually runs. (When the wrapper
  // itself is conditionally rendered, AnimatePresence has nothing to
  // animate-out from.)
  const current = items?.[index] ?? null;
  const isImage = current?.kind === "image";
  const isVideo = current?.kind === "video";

  const handlePrev = () => setIndex((i) => Math.max(0, i - 1));
  const handleNext = () =>
    setIndex((i) => Math.min((items?.length ?? 1) - 1, i + 1));

  return (
    <AnimatePresence>
      {open && current ? (
      <motion.div
        key="lightbox-backdrop"
        ref={panelRef}
        role="dialog"
        aria-modal
        aria-label={`Pratinjau ${current.name}`}
        tabIndex={-1}
        onClick={onClose}
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        className="fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black/85 backdrop-blur-md"
      >
        {/* Top toolbar: filename + actions + close */}
        <div
          onClick={(e) => e.stopPropagation()}
          className="absolute inset-x-0 top-0 z-10 flex items-center justify-between gap-3 border-b border-white/10 bg-black/60 px-4 py-3 backdrop-blur-md"
        >
          <div className="flex min-w-0 flex-col">
            <p className="truncate text-sm font-medium text-white">
              {current.name}
            </p>
            <p className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
              {current.kind}
              {current.sizeBytes ? ` · ${prettyFileSize(current.sizeBytes)}` : ""}
              {items.length > 1 ? ` · ${index + 1} / ${items.length}` : ""}
            </p>
          </div>
          <div className="flex items-center gap-1">
            <ToolbarButton
              onClick={() => openInNewTab(current.displayUrl)}
              ariaLabel="Buka di tab baru"
              title="Buka di tab baru"
            >
              <ExternalLink className="size-4" />
            </ToolbarButton>
            <ToolbarButton
              onClick={() => downloadAttachment(current.displayUrl, current.name)}
              ariaLabel="Download"
              title="Download"
            >
              <Download className="size-4" />
            </ToolbarButton>
            <ToolbarButton onClick={onClose} ariaLabel="Tutup" title="Tutup (Esc)">
              <X className="size-4" />
            </ToolbarButton>
          </div>
        </div>

        {/* Main viewer */}
        <div
          className="relative flex h-full w-full items-center justify-center px-4 pb-24 pt-20"
          onClick={(e) => e.stopPropagation()}
        >
          {isImage ? (
            <ImagePanel
              key={current.displayUrl}
              src={current.displayUrl}
              alt={current.name}
            />
          ) : isVideo ? (
            <VideoPanel
              key={current.displayUrl}
              src={current.displayUrl}
              poster={undefined}
            />
          ) : (
            // Document fallback — show big icon + name. Lightbox is mainly
            // for visual media; documents typically open in a new tab.
            <div className="flex flex-col items-center gap-4 text-center text-white/80">
              <Maximize className="size-12 text-white/40" />
              <p className="text-sm font-medium">{current.name}</p>
              <p className="text-xs text-white/55">
                Dokumen ini akan terbuka di tab baru — klik "Buka di tab baru"
                atau "Download" di toolbar.
              </p>
            </div>
          )}

          {/* Carousel nav arrows (only when >1 item) */}
          {items.length > 1 ? (
            <>
              <button
                type="button"
                onClick={handlePrev}
                disabled={index === 0}
                aria-label="Sebelumnya"
                className={cn(
                  "absolute left-4 top-1/2 -translate-y-1/2 rounded-full border border-white/15 bg-black/60 p-2 text-white transition",
                  index === 0
                    ? "cursor-not-allowed opacity-30"
                    : "hover:bg-black/80",
                )}
              >
                <ChevronLeft className="size-5" />
              </button>
              <button
                type="button"
                onClick={handleNext}
                disabled={index === items.length - 1}
                aria-label="Berikutnya"
                className={cn(
                  "absolute right-4 top-1/2 -translate-y-1/2 rounded-full border border-white/15 bg-black/60 p-2 text-white transition",
                  index === items.length - 1
                    ? "cursor-not-allowed opacity-30"
                    : "hover:bg-black/80",
                )}
              >
                <ChevronRight className="size-5" />
              </button>
            </>
          ) : null}
        </div>

        {/* Bottom thumbnail strip (only for multi-image) */}
        {items.length > 1 && isImage ? (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute inset-x-0 bottom-0 flex justify-center gap-2 border-t border-white/10 bg-black/60 px-4 py-3 backdrop-blur-md"
          >
            {items.map((item, i) => (
              <button
                key={`${item.name}-${i}`}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Pilih ${item.name}`}
                className={cn(
                  "size-14 shrink-0 overflow-hidden rounded border-2 transition",
                  i === index
                    ? "border-cyan-400 shadow-[0_0_12px_rgba(34,211,238,0.55)]"
                    : "border-white/15 opacity-70 hover:opacity-100",
                )}
              >
                {item.kind === "image" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={item.displayUrl}
                    alt={item.name}
                    className="size-full object-cover"
                    loading="lazy"
                  />
                ) : (
                  <div className="flex size-full items-center justify-center bg-white/[0.06] text-white/40">
                    <Maximize className="size-4" />
                  </div>
                )}
              </button>
            ))}
          </div>
        ) : null}
      </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function ToolbarButton({
  children,
  onClick,
  ariaLabel,
  title,
}: {
  children: React.ReactNode;
  onClick: () => void;
  ariaLabel: string;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={ariaLabel}
      title={title}
      className="flex size-9 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] text-white/75 transition hover:border-cyan-400/40 hover:bg-cyan-400/15 hover:text-cyan-100"
    >
      {children}
    </button>
  );
}

/** Image viewer with zoom + pan. Zoom levels: 1x, 1.5x, 2x, 3x, 4x. */
function ImagePanel({ src, alt }: { src: string; alt: string }) {
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragging = useRef(false);
  const lastPoint = useRef<{ x: number; y: number } | null>(null);
  const [errored, setErrored] = useState(false);

  const zoomIn = useCallback(() => {
    setZoom((z) => Math.min(4, z + 0.5));
  }, []);
  const zoomOut = useCallback(() => {
    setZoom((z) => {
      const next = Math.max(1, z - 0.5);
      if (next === 1) setPan({ x: 0, y: 0 });
      return next;
    });
  }, []);
  const resetZoom = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const onPointerDown = (e: React.PointerEvent) => {
    if (zoom <= 1) return;
    dragging.current = true;
    lastPoint.current = { x: e.clientX, y: e.clientY };
    try {
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    } catch {
      // setPointerCapture can throw if the pointer was released before
      // capture (touch flick on iOS Safari) — degrade gracefully.
    }
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (!dragging.current || !lastPoint.current) return;
    const dx = e.clientX - lastPoint.current.x;
    const dy = e.clientY - lastPoint.current.y;
    lastPoint.current = { x: e.clientX, y: e.clientY };
    setPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    const wasDragging = dragging.current;
    dragging.current = false;
    lastPoint.current = null;
    if (!wasDragging) return; // no capture was set, skip release
    try {
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      // Pointer already released by browser — ignore.
    }
  };

  // Mouse wheel zoom (desktop only — passive listener so it doesn't block scroll
  // outside the image).
  const onWheel = (e: React.WheelEvent) => {
    if (e.deltaY < 0) {
      zoomIn();
    } else if (e.deltaY > 0) {
      zoomOut();
    }
  };

  if (errored) {
    return (
      <div className="flex flex-col items-center gap-3 text-white/70">
        <span aria-hidden className="text-4xl">🖼️</span>
        <p className="text-sm">Gambar tidak bisa dimuat</p>
      </div>
    );
  }

  return (
    <div className="relative flex h-full w-full items-center justify-center overflow-hidden">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt}
        draggable={false}
        onError={() => setErrored(true)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onWheel={onWheel}
        onDoubleClick={() => (zoom === 1 ? setZoom(2) : resetZoom())}
        style={{
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
          transition: dragging.current ? "none" : "transform 0.15s ease",
          cursor:
            zoom > 1 ? (dragging.current ? "grabbing" : "grab") : "zoom-in",
        }}
        className="max-h-full max-w-full select-none rounded-lg object-contain"
      />

      {/* Zoom controls — bottom center */}
      <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-1 rounded-full border border-white/10 bg-black/70 px-2 py-1 backdrop-blur-md">
        <button
          type="button"
          onClick={zoomOut}
          disabled={zoom <= 1}
          aria-label="Zoom out"
          className={cn(
            "rounded-full p-1.5 transition",
            zoom <= 1
              ? "cursor-not-allowed text-white/25"
              : "text-white/75 hover:bg-white/10 hover:text-white",
          )}
        >
          <ZoomOut className="size-4" />
        </button>
        <button
          type="button"
          onClick={resetZoom}
          aria-label="Reset zoom"
          className="px-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/70 hover:text-white"
        >
          {Math.round(zoom * 100)}%
        </button>
        <button
          type="button"
          onClick={zoomIn}
          disabled={zoom >= 4}
          aria-label="Zoom in"
          className={cn(
            "rounded-full p-1.5 transition",
            zoom >= 4
              ? "cursor-not-allowed text-white/25"
              : "text-white/75 hover:bg-white/10 hover:text-white",
          )}
        >
          <ZoomIn className="size-4" />
        </button>
      </div>
    </div>
  );
}

/** Video viewer — wraps native `<video>` with controls. Browser's built-in
 *  video player handles fullscreen, PiP, seek, volume natively. */
function VideoPanel({ src, poster }: { src: string; poster?: string }) {
  const [errored, setErrored] = useState(false);
  if (errored) {
    return (
      <div className="flex flex-col items-center gap-3 text-white/70">
        <span aria-hidden className="text-4xl">🎬</span>
        <p className="text-sm">Video tidak bisa dimuat di browser ini</p>
        <p className="text-xs text-white/45">
          Klik &quot;Download&quot; di toolbar untuk menyimpan file.
        </p>
      </div>
    );
  }
  return (
    <video
      src={src}
      poster={poster}
      controls
      controlsList="nodownload"
      preload="metadata"
      onError={() => setErrored(true)}
      className="max-h-full max-w-full rounded-lg bg-black"
      // eslint-disable-next-line jsx-a11y/media-has-caption
    >
      Browser ini tidak mendukung tag video.
    </video>
  );
}
