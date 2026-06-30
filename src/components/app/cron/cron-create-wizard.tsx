"use client";

/**
 * CronCreateWizard — centered MODAL 3-step wizard.
 *
 * Step-aware title nempel di header modal (sticky). Body cuma render step
 * indicator + content + footer nav buttons. Step transition pakai
 * framer-motion slide horizontal.
 *
 * Step 1: Apa (payload kind + prompt + name auto-derive + agent)
 * Step 2: Kapan (preset / tiap-N / sekali / cron via segment tabs)
 * Step 3: Kirim ke mana (3 delivery cards)
 */
import { motion } from "framer-motion";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Bell,
  Calendar,
  Check,
  CircleDashed,
  Eye,
  MessageCircle,
  Sparkles,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useCronActions } from "@/hooks/use-cron-actions";
import {
  useCronDeliveryTargets,
  type AccountOption,
  type ChannelOption,
  type RecipientOption,
} from "@/hooks/use-cron-delivery-targets";
import {
  type CronJobCreate,
  type CronPayload,
  type CronSchedule,
  type CronSessionTarget,
  type CronWakeMode,
  type QuickPreset,
  humanizeSchedule,
} from "./helpers";
import { CronModalShell } from "./cron-modal-shell";
import { CronFrequencyPicker } from "./cron-frequency-picker";
import { CronAgentPicker } from "./cron-agent-picker";
import {
  CronAdvancedFields,
  type CronAdvancedValue,
} from "./cron-advanced-fields";

type Step = 1 | 2 | 3;
type DeliveryChoice = "notify-channel" | "silent";

export type WizardInitial = {
  preset?: QuickPreset;
};

// NEW ORDER (per feedback): Kapan → Apa → Kirim ke mana
// Schedule lebih konkret, ditentukan dulu. Prompt + delivery follow.
const STEP_TITLES: Record<Step, string> = {
  1: "Kapan jalanin?",
  2: "Mau ngerjain apa?",
  3: "Hasilnya kirim ke mana?",
};
const STEP_SUBTITLES: Record<Step, string> = {
  1: "Set jadwal dulu — preset siap pakai atau atur sendiri.",
  2: "Pilih tipe + tulis prompt-nya.",
  3: "Tentukan ke mana hasil rutinitas dikirim setelah selesai.",
};

