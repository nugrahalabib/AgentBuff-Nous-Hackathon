"use client";

/**
 * CronEditDrawer (now centered MODAL) — full-form edit dengan SEMUA section
 * langsung kelihatan (no accordion). 2-col layout di section yang muat
 * supaya gak scroll panjang.
 *
 * Sections (visible at once):
 *  1. Dasar (name, description, agent, toggles)
 *  2. Jadwal (kind tabs + editor + preview)
 *  3. Tipe & Prompt (payload kind + content)
 *  4. Tempat Kerja (sessionTarget + wakeMode + sessionKey)
 *  5. Kirim Hasil (delivery)
 *  7. Lanjutan (advanced AI knobs — model/thinking/timeout/lightContext)
 *
 * Action buttons (Run / Toggle pause / Delete) accessible dari header actions.
 *
 * Backwards-compatible export name: still `CronEditDrawer` so cron-tab.tsx
 * import doesn't break, even though internally it's a modal now.
 */
import {
  Activity,
  AlertTriangle,
  Calendar,
  Check,
  ChevronDown,
  Cog,
  Loader2,
  Pause,
  Play,
  Power,
  Send,
  Sparkles,
  Trash2,
  Zap,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useCronActions } from "@/hooks/use-cron-actions";
import {
  type CronDelivery,
  type CronDeliveryMode,
  type CronJob,
  type CronJobPatch,
  type CronPayload,
  type CronSchedule,
  type CronSessionTarget,
  type CronWakeMode,
  formatLocalDateTime,
  humanizeSchedule,
} from "./helpers";
import { CronModalShell } from "./cron-modal-shell";
import { CronFrequencyPicker } from "./cron-frequency-picker";
import { CronAgentPicker } from "./cron-agent-picker";
import { CronAdvancedFields } from "./cron-advanced-fields";

