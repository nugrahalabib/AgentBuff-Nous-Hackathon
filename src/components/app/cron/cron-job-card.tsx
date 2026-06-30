"use client";

/**
 * CronJobCard — single rutinitas row dengan:
 *  - Schedule humanized + payload kind + next-run + last-run + delivery
 *  - Action buttons: Run now, Toggle pause, Edit, History, Delete (2-click)
 *  - Status badge (Aktif/Pause/Running/Error)
 *  - Subtle pulse animation kalau job lagi running
 */
import { motion } from "framer-motion";
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  CircleDashed,
  History,
  Loader2,
  Pause,
  Pencil,
  Play,
  Power,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  type CronJob,
  cleanEngineError,
  formatNextRun,
  formatRelativePast,
  humanizeDelivery,
  humanizePayload,
  humanizeSchedule,
  statusLabel,
  statusTone,
} from "./helpers";

export function CronJobCard({
  job,
  busy,
  busyKind,
  onRun,
  onToggle,
  onEdit,
  onHistory,
  onDelete,
  now,
  agentLabel,
}: {
  job: CronJob;
  busy: boolean;
  /** Which action is in-flight, used to render local spinner per button. */
  busyKind: "run" | "toggle" | "delete" | "edit" | null;
  onRun: () => void;
  onToggle: () => void;
  onEdit: () => void;
  onHistory: () => void;
  onDelete: () => void;
  now: number;
  /** Resolved agent display name for job.agentId (e.g. "Buff"). Falls back to
   *  the raw id when the agents list hasn't resolved or the agent is unknown. */
  agentLabel?: string;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const isRunning = !!job.state.runningAtMs;
  const lastStatus = job.state.lastRunStatus;
  const hasError =
    lastStatus === "error" || (job.state.consecutiveErrors ?? 0) > 0;
  const sched = humanizeSchedule(job.schedule);
  const payload = humanizePayload(job.payload);
  const delivery = humanizeDelivery(job.delivery);

  return (
    <motion.article
      layout
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      className={cn(
        "group relative overflow-hidden rounded-2xl border bg-white/[0.02] p-4 backdrop-blur-md transition",
        job.enabled
          ? "border-white/[0.08] hover:border-cyan-400/30 hover:bg-white/[0.04]"
          : "border-white/[0.04] opacity-65 hover:opacity-100",
        isRunning && "border-cyan-400/40 shadow-[0_0_24px_-4px_rgba(34,211,238,0.35)]",
      )}
    >
      {/* Running pulse rail */}
      {isRunning ? (
        <motion.div
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-cyan-400 via-indigo-400 to-fuchsia-500"
          animate={{ opacity: [0.6, 1, 0.6] }}
          transition={{ duration: 1.4, repeat: Infinity }}
        />
      ) : null}

      <div className="flex items-start gap-3">
        <Glyph emoji={emojiForKind(job.schedule.kind)} tone={hasError ? "red" : "cyan"} />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <h3 className="truncate text-[14px] font-semibold text-white/95">
              {job.name}
            </h3>
            <StatusBadge
              enabled={job.enabled}
              isRunning={isRunning}
              hasError={hasError}
            />
            {job.deleteAfterRun ? (
              <span className="inline-flex items-center rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0 font-mono text-[9px] uppercase tracking-[0.16em] text-amber-100">
                Sekali pakai
              </span>
            ) : null}
            {job.agentId ? (
              <span
                title={`Agen: ${agentLabel ?? job.agentId}`}
                className="inline-flex max-w-[160px] items-center gap-1 truncate rounded-full border border-cyan-400/25 bg-cyan-400/[0.06] px-1.5 py-0 font-mono text-[9px] uppercase tracking-[0.16em] text-cyan-200"
              >
                <span className="text-cyan-300/60" aria-hidden>
                  agen
                </span>
                <span className="truncate normal-case">
                  {agentLabel ?? job.agentId}
                </span>
              </span>
            ) : null}
          </div>

          {job.description ? (
            <p className="mt-0.5 truncate text-[11px] text-white/55">
              {job.description}
            </p>
          ) : null}

          <div className="mt-2 grid gap-1.5 sm:grid-cols-2">
            <DetailRow label="Jadwal" value={sched} />
            <DetailRow label={payload.kindLabel} value={payload.summary} />
            <DetailRow label="Lari berikutnya" value={formatNextRun(job.state.nextRunAtMs, now)} />
            <DetailRow
              label="Terakhir"
              value={
                job.state.lastRunAtMs
                  ? `${formatRelativePast(now - job.state.lastRunAtMs)} lalu (${statusLabel(lastStatus)})`
                  : "Belum pernah"
              }
              statusTone={lastStatus ? statusTone(lastStatus) : undefined}
            />
            <DetailRow label="Kirim ke" value={delivery} className="sm:col-span-2" />
          </div>

          {hasError && job.state.lastError ? (
            <div className="mt-2 flex items-start gap-1.5 rounded-lg border border-red-500/30 bg-red-500/[0.05] px-2.5 py-1.5 text-[11px] text-red-100">
              <AlertCircle className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span className="truncate">{cleanEngineError(job.state.lastError)}</span>
            </div>
          ) : null}
        </div>

        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <ActionRow>
            <IconBtn
              tone="cyan"
              onClick={onRun}
              disabled={busy}
              icon={busy && busyKind === "run" ? Loader2 : Play}
              label="Jalanin sekarang"
              spinIcon={busy && busyKind === "run"}
            />
            <IconBtn
              tone={job.enabled ? "amber" : "emerald"}
              onClick={onToggle}
              disabled={busy}
              icon={busy && busyKind === "toggle" ? Loader2 : job.enabled ? Pause : Power}
              label={job.enabled ? "Pause" : "Aktifkan"}
              spinIcon={busy && busyKind === "toggle"}
            />
          </ActionRow>
          <ActionRow>
            <IconBtn
              tone="white"
              onClick={onEdit}
              disabled={busy}
              icon={Pencil}
              label="Edit"
            />
            <IconBtn
              tone="white"
              onClick={onHistory}
              disabled={busy}
              icon={History}
              label="Riwayat"
            />
            {confirmDelete ? (
              <div className="inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/15 px-1.5 py-1">
                <button
                  type="button"
                  onClick={() => {
                    setConfirmDelete(false);
                    onDelete();
                  }}
                  disabled={busy}
                  className="inline-flex items-center gap-1 rounded-md bg-red-500 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white hover:brightness-110 disabled:opacity-50"
                >
                  {busy && busyKind === "delete" ? (
                    <Loader2 className="size-3 animate-spin" aria-hidden />
                  ) : (
                    <CheckCircle2 className="size-3" aria-hidden />
                  )}
                  Hapus
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                  className="rounded-md border border-white/15 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-white/70 hover:text-white"
                >
                  Batal
                </button>
              </div>
            ) : (
              <IconBtn
                tone="red"
                onClick={() => setConfirmDelete(true)}
                disabled={busy}
                icon={Trash2}
                label="Hapus"
              />
            )}
          </ActionRow>
        </div>
      </div>
    </motion.article>
  );
}

function emojiForKind(kind: "at" | "every" | "cron"): string {
  if (kind === "at") return "⚡";
  if (kind === "every") return "🔄";
  return "📅";
}

function Glyph({
  emoji,
  tone,
}: {
  emoji: string;
  tone: "cyan" | "red";
}) {
  const cls =
    tone === "red"
      ? "border-red-500/30 bg-red-500/10"
      : "border-cyan-400/25 bg-cyan-400/10";
  return (
    <div
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl border text-base",
        cls,
      )}
    >
      <span aria-hidden>{emoji}</span>
    </div>
  );
}