export function CronCreateWizard({
  open,
  initial,
  onClose,
  onCreated,
  lockedAgentId,
  lockedAgentLabel,
}: {
  open: boolean;
  initial: WizardInitial | null;
  onClose: () => void;
  onCreated: (id: string, name: string) => void;
  /**
   * When set, the job is hard-bound to this agent: the executor picker is
   * hidden and replaced with a static "Dijalankan oleh: <agent>" line.
   * Used by the per-agent Jadwal panel so a routine created there always
   * runs as that agent. Absent = normal global flow (picker shown).
   */
  lockedAgentId?: string;
  lockedAgentLabel?: string;
}) {
  const { add, busyAction } = useCronActions();
  const [step, setStep] = useState<Step>(1);

  // ── Form state
  const [payloadKind, setPayloadKind] = useState<"agentTurn" | "systemEvent">(
    "agentTurn",
  );
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [nameTouched, setNameTouched] = useState(false);
  const [agentId, setAgentId] = useState(lockedAgentId ?? "");
  const [advanced, setAdvanced] = useState<CronAdvancedValue>({});

  const [schedule, setSchedule] = useState<CronSchedule>(
    initial?.preset?.schedule ?? { kind: "cron", expr: "0 8 * * *" },
  );
  const [deleteAfterRun, setDeleteAfterRun] = useState<boolean>(
    !!initial?.preset?.deleteAfterRun,
  );

  const [deliveryChoice, setDeliveryChoice] =
    useState<DeliveryChoice>("notify-channel");
  const [deliveryChannel, setDeliveryChannel] = useState("last");
  const [deliveryAccountId, setDeliveryAccountId] = useState("");
  const [deliveryTo, setDeliveryTo] = useState("");
  // Inline create error (replaces alert()). Shown in step 3 above the footer.
  const [createError, setCreateError] = useState<string | null>(null);

  // Reset state on open + apply preset prefill
  useEffect(() => {
    if (!open) return;
    setStep(1);
    setPayloadKind("agentTurn");
    setPrompt("");
    setNameTouched(false);
    setAgentId(lockedAgentId ?? "");
    setDeliveryChoice("notify-channel");
    setDeliveryChannel("last");
    setDeliveryAccountId("");
    setDeliveryTo("");
    setCreateError(null);
    if (initial?.preset) {
      setName(`${initial.preset.emoji} ${initial.preset.title}`);
      setSchedule(initial.preset.schedule);
      setDeleteAfterRun(!!initial.preset.deleteAfterRun);
    } else {
      setName("");
      setSchedule({ kind: "cron", expr: "0 8 * * *" });
      setDeleteAfterRun(false);
    }
  }, [open, initial?.preset]);

  // Auto-derive name dari prompt
  useEffect(() => {
    if (!open) return;
    if (nameTouched) return;
    if (initial?.preset) return; // preset prefill wins
    if (!prompt.trim()) {
      setName("");
      return;
    }
    const words = prompt.trim().split(/\s+/).slice(0, 4).join(" ");
    setName(words);
  }, [prompt, nameTouched, initial?.preset, open]);

  const isCreating = busyAction === "add";

  const { sessionTarget, wakeMode, deliveryConfig } = useMemo(
    () =>
      deriveExecution({
        choice: deliveryChoice,
        payloadKind,
        deliveryChannel,
        deliveryAccountId,
        deliveryTo,
      }),
    [
      deliveryChoice,
      payloadKind,
      deliveryChannel,
      deliveryAccountId,
      deliveryTo,
    ],
  );

  // New step order: 1=Schedule, 2=Prompt, 3=Delivery
  const canNext1 = scheduleIsValid(schedule);
  const canNext2 = name.trim().length > 0 && prompt.trim().length > 0;
  const canCreate = canNext1 && canNext2;

  const goNext = () => setStep((s) => Math.min(3, s + 1) as Step);
  const goBack = () => setStep((s) => Math.max(1, s - 1) as Step);

  const handleCreate = async () => {
    if (!canCreate) return;
    setCreateError(null);
    const payload: CronPayload =
      payloadKind === "agentTurn"
        ? { kind: "agentTurn", message: prompt.trim() }
        : { kind: "systemEvent", text: prompt.trim() };
    const job: CronJobCreate = {
      name: name.trim(),
      enabled: true,
      deleteAfterRun: deleteAfterRun || undefined,
      schedule,
      sessionTarget,
      wakeMode,
      payload,
      agentId: agentId.trim() || undefined,
      delivery: deliveryConfig,
      repeat: advanced.repeat,
      model: advanced.model?.trim() || undefined,
      skills: advanced.skills?.length ? advanced.skills : undefined,
      enabledToolsets: advanced.enabledToolsets?.length
        ? advanced.enabledToolsets
        : undefined,
    };
    const res = await add(job);
    if (res.ok) {
      onCreated(res.data.id, res.data.name);
      onClose();
    } else {
      setCreateError(res.error || "Gagal bikin rutinitas. Coba lagi.");
    }
  };

  return (
    <CronModalShell
      open={open}
      onClose={onClose}
      width="3xl"
      eyebrow="Bikin rutinitas"
      title={STEP_TITLES[step]}
      subtitle={STEP_SUBTITLES[step]}
      footer={
        <div className="flex items-center justify-between gap-2">
          {step > 1 ? (
            <button
              type="button"
              onClick={goBack}
              className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[12px] font-semibold text-white/85 hover:border-white/20 hover:bg-white/[0.08]"
            >
              <ArrowLeft className="size-3.5" aria-hidden />
              Kembali
            </button>
          ) : (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[12px] font-semibold text-white/70 hover:text-white"
            >
              Batal
            </button>
          )}

          {step < 3 ? (
            <button
              type="button"
              onClick={goNext}
              disabled={step === 1 ? !canNext1 : !canNext2}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-[12px] font-bold transition",
                (step === 1 ? canNext1 : canNext2)
                  ? "bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(99,102,241,0.6)] hover:brightness-110"
                  : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-white/40",
              )}
            >
              Lanjut
              <ArrowRight className="size-3.5" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={handleCreate}
              disabled={!canCreate || isCreating}
              className={cn(
                "inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-[12px] font-bold transition",
                canCreate
                  ? "bg-gradient-to-r from-emerald-400 via-cyan-500 to-indigo-500 text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(16,185,129,0.5)] hover:brightness-110"
                  : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-white/40",
              )}
            >
              {isCreating ? (
                <CircleDashed className="size-3.5 animate-spin" aria-hidden />
              ) : (
                <Check className="size-3.5" aria-hidden />
              )}
              Bikin rutinitas
            </button>
          )}
        </div>
      }
    >
      {/* Step indicator */}
      <div className="mb-4">
        <StepIndicator current={step} />
      </div>

      {/* Context bar — show summary of prior decisions (schedule decided in Step 1) */}
      {step > 1 ? <ContextBar name={name} schedule={schedule} step={step} /> : null}

      {/* Step content — direct render (no AnimatePresence to avoid React 19
          + framer-motion mode="wait" stale-children issue). Subtle fade only. */}
      <motion.div
        key={step}
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18, ease: "easeOut" }}
        className="relative"
      >
        {step === 1 ? (
          <Step1Schedule
            schedule={schedule}
            deleteAfterRun={deleteAfterRun}
            onSchedule={setSchedule}
            onDeleteAfterRun={setDeleteAfterRun}
          />
        ) : null}
        {step === 2 ? (
          <Step2Payload
            payloadKind={payloadKind}
            name={name}
            prompt={prompt}
            agentId={agentId}
            onPayloadKind={setPayloadKind}
            onName={(v) => {
              setName(v);
              setNameTouched(true);
            }}
            onPrompt={setPrompt}
            onAgent={setAgentId}
            lockedAgentId={lockedAgentId}
            lockedAgentLabel={lockedAgentLabel}
          />
        ) : null}
        {step === 3 ? (
          <Step3Delivery
            choice={deliveryChoice}
            channel={deliveryChannel}
            accountId={deliveryAccountId}
            to={deliveryTo}
            payloadKind={payloadKind}
            onChoice={setDeliveryChoice}
            onChannel={(v) => {
              setDeliveryChannel(v);
              setDeliveryAccountId(""); // reset account when channel changes
              setDeliveryTo("");
            }}
            onAccountId={setDeliveryAccountId}
            onTo={setDeliveryTo}
          />
        ) : null}

        {step === 3 ? (
          <div className="mt-4">
            <CronAdvancedFields
              value={advanced}
              onChange={(p) => setAdvanced((a) => ({ ...a, ...p }))}
            />
          </div>
        ) : null}

        {step === 3 && createError ? (
          <div
            role="alert"
            className="mt-4 flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-2.5 text-[12px] text-red-100"
          >
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-red-300" aria-hidden />
            <div className="min-w-0">
              <div className="font-semibold">Gagal bikin rutinitas</div>
              <p className="mt-0.5 break-words text-red-200/85">{createError}</p>
            </div>
          </div>
        ) : null}
      </motion.div>
    </CronModalShell>
  );
}

