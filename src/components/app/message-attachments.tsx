"use client";

/**
 * MessageAttachments — render every kind of attachment attached to a chat
 * message in the most natural, action-rich way possible.
 *
 * Layout strategy:
 *   * Images get a Telegram-style photo grid (single = wide, 2+ = 2-col).
 *   * Audio shows a Telegram/WhatsApp-style custom player.
 *   * Video shows an inline poster with a center play overlay — click
 *     expands to a fullscreen player in the shared lightbox.
 *   * Documents (PDF/DOCX/XLSX/PPTX/zip/...) get a typed card with
 *     kind-colored icon + open + download buttons.
 *
 * The shared `AttachmentLightbox` modal handles full-screen preview
 * (image zoom/pan + multi-image carousel; native video controls).
 * Triggered from clicks on ImageCard + VideoCard.
 */

import { useCallback, useMemo, useState } from "react";
import type { AttachmentPart } from "@/lib/app/attachments";
import {
  AudioCard,
  DocumentCard,
  ImageCard,
  VideoCard,
} from "./attachment-cards";
import { AttachmentLightbox } from "./attachment-lightbox";
import { cn } from "@/lib/utils";

export function MessageAttachments({
  attachments,
  align = "end",
}: {
  attachments: AttachmentPart[];
  /** "end" (user bubble, right-aligned) vs "start" (bot bubble, left). */
  align?: "start" | "end";
}) {
  // Index of the item currently open in the lightbox, or null when closed.
  // We share ONE lightbox between image + video clicks — saves DOM and
  // gives consistent keyboard nav across kinds.
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // Only image + video items go through the lightbox carousel. Documents
  // open in new tab; audio plays inline.
  const lightboxItems = useMemo(
    () =>
      (attachments ?? []).filter(
        (a) => a.kind === "image" || a.kind === "video",
      ),
    [attachments],
  );

  const openLightboxFor = useCallback(
    (att: AttachmentPart) => {
      const idx = lightboxItems.findIndex(
        (item) => item.displayUrl === att.displayUrl && item.name === att.name,
      );
      setLightboxIndex(idx >= 0 ? idx : 0);
    },
    [lightboxItems],
  );

  const closeLightbox = useCallback(() => setLightboxIndex(null), []);

  if (!attachments || attachments.length === 0) return null;

  // Split by kind for layout. Images get the photo-grid treatment, every
  // other kind gets stacked in a column below.
  const imageItems = attachments.filter((a) => a.kind === "image");
  const audioItems = attachments.filter((a) => a.kind === "audio");
  const videoItems = attachments.filter((a) => a.kind === "video");
  const documentItems = attachments.filter((a) => a.kind === "document");

  const isSingleImage = imageItems.length === 1;

  return (
    <>
      {/* Image grid — Telegram-style: single = full-width-ish card, 2+ = 2-col. */}
      {imageItems.length > 0 ? (
        <div
          className={cn(
            "flex gap-2",
            align === "end" ? "justify-end" : "justify-start",
            isSingleImage
              ? "flex-wrap"
              : "grid grid-cols-2 gap-2 sm:max-w-md",
          )}
          aria-label="Lampiran gambar"
        >
          {imageItems.map((att, idx) => (
            <ImageCard
              key={`${att.name}-${idx}`}
              att={att}
              size={isSingleImage ? "default" : "grid"}
              onClickPreview={() => openLightboxFor(att)}
            />
          ))}
        </div>
      ) : null}

      {/* Stack non-image attachments below the image grid (or above the
          textarea echo when no images). align controls L/R bias. */}
      {audioItems.length + videoItems.length + documentItems.length > 0 ? (
        <div
          className={cn(
            "flex flex-col gap-2",
            align === "end" ? "items-end" : "items-start",
          )}
          aria-label="Lampiran"
        >
          {audioItems.map((att, idx) => (
            <AudioCard key={`${att.name}-${idx}`} att={att} />
          ))}
          {videoItems.map((att, idx) => (
            <VideoCard
              key={`${att.name}-${idx}`}
              att={att}
              onClickPreview={() => openLightboxFor(att)}
            />
          ))}
          {documentItems.map((att, idx) => (
            <DocumentCard key={`${att.name}-${idx}`} att={att} />
          ))}
        </div>
      ) : null}

      {/* Shared lightbox — kept mounted so the AnimatePresence exit
          animation can play when chief closes it. The lightbox itself
          toggles visibility based on the `items` prop being non-empty
          (we pass null when closed). */}
      <AttachmentLightbox
        items={lightboxIndex !== null ? lightboxItems : null}
        startIndex={lightboxIndex ?? 0}
        onClose={closeLightbox}
      />
    </>
  );
}