export function CronEditDrawer({
  open,
  job,
  onClose,
  onSaved,
}: {
  open: boolean;
  job: CronJob | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  if (!job) {
    return (
      <CronModalShell
        open={open && !!job}
        onClose={onClose}
        width="3xl"
        eyebrow="Edit rutinitas"
        title="Rutinitas"
      >
        {null}
      </CronModalShell>
    );
  }
  return (
    <EditDrawerWithCtx
      open={open}
      job={job}
      onClose={onClose}
      onSaved={onSaved}
    />
  );
}

/** Inner component that holds form state + Provider scope encompassing
 *  ALL of header (HeaderActions can read for action-busy state), body
 *  (EditBody sections), AND footer (SaveFooter). Previously FormCtx
 *  was provided only inside EditBody, so SaveFooter rendered in shell's
 *  footer slot got `null` from useContext → returned null → no save button. */
function EditDrawerWithCtx({
  open,
  job,
  onClose,
  onSaved,
}: {
  open: boolean;
  job: CronJob;
  onClose: () => void;
  onSaved: () => void;
}) {
  // Dep on job.id (NOT the whole job object) so a background cron broadcast
  // refetch — which hands us a new job object with the SAME id — does not
  // recompute `initial` and re-seed the form, silently wiping the user's
  // unsaved edits. Re-seed only when a genuinely different job opens. (Audit HIGH.)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const initial = useMemo(() => jobToState(job), [job.id]);
  const [state, setState] = useState<FormState>(initial);

  // Reset state when a DIFFERENT job is opened in the same modal.
  useEffect(() => {
    setState(initial);
  }, [job.id, initial]);

  return (
    <FormCtx.Provider value={{ state, setState, initial }}>
      <CronModalShell
        open={open}
        onClose={onClose}
        width="3xl"
        eyebrow="Edit rutinitas"
        title={job.name}
        subtitle={job.id}
        headerExtras={<HeaderActions job={job} onAfter={onSaved} />}
        footer={<SaveFooter job={job} onClose={onClose} onSaved={onSaved} />}
      >
        <EditBody job={job} />
      </CronModalShell>
    </FormCtx.Provider>
  );
}

/* ── Form state hoisted to a ref-like context via parent re-render ── */
// We use a module-scoped ref-pattern to share state between EditBody +
// SaveFooter without prop drilling through CronModalShell. Each open uses
// a fresh instance via React key (job.id).

type FormState = {
  name: string;
  description: string;
  agentId: string;
  enabled: boolean;
  deleteAfterRun: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  sessionTarget: CronSessionTarget;
  wakeMode: CronWakeMode;
  sessionKey: string;
  delivery: CronDelivery;
  model: string;
  skills: string[];
  enabledToolsets: string[];
  repeat: number | undefined;
};

// FormState shared via React Context — created inline so we don't pollute
// module scope. Keeps it tied to the modal lifecycle.
import { createContext, useContext } from "react";
import type { Dispatch, SetStateAction } from "react";

// Setter accepts BOTH direct values and functional updates.
// Functional updates are CRITICAL when multiple effects fire in the same
// task (e.g., CronFrequencyPicker fires both onChange + onDeleteAfterRun
// on kind change). Direct-value setState in those callbacks would batch
// last-write-wins and lose the schedule update.
const FormCtx = createContext<{
  state: FormState;
  setState: Dispatch<SetStateAction<FormState>>;
  initial: FormState;
} | null>(null);

function useFormCtx() {
  const v = useContext(FormCtx);
  if (!v) throw new Error("Cron edit form context not provided");
  return v;
}

function jobToState(job: CronJob): FormState {
  return {
    name: job.name,
    description: job.description ?? "",
    agentId: job.agentId ?? "",
    enabled: job.enabled,
    deleteAfterRun: !!job.deleteAfterRun,
    schedule: job.schedule,
    payload: job.payload,
    sessionTarget: job.sessionTarget,
    wakeMode: job.wakeMode,
    sessionKey: job.sessionKey ?? "",
    delivery: job.delivery ?? { mode: "none" },
    model: job.model ?? "",
    skills: job.skills ?? [],
    enabledToolsets: job.enabledToolsets ?? [],
    repeat: job.repeat,
  };
}

function EditBody({ job: _job }: { job: CronJob }) {
  // State + Provider are owned by EditDrawerWithCtx (parent). EditBody is
  // pure presentation — children read context directly.
  return (
    <div className="space-y-5">
      <BasicSection />
      <ScheduleSection />
      <PayloadSection />

      <div className="grid gap-5 lg:grid-cols-2">
        <ExecutionSection />
        <DeliverySection />
      </div>

      <AdvancedSection />

      <ValidationSummary />
    </div>
  );
}

function AdvancedSection() {
  const { state, setState } = useFormCtx();
  return (
    <CronAdvancedFields
      value={{
        repeat: state.repeat,
        model: state.model,
        skills: state.skills,
        enabledToolsets: state.enabledToolsets,
      }}
      onChange={(p) => setState({ ...state, ...p })}
      defaultOpen={
        !!(state.repeat || state.model || state.skills.length || state.enabledToolsets.length)
      }
    />
  );
}

/* ── Header actions (Run / Toggle / Delete) ─────────────────────────── */

function HeaderActions({
  job,
  onAfter,
}: {
  job: CronJob;
  onAfter: () => void;
}) {
  const { run, toggleEnabled, remove, busyAction } = useCronActions();
  const [confirmDelete, setConfirmDelete] = useState(false);

  const runBusy = busyAction === `run-${job.id}`;
  const toggleBusy = busyAction === `update-${job.id}`;
  const deleteBusy = busyAction === `remove-${job.id}`;

  return (
    <div className="flex items-center gap-1">
      <ActionIconBtn
        tone="cyan"
        onClick={async () => {
          const res = await run(job.id, "force");
          if (res.ok) onAfter();
        }}
        disabled={runBusy}
        icon={runBusy ? Loader2 : Play}
        spinIcon={runBusy}
        label="Jalanin sekarang"
      />
      <ActionIconBtn
        tone={job.enabled ? "amber" : "emerald"}
        onClick={async () => {
          const res = await toggleEnabled(job.id, !job.enabled);
          if (res.ok) onAfter();
        }}
        disabled={toggleBusy}
        icon={toggleBusy ? Loader2 : job.enabled ? Pause : Power}
        spinIcon={toggleBusy}
        label={job.enabled ? "Pause" : "Aktifkan"}
      />
      {confirmDelete ? (
        <div className="ml-1 inline-flex items-center gap-1 rounded-lg border border-red-500/40 bg-red-500/15 px-1.5 py-1">
          <button
            type="button"
            onClick={async () => {
              const res = await remove(job.id);
              if (res.ok) {
                onAfter();
              }
            }}
            disabled={deleteBusy}
            className="inline-flex items-center gap-1 rounded-md bg-red-500 px-2 py-0.5 font-mono text-[10px] font-bold uppercase tracking-wider text-white hover:brightness-110 disabled:opacity-50"
          >
            {deleteBusy ? (
              <Loader2 className="size-3 animate-spin" aria-hidden />
            ) : null}
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
        <ActionIconBtn
          tone="red"
          onClick={() => setConfirmDelete(true)}
          disabled={runBusy || toggleBusy}
          icon={Trash2}
          label="Hapus"
        />
      )}
    </div>
  );
}

function ActionIconBtn({
  tone,
  onClick,
  disabled,
  icon: Icon,
  label,
  spinIcon,
}: {
  tone: "cyan" | "amber" | "emerald" | "red";
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
          : "border-red-500/30 bg-red-500/10 text-red-100 hover:bg-red-500/20";
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

/* ── Save Footer ────────────────────────────────────────────────────── */

function SaveFooter({
  job,
  onClose,
  onSaved,
}: {
  job: CronJob;
  onClose: () => void;
  onSaved: () => void;
}) {
  const ctx = useContext(FormCtx);
  const { update, busyAction } = useCronActions();
  if (!ctx) return null;
  const { state, initial } = ctx;

  const isSaving = busyAction === `update-${job.id}`;
  const dirty = !shallowEqualForm(state, initial);
  const errors = collectErrors(state);
  const canSave = dirty && errors.length === 0;

  const handleSave = async () => {
    if (!canSave) return;
    const patch: CronJobPatch = {
      name: state.name.trim(),
      description: state.description.trim() || undefined,
      agentId: state.agentId.trim() || null,
      enabled: state.enabled,
      deleteAfterRun: state.deleteAfterRun || undefined,
      schedule: state.schedule,
      payload: state.payload,
      sessionTarget: state.sessionTarget,
      wakeMode: state.wakeMode,
      sessionKey: state.sessionKey.trim() || null,
      delivery: state.delivery,
      model: state.model.trim() || undefined,
      skills: state.skills.length ? state.skills : undefined,
      enabledToolsets: state.enabledToolsets.length ? state.enabledToolsets : undefined,
      repeat: state.repeat,
    };
    const res = await update(job.id, patch);
    if (res.ok) {
      onSaved();
      onClose();
    } else {
      alert(`Gagal simpan: ${res.error}`);
    }
  };

  return (
    <div className="flex items-center justify-between gap-2">
      <button
        type="button"
        onClick={onClose}
        className="rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 text-[12px] font-semibold text-white/70 hover:text-white"
      >
        Batal
      </button>
      <button
        type="button"
        onClick={handleSave}
        disabled={!canSave || isSaving}
        className={cn(
          "inline-flex items-center gap-1.5 rounded-lg px-5 py-2 text-[12px] font-bold transition",
          canSave
            ? "bg-gradient-to-r from-emerald-400 via-cyan-500 to-indigo-500 text-[#0B0E14] shadow-[0_8px_24px_-12px_rgba(16,185,129,0.5)] hover:brightness-110"
            : "cursor-not-allowed border border-white/10 bg-white/[0.03] text-white/40",
        )}
      >
        {isSaving ? (
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
        ) : (
          <Check className="size-3.5" aria-hidden />
        )}
        Simpan perubahan
      </button>
    </div>
  );
}

/* ── Section primitive (no accordion — always visible) ──────────── */

function Section({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: typeof Cog;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.02] px-4 py-4">
      <header className="mb-3 flex items-baseline gap-2">
        <Icon className="size-3.5 shrink-0 text-cyan-300/85" aria-hidden />
        <h3 className="font-mono text-[10px] font-bold uppercase tracking-[0.2em] text-white/85">
          {title}
        </h3>
        {description ? (
          <span className="ml-1 text-[11px] text-white/45">
            · {description}
          </span>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/* ── Sections ────────────────────────────────────────────────────── */

function BasicSection() {
  const { state, setState } = useFormCtx();
  return (
    <Section icon={Cog} title="Dasar">
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Nama" required>
            <input
              type="text"
              value={state.name}
              onChange={(e) => setState({ ...state, name: e.target.value })}
              className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
            />
          </Field>
          <Field
            label="Agen"
            hint="Pilih agen yang ngerjain rutinitas ini."
          >
            <CronAgentPicker
              value={state.agentId}
              onChange={(next) => setState({ ...state, agentId: next })}
            />
          </Field>
        </div>
        <Field label="Deskripsi (opsional)">
          <input
            type="text"
            value={state.description}
            onChange={(e) =>
              setState({ ...state, description: e.target.value })
            }
            placeholder="Catatan singkat tentang rutinitas ini"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
          />
        </Field>
        <div className="grid gap-2 sm:grid-cols-2">
          <Toggle
            checked={state.enabled}
            onChange={(v) => setState({ ...state, enabled: v })}
            label="Aktif"
            hint="Rutinitas dijalankan sesuai jadwal."
          />
          <Toggle
            checked={state.deleteAfterRun}
            onChange={(v) => setState({ ...state, deleteAfterRun: v })}
            label="Hapus setelah selesai"
            hint="Sekali jalan lalu auto-deleted (one-shot)."
          />
        </div>
      </div>
    </Section>
  );
}

function ScheduleSection() {
  const { state, setState } = useFormCtx();
  const schedule = state.schedule;
  // FUNCTIONAL setState here is REQUIRED. CronFrequencyPicker fires
  // BOTH onChange + onDeleteAfterRun within the same task whenever
  // state.kind changes (preset switch). With direct-value setState,
  // React batches the two updates last-write-wins and the schedule
  // update is silently dropped. Functional setState merges in order.
  return (
    <Section icon={Calendar} title="Jadwal" description={humanizeSchedule(schedule)}>
      <CronFrequencyPicker
        schedule={schedule}
        onChange={(s) => setState((prev) => ({ ...prev, schedule: s }))}
        deleteAfterRun={state.deleteAfterRun}
        onDeleteAfterRun={(v) =>
          setState((prev) => ({ ...prev, deleteAfterRun: v }))
        }
      />
    </Section>
  );
}

function PayloadSection() {
  const { state, setState } = useFormCtx();
  const payload = state.payload;
  const setPayload = (p: CronPayload) => setState({ ...state, payload: p });

  return (
    <Section icon={Sparkles} title="Tipe & Prompt">
      <div className="space-y-3">
        <div className="inline-flex rounded-lg border border-white/10 bg-white/[0.03] p-0.5">
          {(
            [
              { id: "agentTurn", label: "Tugas AI" },
              { id: "systemEvent", label: "Pengingat" },
            ] as Array<{ id: CronPayload["kind"]; label: string }>
          ).map((m) => (
            <button
              key={m.id}
              type="button"
              onClick={() =>
                setPayload(
                  m.id === "agentTurn"
                    ? {
                        kind: "agentTurn",
                        message:
                          payload.kind === "agentTurn" ? payload.message : "",
                      }
                    : {
                        kind: "systemEvent",
                        text:
                          payload.kind === "systemEvent" ? payload.text : "",
                      },
                )
              }
              className={cn(
                "rounded-md px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] transition",
                payload.kind === m.id
                  ? "bg-gradient-to-r from-cyan-400 via-indigo-500 to-fuchsia-500 text-[#0B0E14]"
                  : "text-white/55 hover:text-white/90",
              )}
            >
              {m.label}
            </button>
          ))}
        </div>

        {payload.kind === "agentTurn" ? (
          <AgentTurnFields payload={payload} onChange={setPayload} />
        ) : null}

        {payload.kind === "systemEvent" ? (
          <Field label="Pesan pengingat" required>
            <textarea
              value={payload.text}
              onChange={(e) =>
                setPayload({ kind: "systemEvent", text: e.target.value })
              }
              rows={4}
              placeholder="mis. ⏰ Daily stand-up dimulai dalam 5 menit"
              className="w-full resize-y rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
            />
          </Field>
        ) : null}
      </div>
    </Section>
  );
}

function AgentTurnFields({
  payload,
  onChange,
}: {
  payload: Extract<CronPayload, { kind: "agentTurn" }>;
  onChange: (p: CronPayload) => void;
}) {
  return (
    <div className="space-y-3">
      <Field label="Prompt" required>
        <textarea
          value={payload.message}
          onChange={(e) => onChange({ ...payload, message: e.target.value })}
          rows={4}
          placeholder="mis. Cek inbox WhatsApp, ringkas jadi 3 poin"
          className="w-full resize-y rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
        />
      </Field>

      {/* Advanced AI knobs in 2-col grid */}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          label="Model override (opsional)"
          hint="Kosong = pake default."
        >
          <input
            type="text"
            value={payload.model ?? ""}
            onChange={(e) =>
              onChange({
                ...payload,
                model: e.target.value.trim() || undefined,
              })
            }
            placeholder="claude-3-7-sonnet"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[12px] text-white focus:border-cyan-400/50 focus:outline-none"
          />
        </Field>
        <Field
          label="Thinking config (opsional)"
          hint="'enabled' / 'disabled' / 'budget_tokens:5000'"
        >
          <input
            type="text"
            value={payload.thinking ?? ""}
            onChange={(e) =>
              onChange({
                ...payload,
                thinking: e.target.value.trim() || undefined,
              })
            }
            placeholder="disabled"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[12px] text-white focus:border-cyan-400/50 focus:outline-none"
          />
        </Field>
        <Field
          label="Timeout (detik, opsional)"
          hint="Max waktu eksekusi."
        >
          <input
            type="number"
            min={1}
            value={payload.timeoutSeconds ?? ""}
            onChange={(e) => {
              const v = e.target.value.trim();
              onChange({
                ...payload,
                timeoutSeconds: v ? Math.max(1, Number(v)) : undefined,
              });
            }}
            placeholder="default"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
          />
        </Field>
        <div className="flex flex-col gap-2">
          <Toggle
            checked={!!payload.lightContext}
            onChange={(v) =>
              onChange({ ...payload, lightContext: v || undefined })
            }
            label="Light context"
            hint="Skip workspace file injection. Hemat token."
          />
          <Toggle
            checked={!!payload.allowUnsafeExternalContent}
            onChange={(v) =>
              onChange({ ...payload, allowUnsafeExternalContent: v || undefined })
            }
            label="Allow unsafe external content"
            hint="Izinkan AI eksekusi instruksi dari external content. Pikir 2x."
          />
        </div>
      </div>
    </div>
  );
}

function ExecutionSection() {
  const { state, setState } = useFormCtx();
  return (
    <Section icon={Activity} title="Tempat Kerja">
      <div className="space-y-3">
        <Field
          label="Sesi"
          hint="Di mana AI ngerjain prompt-nya."
        >
          <select
            value={String(state.sessionTarget)}
            onChange={(e) =>
              setState({
                ...state,
                sessionTarget: e.target.value as CronSessionTarget,
              })
            }
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
          >
            <option value="isolated" className="bg-[#0B0E14]">
              Sesi sendiri (fresh tiap lari)
            </option>
            <option value="main" className="bg-[#0B0E14]">
              Sesi utama (lanjut history)
            </option>
            <option value="current" className="bg-[#0B0E14]">
              Sesi aktif sekarang
            </option>
          </select>
        </Field>

        <Field
          label="Mode bangun"
          hint="'Mulai langsung' = eksekusi langsung. 'Tunggu giliran' = nunggu next heartbeat."
        >
          <select
            value={state.wakeMode}
            onChange={(e) =>
              setState({ ...state, wakeMode: e.target.value as CronWakeMode })
            }
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
          >
            <option value="now" className="bg-[#0B0E14]">
              Mulai langsung
            </option>
            <option value="next-heartbeat" className="bg-[#0B0E14]">
              Tunggu giliran
            </option>
          </select>
        </Field>

        <Field
          label="Session key (advanced)"
          hint="Routing key spesifik. Kosong = default."
        >
          <input
            type="text"
            value={state.sessionKey}
            onChange={(e) =>
              setState({ ...state, sessionKey: e.target.value })
            }
            placeholder="agent:main:main"
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 font-mono text-[12px] text-white focus:border-cyan-400/50 focus:outline-none"
          />
        </Field>
      </div>
    </Section>
  );
}

function DeliverySection() {
  const { state, setState } = useFormCtx();
  const delivery = state.delivery;
  const setDelivery = (d: CronDelivery) => setState({ ...state, delivery: d });

  return (
    <Section icon={Send} title="Kirim Hasil">
      <div className="space-y-3">
        <Field label="Mode">
          <select
            value={delivery.mode}
            onChange={(e) =>
              setDelivery({
                ...delivery,
                mode: e.target.value as CronDeliveryMode,
              })
            }
            className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
          >
            <option value="none" className="bg-[#0B0E14]">
              Diam (no output)
            </option>
            <option value="announce" className="bg-[#0B0E14]">
              Umumkan ke channel
            </option>
            {delivery.mode === "webhook" ? (
              // Legacy-only: jobs created via CLI/agent with deliver:"webhook".
              // The engine has no webhook cron sender (delivery silently fails
              // at fire time) so the option is read-only here — without this
              // the controlled select would render blank (no matching option).
              <option value="webhook" disabled className="bg-[#0B0E14]">
                Webhook (legacy — tidak didukung)
              </option>
            ) : null}
          </select>
        </Field>

        {delivery.mode === "webhook" ? (
          <div className="rounded-lg border border-amber-400/30 bg-amber-400/[0.06] px-3 py-2 text-[11px] text-amber-100">
            Rutinitas ini masih pakai delivery <strong>webhook</strong> lama
            {delivery.to ? (
              <>
                {" "}
                (<span className="break-all font-mono">{delivery.to}</span>)
              </>
            ) : null}
            . Engine tidak bisa kirim ke webhook, jadi hasilnya tidak pernah
            terkirim. Pilih <em>Umumkan ke channel</em> atau <em>Diam</em> untuk
            memperbaikinya.
          </div>
        ) : null}

        {delivery.mode === "announce" ? (
          <>
            <Field label="Channel">
              <input
                type="text"
                value={delivery.channel ?? "last"}
                onChange={(e) =>
                  setDelivery({ ...delivery, channel: e.target.value })
                }
                placeholder="last"
                className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
              />
            </Field>
            <Field label="Penerima (opsional)">
              <input
                type="text"
                value={delivery.to ?? ""}
                onChange={(e) =>
                  setDelivery({
                    ...delivery,
                    to: e.target.value.trim() || undefined,
                  })
                }
                placeholder="+62..., @user, chatId"
                className="w-full rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
              />
            </Field>
            <Toggle
              checked={!!delivery.bestEffort}
              onChange={(v) =>
                setDelivery({ ...delivery, bestEffort: v || undefined })
              }
              label="Best-effort delivery"
              hint="Lanjut walau pengiriman gagal."
            />
          </>
        ) : null}

      </div>
    </Section>
  );
}

function ValidationSummary() {
  const ctx = useContext(FormCtx);
  if (!ctx) return null;
  const errs = collectErrors(ctx.state);
  if (errs.length === 0) return null;
  return (
    <div className="rounded-xl border border-amber-400/30 bg-amber-400/[0.06] px-4 py-3 text-[12px] text-amber-100">
      <div className="flex items-center gap-1.5 font-semibold">
        <AlertTriangle className="size-3.5" aria-hidden />
        Belum bisa disimpan:
      </div>
      <ul className="mt-1 list-inside list-disc space-y-0.5 pl-2">
        {errs.map((e) => (
          <li key={e}>{e}</li>
        ))}
      </ul>
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

/* ── Validation + dirty ─────────────────────────────────────────── */

function shallowEqualForm(a: FormState, b: FormState): boolean {
  return (
    a.name === b.name &&
    a.description === b.description &&
    a.agentId === b.agentId &&
    a.enabled === b.enabled &&
    a.deleteAfterRun === b.deleteAfterRun &&
    a.sessionTarget === b.sessionTarget &&
    a.wakeMode === b.wakeMode &&
    a.sessionKey === b.sessionKey &&
    JSON.stringify(a.schedule) === JSON.stringify(b.schedule) &&
    JSON.stringify(a.payload) === JSON.stringify(b.payload) &&
    JSON.stringify(a.delivery) === JSON.stringify(b.delivery) &&
    a.model === b.model &&
    a.repeat === b.repeat &&
    // Order-insensitive: the bridge may return skills/toolsets in a different
    // order than the user selected; an order-sensitive compare would keep the
    // Save button enabled forever after save. (Audit MED.)
    JSON.stringify([...(a.skills ?? [])].sort()) ===
      JSON.stringify([...(b.skills ?? [])].sort()) &&
    JSON.stringify([...(a.enabledToolsets ?? [])].sort()) ===
      JSON.stringify([...(b.enabledToolsets ?? [])].sort())
  );
}

// Light per-field cron validation — catches out-of-range values / step 0 that
// pass the 5-field count check but make a silently-dead schedule. (Audit HIGH.)
function isValidCronField(field: string, min: number, max: number): boolean {
  for (const part of field.split(",")) {
    if (part === "") return false;
    if (part === "*") continue;
    let body = part;
    const stepM = part.match(/^(.+)\/(\d+)$/);
    if (stepM) {
      if (parseInt(stepM[2], 10) <= 0) return false;
      body = stepM[1];
    }
    if (body === "*") continue;
    const rangeM = body.match(/^(\d+)(?:-(\d+))?$/);
    if (!rangeM) return false;
    const a = parseInt(rangeM[1], 10);
    if (a < min || a > max) return false;
    if (rangeM[2] !== undefined) {
      const b = parseInt(rangeM[2], 10);
      if (b < min || b > max || b < a) return false;
    }
  }
  return true;
}

function collectErrors(state: FormState): string[] {
  const errs: string[] = [];
  if (!state.name.trim()) errs.push("Nama wajib diisi.");
  const s = state.schedule;
  if (s.kind === "at") {
    if (!s.at || Number.isNaN(new Date(s.at).getTime())) {
      errs.push("Tanggal+jam tidak valid.");
    }
  } else if (s.kind === "every") {
    if (s.everyMs <= 0) errs.push("Tiap N harus > 0.");
  } else if (s.kind === "cron") {
    const fields = s.expr.trim().split(/\s+/);
    if (fields.length !== 5) {
      errs.push("Cron expression harus 5 field.");
    } else {
      const ranges: Array<[number, number]> = [
        [0, 59], [0, 23], [1, 31], [1, 12], [0, 7],
      ];
      const names = ["menit", "jam", "tanggal", "bulan", "hari"];
      fields.forEach((f, i) => {
        if (!isValidCronField(f, ranges[i][0], ranges[i][1])) {
          errs.push(`Field ${names[i]} tidak valid: "${f}".`);
        }
      });
    }
  }
  if (state.payload.kind === "agentTurn" && !state.payload.message.trim()) {
    errs.push("Prompt wajib diisi.");
  }
  if (state.payload.kind === "systemEvent" && !state.payload.text.trim()) {
    errs.push("Pesan pengingat wajib diisi.");
  }
  return errs;
}