/* ── Step indicator ─────────────────────────────────────────────────── */

const STEP_LABELS: Record<Step, string> = {
  1: "Jadwal",
  2: "Tugas",
  3: "Kirim",
};

function StepIndicator({ current }: { current: Step }) {
  return (
    <div className="mx-auto w-full max-w-md">
      <div className="flex items-center">
        {[1, 2, 3].map((n, idx) => {
          const active = n === current;
          const done = n < current;
          const step = n as Step;
          return (
            <div key={n} className="flex flex-1 items-center last:flex-initial">
              <div className="flex flex-col items-center gap-1.5">
                <div
                  className={cn(
                    "flex size-9 items-center justify-center rounded-full border-2 text-[13px] font-bold transition",
                    done
                      ? "border-cyan-400/60 bg-cyan-400/15 text-cyan-100"
                      : active
                        ? "border-cyan-400 bg-gradient-to-br from-cyan-400 via-indigo-500 to-fuchsia-500 text-[#0B0E14] shadow-[0_0_24px_-4px_rgba(34,211,238,0.7)]"
                        : "border-white/15 bg-white/[0.04] text-white/55",
                  )}
                >
                  {done ? <Check className="size-4" /> : n}
                </div>
                <span
                  className={cn(
                    "font-mono text-[10px] font-bold uppercase tracking-[0.18em] transition",
                    active
                      ? "text-cyan-200"
                      : done
                        ? "text-white/75"
                        : "text-white/40",
                  )}
                >
                  {STEP_LABELS[step]}
                </span>
              </div>
              {idx < 2 ? (
                <div
                  className={cn(
                    "mx-2 -mt-5 h-[2px] flex-1 rounded-full transition",
                    n < current ? "bg-cyan-400/50" : "bg-white/[0.08]",
                  )}
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ContextBar({
  name,
  schedule,
  step,
}: {
  name: string;
  schedule: CronSchedule | null;
  step: Step;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-[11px] text-white/70">
      <span className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.16em] text-white/45">
        <Eye className="size-3" aria-hidden /> Ringkasan
      </span>
      {schedule ? (
        <>
          <Calendar className="size-3 text-cyan-300" aria-hidden />
          <span className="text-cyan-200">{humanizeSchedule(schedule)}</span>
        </>
      ) : null}
      {step >= 3 && name ? (
        <>
          <span className="text-white/30">·</span>
          <span className="font-semibold text-white/90">{name}</span>
        </>
      ) : null}
    </div>
  );
}

/* ── STEP 2 — Payload (was Step1) ──────────────────────────────────── */

function Step2Payload({
  payloadKind,
  name,
  prompt,
  agentId,
  onPayloadKind,
  onName,
  onPrompt,
  onAgent,
  lockedAgentId,
  lockedAgentLabel,
}: {
  payloadKind: "agentTurn" | "systemEvent";
  name: string;
  prompt: string;
  agentId: string;
  onPayloadKind: (v: "agentTurn" | "systemEvent") => void;
  onName: (v: string) => void;
  onPrompt: (v: string) => void;
  onAgent: (v: string) => void;
  lockedAgentId?: string;
  lockedAgentLabel?: string;
}) {
  return (
    <div className="space-y-4">
      <div className="grid gap-2 sm:grid-cols-2">
        <KindCard
          active={payloadKind === "agentTurn"}
          onClick={() => onPayloadKind("agentTurn")}
          icon={Sparkles}
          title="Tugas AI"
          description="AI eksekusi prompt — bisa research, balas chat, dll"
        />
        <KindCard
          active={payloadKind === "systemEvent"}
          onClick={() => onPayloadKind("systemEvent")}
          icon={Bell}
          title="Pengingat"
          description="Broadcast pesan apa adanya, tanpa AI"
        />
      </div>

      <Field
        label={
          payloadKind === "agentTurn"
            ? "Prompt buat AI"
            : "Pesan pengingat"
        }
        hint={
          payloadKind === "agentTurn"
            ? "Tulis tugas yang AI harus kerjain tiap rutinitas jalan."
            : "Pesan yang di-broadcast otomatis ke chat (tidak diproses AI)."
        }
        required
      >
        <textarea
          value={prompt}
          onChange={(e) => onPrompt(e.target.value)}
          placeholder={
            payloadKind === "agentTurn"
              ? "mis. Cek inbox WhatsApp tadi malem, kasih ringkasan singkat 3 poin"
              : "mis. ⏰ Waktunya stand-up meeting!"
          }
          rows={5}
          className="w-full resize-y rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
        />
      </Field>

      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Nama rutinitas"
          hint="Auto-ngisi dari prompt, edit kalau perlu."
          required
        >
          <input
            type="text"
            value={name}
            onChange={(e) => onName(e.target.value)}
            placeholder="mis. Ringkasan pagi"
            maxLength={120}
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
          />
        </Field>
        {payloadKind === "agentTurn" ? (
          lockedAgentId ? (
            <Field
              label="Agen"
              hint="Rutinitas ini otomatis dijalankan oleh agen yang sedang kamu buka."
            >
              <div className="flex items-center gap-2 rounded-lg border border-cyan-400/25 bg-cyan-400/[0.06] px-3 py-2">
                <Sparkles className="size-3.5 text-cyan-300" aria-hidden />
                <span className="text-[12.5px] font-semibold text-white/90">
                  {lockedAgentLabel || lockedAgentId}
                </span>
                <span className="ml-auto font-mono text-[9px] uppercase tracking-[0.16em] text-cyan-200/70">
                  terkunci
                </span>
              </div>
            </Field>
          ) : (
            <Field
              label="Agen"
              hint="Pilih agen yang ngerjain prompt ini. Default = pakai agen utama."
            >
              <CronAgentPicker value={agentId} onChange={onAgent} />
            </Field>
          )
        ) : null}
      </div>
    </div>
  );
}

function KindCard({
  active,
  onClick,
  icon: Icon,
  title,
  description,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof Sparkles;
  title: string;
  description: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "group flex items-start gap-3 rounded-xl border px-4 py-3 text-left transition",
        active
          ? "border-cyan-400/50 bg-cyan-400/[0.07] shadow-[0_0_24px_-12px_rgba(34,211,238,0.45)]"
          : "border-white/10 bg-white/[0.02] hover:border-white/25",
      )}
    >
      <div
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-lg border",
          active
            ? "border-cyan-400/40 bg-cyan-400/15 text-cyan-200"
            : "border-white/10 bg-white/[0.04] text-white/65",
        )}
      >
        <Icon className="size-4" aria-hidden />
      </div>
      <div className="min-w-0">
        <div className="text-[13px] font-semibold text-white">{title}</div>
        <p className="mt-0.5 text-[11px] leading-snug text-white/55">
          {description}
        </p>
      </div>
    </button>
  );
}

/* ── STEP 1 — Schedule (unified frequency picker) ───────────────── */

function Step1Schedule({
  schedule,
  deleteAfterRun,
  onSchedule,
  onDeleteAfterRun,
}: {
  schedule: CronSchedule;
  deleteAfterRun: boolean;
  onSchedule: (s: CronSchedule) => void;
  onDeleteAfterRun: (v: boolean) => void;
}) {
  return (
    <CronFrequencyPicker
      schedule={schedule}
      onChange={onSchedule}
      deleteAfterRun={deleteAfterRun}
      onDeleteAfterRun={onDeleteAfterRun}
    />
  );
}


/* ── STEP 3 — Delivery ─────────────────────────────────────────────── */

function Step3Delivery({
  choice,
  channel,
  accountId,
  to,
  payloadKind,
  onChoice,
  onChannel,
  onAccountId,
  onTo,
}: {
  choice: DeliveryChoice;
  channel: string;
  accountId: string;
  to: string;
  payloadKind: "agentTurn" | "systemEvent";
  onChoice: (c: DeliveryChoice) => void;
  onChannel: (v: string) => void;
  onAccountId: (v: string) => void;
  onTo: (v: string) => void;
}) {
  return (
    <div className="space-y-3">
      <DeliveryChoiceRow
        active={choice === "notify-channel"}
        onClick={() => onChoice("notify-channel")}
        icon={MessageCircle}
        tone="cyan"
        title="Umumkan ke channel"
        description={
          payloadKind === "agentTurn"
            ? "Hasil AI di-broadcast ke channel. Bisa ditujukan ke user spesifik."
            : "Pesan di-broadcast ke channel terakhir/spesifik."
        }
      >
        {choice === "notify-channel" ? (
          <ChannelDeliveryFields
            channel={channel}
            accountId={accountId}
            to={to}
            onChannel={onChannel}
            onAccountId={onAccountId}
            onTo={onTo}
          />
        ) : null}
      </DeliveryChoiceRow>

      <DeliveryChoiceRow
        active={choice === "silent"}
        onClick={() => onChoice("silent")}
        icon={Zap}
        tone="slate"
        title="Diam (no output)"
        description="Eksekusi diam-diam — hasilnya tetap tercatat di Riwayat tapi tidak diumumkan."
      />
    </div>
  );
}

/* ── Real-data dropdowns for "Umumkan ke channel" ─────────────────── */

function ChannelDeliveryFields({
  channel,
  accountId,
  to,
  onChannel,
  onAccountId,
  onTo,
}: {
  channel: string;
  accountId: string;
  to: string;
  onChannel: (v: string) => void;
  onAccountId: (v: string) => void;
  onTo: (v: string) => void;
}) {
  const targets = useCronDeliveryTargets();
  const accounts = useMemo(
    () => targets.accountsByChannel[channel] ?? [],
    [targets.accountsByChannel, channel],
  );
  const recipients = useMemo(
    () => targets.recipientsByChannel[channel] ?? [],
    [targets.recipientsByChannel, channel],
  );

  // NOTE: auto-select first account intentionally NOT done via useEffect to
  // avoid render-loop foot-gun. If only 1 account exists, AccountPicker is
  // hidden anyway (we only show it when accounts.length >= 2), and engine
  // accepts undefined accountId as fallback to default.

  if (targets.isLoading) {
    return (
      <div className="mt-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-4 text-center text-[11px] text-white/55">
        <CircleDashed className="mx-auto mb-1 size-3.5 animate-spin" aria-hidden />
        Memuat channel + kontak yang terdaftar...
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-3">
      <ChannelPicker
        value={channel}
        channels={targets.channels}
        onChange={onChannel}
      />

      {/* Account picker — only shows if selected channel has 2+ accounts */}
      {channel !== "last" && accounts.length >= 2 ? (
        <AccountPicker
          value={accountId}
          accounts={accounts}
          onChange={onAccountId}
        />
      ) : null}

      {/* Recipient picker */}
      <RecipientPicker
        value={to}
        channel={channel}
        recipients={recipients}
        onChange={onTo}
      />

      {/* Hint kalau channel belum di-pair */}
      {targets.channels.length === 0 ? (
        <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100">
          <strong>Belum ada channel terdaftar.</strong> Buka tab <em>Saluran</em>{" "}
          dulu untuk pasangkan WhatsApp / Telegram / dll, baru rutinitas bisa
          umumin hasilnya.
        </div>
      ) : null}
    </div>
  );
}

function ChannelPicker({
  value,
  channels,
  onChange,
}: {
  value: string;
  channels: ChannelOption[];
  onChange: (v: string) => void;
}) {
  return (
    <Field
      label="Channel"
      hint={
        channels.length === 0
          ? "Belum ada channel — pasangkan di tab Saluran"
          : `${channels.length} channel aktif. 'Channel terakhir' = pakai channel terbaru.`
      }
    >
      <div className="grid gap-2 sm:grid-cols-3">
        <button
          type="button"
          onClick={() => onChange("last")}
          className={cn(
            "rounded-lg border px-3 py-2 text-left transition",
            value === "last"
              ? "border-cyan-400/50 bg-cyan-400/[0.07] shadow-[0_0_24px_-12px_rgba(34,211,238,0.45)]"
              : "border-white/10 bg-white/[0.02] hover:border-white/25",
          )}
        >
          <div className="text-[12px] font-semibold text-white/90">
            Channel terakhir
          </div>
          <p className="mt-0.5 text-[10px] text-white/55">
            Otomatis pakai channel terbaru
          </p>
        </button>
        {channels.map((c) => {
          const active = value === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => onChange(c.id)}
              className={cn(
                "flex items-start gap-2 rounded-lg border px-3 py-2 text-left transition",
                active
                  ? "border-cyan-400/50 bg-cyan-400/[0.07] shadow-[0_0_24px_-12px_rgba(34,211,238,0.45)]"
                  : "border-white/10 bg-white/[0.02] hover:border-white/25",
              )}
            >
              <span aria-hidden className="text-base">
                {emojiForChannel(c.id)}
              </span>
              <div className="min-w-0">
                <div className="truncate text-[12px] font-semibold text-white/90">
                  {c.label}
                </div>
                <div className="text-[10px] text-white/45">
                  {c.linked
                    ? "Terhubung"
                    : c.configured
                      ? "Configured"
                      : "Belum aktif"}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </Field>
  );
}

function AccountPicker({
  value,
  accounts,
  onChange,
}: {
  value: string;
  accounts: AccountOption[];
  onChange: (v: string) => void;
}) {
  return (
    <Field
      label="Akun"
      hint={`${accounts.length} akun terdaftar di channel ini. Pilih salah satu untuk kirim dari sana.`}
      required
    >
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
      >
        <option value="" className="bg-[#0B0E14]">
          Pilih akun…
        </option>
        {accounts.map((a) => (
          <option key={a.accountId} value={a.accountId} className="bg-[#0B0E14]">
            {a.label}
            {a.running ? "" : " (offline)"}
            {a.lastError ? " · error" : ""}
          </option>
        ))}
      </select>
    </Field>
  );
}

function RecipientPicker({
  value,
  channel,
  recipients,
  onChange,
}: {
  value: string;
  channel: string;
  recipients: RecipientOption[];
  onChange: (v: string) => void;
}) {
  // User-toggled mode (sticky once user explicitly picks). When null, derive
  // mode from data: prefer list if recipients exist AND value matches one,
  // else manual. This avoids useEffect-based state sync → no render loop.
  const [forcedMode, setForcedMode] = useState<"list" | "manual" | null>(null);
  const derivedMode: "list" | "manual" =
    forcedMode ??
    (recipients.length === 0
      ? "manual"
      : value && !recipients.some((r) => r.value === value)
        ? "manual"
        : "list");
  const mode = derivedMode;
  const setMode = (m: "list" | "manual") => setForcedMode(m);

  return (
    <Field
      label="Kirim ke"
      hint={
        channel === "last"
          ? "Channel terakhir = otomatis. Penerima opsional kalau mau tujukan ke kontak spesifik."
          : recipients.length > 0
            ? `${recipients.length} kontak terdaftar (dari allowlist channel ini). Pilih, atau ketik manual.`
            : "Belum ada kontak terdaftar. Ketik ID/nomor manual."
      }
    >
      {recipients.length > 0 ? (
        <div className="mb-2 inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
          <button
            type="button"
            onClick={() => setMode("list")}
            className={cn(
              "rounded-md px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] transition",
              mode === "list"
                ? "bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 text-[#0B0E14]"
                : "text-white/55 hover:text-white/90",
            )}
          >
            Pilih dari daftar
          </button>
          <button
            type="button"
            onClick={() => setMode("manual")}
            className={cn(
              "rounded-md px-3 py-1 font-mono text-[10px] font-bold uppercase tracking-[0.16em] transition",
              mode === "manual"
                ? "bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 text-[#0B0E14]"
                : "text-white/55 hover:text-white/90",
            )}
          >
            Ketik manual
          </button>
        </div>
      ) : null}

      {mode === "list" && recipients.length > 0 ? (
        <RecipientList
          value={value}
          recipients={recipients}
          onChange={onChange}
        />
      ) : (
        <>
          <input
            type="text"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholderForChannel(channel)}
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
          />
          <p className="mt-1 text-[10px] leading-snug text-white/45">
            {formatHintForChannel(channel)}
          </p>
        </>
      )}
    </Field>
  );
}

function RecipientList({
  value,
  recipients,
  onChange,
}: {
  value: string;
  recipients: RecipientOption[];
  onChange: (v: string) => void;
}) {
  const [search, setSearch] = useState("");
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return recipients.slice(0, 20);
    return recipients
      .filter(
        (r) =>
          r.label.toLowerCase().includes(q) ||
          r.value.toLowerCase().includes(q),
      )
      .slice(0, 20);
  }, [recipients, search]);

  return (
    <div className="space-y-2">
      <input
        type="text"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Cari kontak / grup..."
        className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
      />
      {/* Allow "no target" option */}
      <button
        type="button"
        onClick={() => onChange("")}
        className={cn(
          "flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition",
          value === ""
            ? "border-cyan-400/50 bg-cyan-400/[0.07]"
            : "border-white/10 bg-white/[0.02] hover:border-white/25",
        )}
      >
        <span aria-hidden className="text-base">📢</span>
        <div className="min-w-0">
          <div className="text-[12px] font-semibold text-white/90">
            Broadcast ke channel
          </div>
          <p className="text-[10px] text-white/55">
            Tidak ditujukan ke kontak spesifik
          </p>
        </div>
      </button>
      <ul className="max-h-60 space-y-1 overflow-y-auto">
        {filtered.map((r) => {
          const active = value === r.value;
          return (
            <li key={r.value}>
              <button
                type="button"
                onClick={() => onChange(r.value)}
                className={cn(
                  "flex w-full items-start gap-2 rounded-lg border px-3 py-2 text-left transition",
                  active
                    ? "border-cyan-400/50 bg-cyan-400/[0.07]"
                    : "border-white/[0.06] bg-white/[0.02] hover:border-white/20",
                )}
              >
                <span aria-hidden className="text-base">
                  {r.kind === "group" ? "👥" : "💬"}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12px] font-semibold text-white/90">
                    {r.label}
                  </div>
                  <p className="truncate font-mono text-[10px] text-white/45">
                    {r.value}
                  </p>
                </div>
                {r.lastSeenAt ? (
                  <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.16em] text-white/35">
                    {formatRelativeShort(Date.now() - r.lastSeenAt)}
                  </span>
                ) : null}
              </button>
            </li>
          );
        })}
        {filtered.length === 0 ? (
          <li className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2 text-center text-[11px] italic text-white/45">
            Tidak ada kontak cocok dengan "{search}".
          </li>
        ) : null}
      </ul>
    </div>
  );
}

function emojiForChannel(id: string): string {
  const map: Record<string, string> = {
    whatsapp: "💬",
    telegram: "✈️",
    discord: "🎮",
    slack: "💼",
    google_chat: "📧",
    googlechat: "📧",
    "google-chat": "📧",
    webchat: "🖥️",
    web: "🖥️",
    agentbuff: "🖥️",
  };
  return map[id.toLowerCase()] ?? "📡";
}

function placeholderForChannel(channel: string): string {
  if (channel === "whatsapp") return "+62812345678 atau jid";
  if (channel === "telegram") return "@username atau chatId numeric";
  if (channel === "discord") return "channel/user snowflake ID";
  if (channel === "slack") return "C123456 atau @user";
  if (channel === "google_chat" || channel === "googlechat" || channel === "google-chat")
    return "space ID Google Chat";
  return "+62…, @user, chatId";
}

function formatHintForChannel(channel: string): string {
  if (channel === "whatsapp")
    return "WhatsApp: nomor format E.164 (+62...) atau JID lengkap.";
  if (channel === "telegram")
    return "Telegram: chatId numeric atau @username untuk public.";
  if (channel === "discord")
    return "Discord: snowflake ID dari channel/user (klik kanan > Copy ID).";
  if (channel === "slack")
    return "Slack: channel ID (C123456) atau @user.";
  return "Kosongkan untuk broadcast ke channel default.";
}

function formatRelativeShort(diffMs: number): string {
  const MIN = 60_000;
  const HR = 3600_000;
  const DAY = 24 * 3600_000;
  if (diffMs < MIN) return "now";
  if (diffMs < HR) return `${Math.round(diffMs / MIN)}m`;
  if (diffMs < DAY) return `${Math.round(diffMs / HR)}h`;
  if (diffMs < 7 * DAY) return `${Math.round(diffMs / DAY)}d`;
  return `${Math.round(diffMs / (7 * DAY))}w`;
}

function DeliveryChoiceRow({
  active,
  onClick,
  icon: Icon,
  title,
  description,
  tone,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: typeof MessageCircle;
  title: string;
  description: string;
  tone: "cyan" | "fuchsia" | "slate";
  children?: React.ReactNode;
}) {
  const activeCls =
    tone === "cyan"
      ? "border-cyan-400/50 bg-cyan-400/[0.05] shadow-[0_0_24px_-12px_rgba(34,211,238,0.45)]"
      : tone === "fuchsia"
        ? "border-fuchsia-400/50 bg-fuchsia-400/[0.05] shadow-[0_0_24px_-12px_rgba(217,70,239,0.45)]"
        : "border-white/30 bg-white/[0.04]";
  const iconActive =
    tone === "cyan"
      ? "border-cyan-400/40 bg-cyan-400/15 text-cyan-200"
      : tone === "fuchsia"
        ? "border-fuchsia-400/40 bg-fuchsia-400/15 text-fuchsia-200"
        : "border-white/20 bg-white/[0.06] text-white/85";
  return (
    <div
      className={cn(
        "rounded-xl border transition",
        active
          ? activeCls
          : "border-white/10 bg-white/[0.02] hover:border-white/25",
      )}
    >
      <button
        type="button"
        onClick={onClick}
        className="flex w-full items-start gap-3 px-4 py-3 text-left"
      >
        <div
          className={cn(
            "flex size-10 shrink-0 items-center justify-center rounded-lg border",
            active ? iconActive : "border-white/10 bg-white/[0.04] text-white/65",
          )}
        >
          <Icon className="size-4" aria-hidden />
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-[13px] font-semibold text-white">{title}</div>
          <p className="mt-0.5 text-[11px] leading-snug text-white/55">
            {description}
          </p>
        </div>
        <div
          className={cn(
            "mt-1 size-3.5 shrink-0 rounded-full border-2",
            active ? "border-cyan-400 bg-cyan-400" : "border-white/30",
          )}
        />
      </button>
      {children ? <div className="px-4 pb-3">{children}</div> : null}
    </div>
  );
}

/* ── Form primitives ─────────────────────────────────────────────────── */

function Field({
  label,
  hint,
  required,
  children,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label className="mb-1 flex items-baseline gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
        {label}
        {required ? <span className="text-amber-300">*</span> : null}
      </label>
      {children}
      {hint ? (
        <p className="mt-1 text-[10px] leading-snug text-white/45">{hint}</p>
      ) : null}
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 rounded-lg border border-white/[0.08] bg-white/[0.02] px-3 py-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 size-4 shrink-0 accent-cyan-400"
      />
      <div>
        <div className="text-[12px] font-semibold text-white/90">{label}</div>
        {hint ? (
          <p className="text-[10px] leading-snug text-white/55">{hint}</p>
        ) : null}
      </div>
    </label>
  );
}

/* ── Logic ───────────────────────────────────────────────────────────── */

function scheduleIsValid(s: CronSchedule): boolean {
  if (s.kind === "at") {
    return !!s.at && !Number.isNaN(new Date(s.at).getTime());
  }
  if (s.kind === "every") return s.everyMs > 0;
  if (s.kind === "cron") return s.expr.trim().split(/\s+/).length === 5;
  return false;
}

function deriveExecution({
  choice,
  payloadKind,
  deliveryChannel,
  deliveryAccountId,
  deliveryTo,
}: {
  choice: DeliveryChoice;
  payloadKind: "agentTurn" | "systemEvent";
  deliveryChannel: string;
  deliveryAccountId: string;
  deliveryTo: string;
}): {
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  deliveryConfig: CronJobCreate["delivery"];
} {
  if (choice === "silent") {
    return {
      sessionTarget: payloadKind === "agentTurn" ? "main" : "isolated",
      wakeMode: "now",
      deliveryConfig: { mode: "none" },
    };
  }
  return {
    sessionTarget: "isolated",
    wakeMode: "now",
    deliveryConfig: {
      mode: "announce",
      channel: deliveryChannel.trim() || "last",
      accountId: deliveryAccountId.trim() || undefined,
      to: deliveryTo.trim() || undefined,
    },
  };
}