function StatusBadge({
  enabled,
  isRunning,
  hasError,
}: {
  enabled: boolean;
  isRunning: boolean;
  hasError: boolean;
}) {
  if (isRunning) {
    return (
      <Badge tone="cyan">
        <CircleDashed className="size-2.5 animate-spin" aria-hidden />
        Berjalan
      </Badge>
    );
  }
  if (!enabled) {
    return (
      <Badge tone="slate">
        <Pause className="size-2.5" aria-hidden />
        Pause
      </Badge>
    );
  }
  if (hasError) {
    return (
      <Badge tone="red">
        <AlertCircle className="size-2.5" aria-hidden />
        Error
      </Badge>
    );
  }
  return (
    <Badge tone="emerald">
      <Power className="size-2.5" aria-hidden />
      Aktif
    </Badge>
  );
}

function Badge({
  tone,
  children,
}: {
  tone: "cyan" | "emerald" | "red" | "slate";
  children: React.ReactNode;
}) {
  const cls =
    tone === "cyan"
      ? "border-cyan-400/40 bg-cyan-400/10 text-cyan-100"
      : tone === "emerald"
        ? "border-emerald-400/40 bg-emerald-400/10 text-emerald-100"
        : tone === "red"
          ? "border-red-500/40 bg-red-500/10 text-red-100"
          : "border-white/15 bg-white/[0.04] text-white/70";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-0 font-mono text-[9px] font-bold uppercase tracking-[0.16em]",
        cls,
      )}
    >
      {children}
    </span>
  );
}

function DetailRow({
  label,
  value,
  className,
  statusTone,
}: {
  label: string;
  value: string;
  className?: string;
  statusTone?: "emerald" | "red" | "amber";
}) {
  const valueColor =
    statusTone === "emerald"
      ? "text-emerald-100"
      : statusTone === "red"
        ? "text-red-200"
        : statusTone === "amber"
          ? "text-amber-200"
          : "text-white/85";
  return (
    <div className={cn("flex min-w-0 items-baseline gap-2", className)}>
      <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.18em] text-white/45">
        {label}
      </span>
      <span className={cn("truncate text-[11px]", valueColor)}>{value}</span>
    </div>
  );
}

function ActionRow({ children }: { children: React.ReactNode }) {
  return <div className="flex items-center gap-1">{children}</div>;
}

function IconBtn({
  tone,
  onClick,
  disabled,
  icon: Icon,
  label,
  spinIcon,
}: {
  tone: "cyan" | "amber" | "emerald" | "red" | "white";
  onClick: () => void;
  disabled: boolean;
  icon: typeof Play;
  label: string;
  spinIcon?: boolean;
}) {
  const cls =
    tone === "cyan"
      ? "border-cyan-400/30 bg-cyan-400/10 text-cyan-100 hover:bg-cyan-400/20"
      : tone === "amber"
        ? "border-amber-400/30 bg-amber-400/10 text-amber-100 hover:bg-amber-400/20"
        : tone === "emerald"
          ? "border-emerald-400/30 bg-emerald-400/10 text-emerald-100 hover:bg-emerald-400/20"
          : tone === "red"
            ? "border-red-500/30 bg-red-500/10 text-red-100 hover:bg-red-500/20"
            : "border-white/10 bg-white/[0.04] text-white/75 hover:border-white/20 hover:bg-white/[0.08] hover:text-white";
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className={cn(
        "inline-flex items-center justify-center rounded-lg border p-1.5 transition disabled:cursor-not-allowed disabled:opacity-50",
        cls,
      )}
    >
      <Icon
        className={cn("size-3.5", spinIcon && "animate-spin")}
        aria-hidden
      />
    </button>
  );
}
