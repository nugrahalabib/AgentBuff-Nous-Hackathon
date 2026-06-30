"use client";

/**
 * Rich block renderers — full Telegram + Discord parity for non-text
 * message types:
 *   - PollCard      (Telegram poll/quiz)
 *   - DiceCard      (Telegram animated dice)
 *   - LocationCard  (Telegram location + venue)
 *   - ContactCard   (Telegram contact card / vCard)
 *   - StickerCard   (Telegram + Discord stickers)
 *   - EmbedCard     (Discord rich embed)
 *   - SelectCard    (Discord select dropdown)
 *   - ModalCard     (Discord modal dialog)
 *
 * All cards reuse the basecamp design tokens (cyan/amber/emerald accents,
 * #0B0E14 surface, mono labels) so they feel native to /app.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "framer-motion";
import {
  Dices,
  MapPin,
  Navigation,
  Phone,
  UserRound,
  Download,
  ExternalLink,
} from "lucide-react";
import type {
  PollBlock,
  DiceBlock,
  LocationBlock,
  ContactBlock,
  StickerBlock,
  EmbedBlock,
  SelectBlock,
  ModalBlock,
} from "@/lib/hermes/rpc-types";
import { cn } from "@/lib/utils";

// ── PollCard ────────────────────────────────────────────────────────────
export function PollCard({ block }: { block: PollBlock }) {
  // Defensive: agents/skills that emit rich blocks may produce malformed
  // payloads (missing options, missing question). Render a tiny fallback
  // pill instead of crashing the whole bubble — same pattern UnknownBlockPill
  // uses for entirely unknown block types.
  const options = Array.isArray(block.options) ? block.options : [];
  const question = (block.question || "").trim();
  const [myVote, setMyVote] = useState<number | number[] | undefined>(
    block.myVote,
  );
  if (options.length === 0 || !question) {
    return (
      <div className="inline-flex max-w-full items-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
        📊 polling rusak
      </div>
    );
  }
  const total =
    block.totalVoters ??
    options.reduce((sum, o) => sum + (o?.voteCount ?? 0), 0);

  const vote = useCallback(
    (idx: number) => {
      if (block.multipleAnswers) {
        const current = Array.isArray(myVote) ? myVote : [];
        setMyVote(
          current.includes(idx)
            ? current.filter((v) => v !== idx)
            : [...current, idx],
        );
      } else {
        setMyVote(idx);
      }
      // TODO: bridge poll.vote RPC (Iter 6 baseline ships UI; engine wire pending)
    },
    [block.multipleAnswers, myVote],
  );

  const isVoted = (idx: number) =>
    Array.isArray(myVote) ? myVote.includes(idx) : myVote === idx;

  return (
    <div className="w-full rounded-xl border border-cyan-400/30 bg-cyan-500/[0.05] p-3">
      <div className="mb-2 flex items-center gap-2">
        <span aria-hidden className="text-[14px]">
          {block.pollType === "quiz" ? "🎓" : "📊"}
        </span>
        <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-300/85">
          {block.pollType === "quiz" ? "Kuis" : "Polling"}
          {block.anonymous ? " · anonim" : ""}
          {block.multipleAnswers ? " · multi" : ""}
        </span>
      </div>
      <p className="mb-3 text-[13px] font-medium text-white/90">
        {question}
      </p>
      <div className="flex flex-col gap-1.5">
        {options.map((opt, idx) => {
          const count = opt?.voteCount ?? 0;
          const pct = total > 0 ? Math.round((count / total) * 100) : 0;
          const voted = isVoted(idx);
          const isCorrect =
            block.pollType === "quiz" && block.correctOption === idx;
          return (
            <button
              key={idx}
              type="button"
              onClick={() => vote(idx)}
              className={cn(
                "relative overflow-hidden rounded-md border px-3 py-2 text-left text-[12px] transition",
                voted
                  ? "border-cyan-400/55 bg-cyan-400/15 text-cyan-50"
                  : "border-white/10 bg-white/[0.04] text-white/85 hover:border-cyan-400/35 hover:bg-cyan-400/10",
                isCorrect && voted && "border-emerald-400/60 bg-emerald-400/15",
              )}
            >
              <div
                className="absolute inset-y-0 left-0 -z-0 bg-cyan-400/10 transition-all"
                style={{ width: `${pct}%` }}
              />
              <span className="relative z-10 flex items-center justify-between gap-2">
                <span className="flex-1">{opt?.text || `Opsi ${idx + 1}`}</span>
                {myVote !== undefined ? (
                  <span className="font-mono text-[11px] tabular-nums text-white/70">
                    {pct}% · {count}
                  </span>
                ) : null}
              </span>
            </button>
          );
        })}
      </div>
      {total > 0 ? (
        <p className="mt-2 font-mono text-[10px] uppercase tracking-[0.18em] text-white/40">
          {total} suara
        </p>
      ) : null}
    </div>
  );
}

// ── DiceCard ────────────────────────────────────────────────────────────
export function DiceCard({ block }: { block: DiceBlock }) {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setRevealed(true), 1200);
    return () => clearTimeout(t);
  }, []);
  return (
    <motion.div
      initial={{ rotate: 0 }}
      animate={
        revealed
          ? { rotate: [0, 360, 720, 1080], scale: [1, 1.2, 1.4, 1] }
          : { rotate: 0 }
      }
      transition={{ duration: 1.2, ease: "easeOut" }}
      className="inline-flex items-center gap-2 rounded-xl border border-amber-400/35 bg-amber-500/[0.08] px-4 py-3"
    >
      <span aria-hidden className="text-[36px] leading-none">
        {block.emoji}
      </span>
      {revealed ? (
        <div className="flex flex-col">
          <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-amber-300/85">
            {block.emoji === "🎲" ? "Dadu" : block.emoji === "🎯" ? "Panah" : "Hasil"}
          </span>
          <span className="text-[24px] font-bold tabular-nums text-amber-50">
            {block.value}
          </span>
        </div>
      ) : null}
    </motion.div>
  );
}

// ── LocationCard ────────────────────────────────────────────────────────
export function LocationCard({ block }: { block: LocationBlock }) {
  const mapsUrl = `https://www.google.com/maps?q=${block.latitude},${block.longitude}`;
  const osmUrl = `https://www.openstreetmap.org/?mlat=${block.latitude}&mlon=${block.longitude}&zoom=16`;
  const isLive = block.livePeriod && block.livePeriod > 0;
  return (
    <div className="overflow-hidden rounded-xl border border-emerald-400/30 bg-emerald-500/[0.06]">
      <a
        href={mapsUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="relative block aspect-video w-full max-w-md bg-[#0B0E14]"
        title="Buka di Google Maps"
      >
        <iframe
          src={`https://www.openstreetmap.org/export/embed.html?bbox=${block.longitude - 0.005}%2C${block.latitude - 0.005}%2C${block.longitude + 0.005}%2C${block.latitude + 0.005}&layer=mapnik&marker=${block.latitude}%2C${block.longitude}`}
          className="size-full"
          loading="lazy"
          title="Peta lokasi"
        />
        {isLive ? (
          <div className="absolute right-2 top-2 inline-flex items-center gap-1.5 rounded-full bg-red-500/90 px-2 py-0.5 text-[10px] font-bold uppercase text-white">
            <span className="size-1.5 animate-pulse rounded-full bg-white" />
            Live
          </div>
        ) : null}
      </a>
      <div className="flex items-start gap-2 px-3 py-2">
        <MapPin
          className="mt-0.5 size-4 shrink-0 text-emerald-300"
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          {block.title ? (
            <p className="truncate text-[13px] font-medium text-white/90">
              {block.title}
            </p>
          ) : null}
          {block.address ? (
            <p className="truncate text-[11.5px] text-white/65">
              {block.address}
            </p>
          ) : null}
          <p className="font-mono text-[10px] text-white/40">
            {block.latitude.toFixed(5)}, {block.longitude.toFixed(5)}
          </p>
        </div>
        <a
          href={mapsUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-label="Buka di Google Maps"
          className="shrink-0 rounded-md border border-white/10 bg-white/[0.04] p-1.5 text-white/65 hover:border-emerald-400/40 hover:text-emerald-200"
        >
          <Navigation className="size-3.5" />
        </a>
      </div>
    </div>
  );
}

// ── ContactCard ─────────────────────────────────────────────────────────
export function ContactCard({ block }: { block: ContactBlock }) {
  const fullName = `${block.firstName}${block.lastName ? " " + block.lastName : ""}`;
  const downloadVcf = useCallback(() => {
    const vcard =
      block.vcard ||
      `BEGIN:VCARD\nVERSION:3.0\nFN:${fullName}\nTEL;TYPE=CELL:${block.phoneNumber}\nEND:VCARD`;
    const blob = new Blob([vcard], { type: "text/vcard" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${fullName.replace(/\s+/g, "_")}.vcf`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [block.vcard, block.phoneNumber, fullName]);
  return (
    <div className="flex items-center gap-3 rounded-xl border border-cyan-400/30 bg-cyan-500/[0.05] px-3 py-2.5">
      <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-full border border-cyan-400/40 bg-cyan-400/15">
        {block.avatarUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={block.avatarUrl}
            alt={fullName}
            className="size-full object-cover"
          />
        ) : (
          <UserRound className="size-6 text-cyan-200" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium text-white/90">
          {fullName}
        </p>
        <a
          href={`tel:${block.phoneNumber}`}
          className="inline-flex items-center gap-1 text-[11.5px] text-cyan-200/85 hover:text-cyan-100"
        >
          <Phone className="size-3" />
          {block.phoneNumber}
        </a>
      </div>
      <button
        type="button"
        onClick={downloadVcf}
        aria-label="Simpan kontak"
        title="Download .vcf"
        className="shrink-0 rounded-md border border-white/10 bg-white/[0.04] p-1.5 text-white/65 hover:border-cyan-400/40 hover:text-cyan-200"
      >
        <Download className="size-3.5" />
      </button>
    </div>
  );
}

// ── StickerCard ─────────────────────────────────────────────────────────
export function StickerCard({ block }: { block: StickerBlock }) {
  return (
    <div className="inline-block">
      {block.kind === "video" ? (
        <video
          src={block.displayUrl}
          autoPlay
          loop
          muted
          playsInline
          className="max-w-[180px] rounded-md"
          width={block.width ?? 180}
          height={block.height ?? 180}
        />
      ) : (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={block.displayUrl}
          alt={block.emoji || block.setName || "Sticker"}
          className="max-w-[180px] rounded-md"
          loading="lazy"
        />
      )}
      {block.setName ? (
        <p className="mt-1 text-center font-mono text-[9.5px] uppercase tracking-[0.18em] text-white/40">
          {block.setName}
        </p>
      ) : null}
    </div>
  );
}

// ── EmbedCard (Discord rich embed) ─────────────────────────────────────
export function EmbedCard({ block }: { block: EmbedBlock }) {
  const accentColor = block.color || "#5865F2"; // Discord blurple default
  return (
    <div
      className="flex max-w-md gap-2 rounded-md bg-[#0B0E14]/70 px-3 py-2"
      style={{ borderLeft: `4px solid ${accentColor}` }}
    >
      <div className="min-w-0 flex-1">
        {block.authorName ? (
          <div className="mb-1 flex items-center gap-2">
            {block.authorIconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={block.authorIconUrl}
                alt=""
                className="size-5 rounded-full"
              />
            ) : null}
            {block.authorUrl ? (
              <a
                href={block.authorUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-[12px] font-medium text-white/85 hover:underline"
              >
                {block.authorName}
              </a>
            ) : (
              <span className="text-[12px] font-medium text-white/85">
                {block.authorName}
              </span>
            )}
          </div>
        ) : null}
        {block.title ? (
          block.url ? (
            <a
              href={block.url}
              target="_blank"
              rel="noopener noreferrer"
              className="mb-1 block text-[14px] font-semibold text-cyan-200 hover:underline"
            >
              {block.title}
            </a>
          ) : (
            <p className="mb-1 text-[14px] font-semibold text-white/95">
              {block.title}
            </p>
          )
        ) : null}
        {block.description ? (
          <p className="mb-2 whitespace-pre-wrap text-[12.5px] text-white/80">
            {block.description}
          </p>
        ) : null}
        {block.fields && block.fields.length > 0 ? (
          <div className="mb-2 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {block.fields.map((f, i) => (
              <div
                key={i}
                className={cn(
                  "rounded border border-white/[0.06] bg-white/[0.02] px-2 py-1",
                  !f.inline && "col-span-full",
                )}
              >
                <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-white/55">
                  {f.name}
                </p>
                <p className="whitespace-pre-wrap text-[11.5px] text-white/85">
                  {f.value}
                </p>
              </div>
            ))}
          </div>
        ) : null}
        {block.imageUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={block.imageUrl}
            alt={block.title || "Embed image"}
            className="mb-2 max-h-64 max-w-full rounded"
            loading="lazy"
          />
        ) : null}
        {(block.footerText || block.timestamp) ? (
          <div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-white/45">
            {block.footerIconUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={block.footerIconUrl}
                alt=""
                className="size-3.5 rounded-full"
              />
            ) : null}
            {block.footerText ? <span>{block.footerText}</span> : null}
            {block.footerText && block.timestamp ? (
              <span aria-hidden>·</span>
            ) : null}
            {block.timestamp ? (
              <span>{new Date(block.timestamp).toLocaleString("id-ID")}</span>
            ) : null}
          </div>
        ) : null}
      </div>
      {block.thumbnailUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={block.thumbnailUrl}
          alt=""
          className="size-20 shrink-0 rounded object-cover"
          loading="lazy"
        />
      ) : null}
    </div>
  );
}

// ── SelectCard (Discord select dropdown) ───────────────────────────────
export function SelectCard({ block }: { block: SelectBlock }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(block.resolved);
  const multi = block.multi === true;
  const maxValues = block.maxValues ?? (multi ? block.options.length : 1);
  const minValues = block.minValues ?? 1;

  const handleToggle = useCallback(
    (value: string) => {
      setSelected((cur) => {
        if (cur.includes(value)) return cur.filter((v) => v !== value);
        if (!multi) return [value];
        if (cur.length >= maxValues) return cur;
        return [...cur, value];
      });
    },
    [multi, maxValues],
  );

  const handleSubmit = useCallback(() => {
    if (selected.length < minValues) return;
    setSubmitted({ selected, by: "Chief", at: Date.now() });
    // TODO: bridge select.respond RPC
  }, [selected, minValues]);

  if (submitted) {
    const labels = submitted.selected.map(
      (v) => block.options.find((o) => o.value === v)?.label ?? v,
    );
    return (
      <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/[0.04] px-3 py-2">
        <p className="text-[12.5px] text-white/85">
          <span aria-hidden>✅ </span>
          Pilihan: {labels.join(", ")}
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-cyan-400/35 bg-cyan-500/[0.05] p-3">
      <p className="mb-2 text-[13px] font-medium text-cyan-50">
        {block.question}
      </p>
      <div className="flex flex-col gap-1.5">
        {block.options.map((opt) => {
          const isSelected = selected.includes(opt.value);
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => handleToggle(opt.value)}
              className={cn(
                "flex items-start gap-2 rounded-md border px-3 py-2 text-left text-[12px] transition",
                isSelected
                  ? "border-cyan-400/60 bg-cyan-400/15 text-cyan-50"
                  : "border-white/10 bg-white/[0.04] text-white/85 hover:border-cyan-400/40 hover:bg-cyan-400/10",
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-0.5 inline-block size-3 shrink-0 rounded-sm border",
                  multi ? "" : "rounded-full",
                  isSelected
                    ? "border-cyan-400 bg-cyan-400"
                    : "border-white/30",
                )}
              />
              <div className="flex-1">
                <p className="text-[12px]">{opt.label}</p>
                {opt.description ? (
                  <p className="mt-0.5 text-[10.5px] text-white/55">
                    {opt.description}
                  </p>
                ) : null}
              </div>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        onClick={handleSubmit}
        disabled={selected.length < minValues}
        className="mt-3 w-full rounded-md border border-cyan-400/50 bg-cyan-400/15 px-3 py-2 text-[12px] font-medium text-cyan-100 transition hover:bg-cyan-400/25 disabled:cursor-not-allowed disabled:opacity-50"
      >
        Kirim pilihan ({selected.length}
        {multi && maxValues > 1 ? `/${maxValues}` : ""})
      </button>
    </div>
  );
}

// ── ModalCard (Discord modal dialog) ───────────────────────────────────
export function ModalCard({ block }: { block: ModalBlock }) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const inp of block.inputs) init[inp.customId] = inp.value ?? "";
    return init;
  });
  const [submitted, setSubmitted] = useState(block.resolved);

  const handleSubmit = useCallback(() => {
    for (const inp of block.inputs) {
      if (inp.required && !values[inp.customId]?.trim()) return;
    }
    setSubmitted({ values, by: "Chief", at: Date.now() });
    // TODO: bridge modal.respond RPC
  }, [block.inputs, values]);

  if (submitted) {
    return (
      <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/[0.04] px-3 py-2">
        <p className="mb-1 text-[12.5px] font-medium text-cyan-50">
          ✅ {block.title}
        </p>
        {Object.entries(submitted.values).map(([key, val]) => {
          const inp = block.inputs.find((i) => i.customId === key);
          return (
            <p key={key} className="text-[11px] text-white/75">
              <span className="font-mono text-white/55">{inp?.label ?? key}:</span>{" "}
              {val}
            </p>
          );
        })}
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-cyan-400/35 bg-cyan-500/[0.05] p-3">
      <p className="mb-3 text-[13px] font-semibold text-cyan-50">
        {block.title}
      </p>
      <div className="flex flex-col gap-3">
        {block.inputs.map((inp) => (
          <div key={inp.customId}>
            <label
              htmlFor={`modal-${block.requestId}-${inp.customId}`}
              className="mb-1 block font-mono text-[10px] uppercase tracking-[0.18em] text-cyan-300/85"
            >
              {inp.label}
              {inp.required ? " *" : ""}
            </label>
            {inp.style === "paragraph" ? (
              <textarea
                id={`modal-${block.requestId}-${inp.customId}`}
                value={values[inp.customId] ?? ""}
                onChange={(e) =>
                  setValues((s) => ({
                    ...s,
                    [inp.customId]: e.target.value,
                  }))
                }
                placeholder={inp.placeholder}
                minLength={inp.minLength}
                maxLength={inp.maxLength}
                rows={4}
                className="w-full resize-none rounded-md border border-cyan-400/30 bg-[#0B0E14]/80 px-2 py-1.5 text-[12px] text-white/95 placeholder:text-white/35 focus:border-cyan-400 focus:outline-none"
              />
            ) : (
              <input
                id={`modal-${block.requestId}-${inp.customId}`}
                type="text"
                value={values[inp.customId] ?? ""}
                onChange={(e) =>
                  setValues((s) => ({
                    ...s,
                    [inp.customId]: e.target.value,
                  }))
                }
                placeholder={inp.placeholder}
                minLength={inp.minLength}
                maxLength={inp.maxLength}
                className="w-full rounded-md border border-cyan-400/30 bg-[#0B0E14]/80 px-2 py-1.5 text-[12px] text-white/95 placeholder:text-white/35 focus:border-cyan-400 focus:outline-none"
              />
            )}
          </div>
        ))}
      </div>
      <button
        type="button"
        onClick={handleSubmit}
        className="mt-3 w-full rounded-md border border-cyan-400/50 bg-cyan-400/15 px-3 py-2 text-[12px] font-medium text-cyan-100 transition hover:bg-cyan-400/25"
      >
        Kirim
      </button>
    </div>
  );
}
