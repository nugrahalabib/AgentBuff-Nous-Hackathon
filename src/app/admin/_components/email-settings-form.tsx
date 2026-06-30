"use client";

import { useMemo, useState } from "react";
import { Check, Send, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  apiFetch,
  FormRow,
  MultiSelectChips,
  SaveBar,
  Section,
  Toggle,
  useAdminMutation,
  useAdminQuery,
} from "./ui";

type Settings = {
  enabled: boolean;
  reminderOffsetsDays: number[];
  senderName: string | null;
  replyTo: string | null;
  updatedAt?: string;
};

// Server clip lengths (route.ts clip()): senderName 80, replyTo 120.
const SENDER_MAX = 80;
const REPLYTO_MAX = 120;
// Server sanitizeOffsets() bounds: integer 1..90, max 6 entries.
const OFFSET_MIN = 1;
const OFFSET_MAX = 90;
const OFFSET_LIMIT = 6;

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidOffset(v: string): boolean {
  const n = Number(v);
  return Number.isInteger(n) && n >= OFFSET_MIN && n <= OFFSET_MAX;
}

export function EmailSettingsForm() {
  const { data, isLoading, isError } = useAdminQuery<Settings>(
    ["admin", "email-settings"],
    "/api/admin/email-settings",
  );

  if (isLoading) {
    return (
      <Section title="Email & Reminder" desc="Saklar dan pengirim email pengingat trial + perpanjangan.">
        <div className="text-sm text-zinc-500">Memuat…</div>
      </Section>
    );
  }
  if (isError || !data) {
    return (
      <Section title="Email & Reminder" desc="Saklar dan pengirim email pengingat trial + perpanjangan.">
        <div className="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300">
          Gagal memuat pengaturan.
        </div>
      </Section>
    );
  }

  // Re-key the inner form by the loaded payload so server-side state always
  // seeds the controlled fields once at mount (no setState-in-effect).
  return <EmailForm key={data.updatedAt ?? "default"} initial={data} />;
}

function EmailForm({ initial }: { initial: Settings }) {
  const [enabled, setEnabled] = useState(initial.enabled);
  const [offsets, setOffsets] = useState<string[]>(
    initial.reminderOffsetsDays.map(String),
  );
  const [senderName, setSenderName] = useState(initial.senderName ?? "");
  const [replyTo, setReplyTo] = useState(initial.replyTo ?? "");

  const replyToTrimmed = replyTo.trim();
  const replyToValid = replyToTrimmed === "" || EMAIL_RE.test(replyToTrimmed);
  const replyToError = replyToValid ? null : "Format email tak valid.";

  const dirty = useMemo(() => {
    const baseOffsets = initial.reminderOffsetsDays.map(String).join(",");
    const curOffsets = offsets.join(",");
    return (
      enabled !== initial.enabled ||
      curOffsets !== baseOffsets ||
      senderName.trim() !== (initial.senderName ?? "") ||
      replyToTrimmed !== (initial.replyTo ?? "")
    );
  }, [enabled, offsets, senderName, replyToTrimmed, initial]);

  const save = useAdminMutation<void, Settings>(
    () =>
      apiFetch<Settings>("/api/admin/email-settings", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          enabled,
          reminderOffsetsDays: offsets
            .map((s) => Number(s))
            .filter((n) => Number.isFinite(n)),
          senderName: senderName.trim() || null,
          replyTo: replyToTrimmed || null,
        }),
      }),
    {
      successMessage: "Tersimpan. Worker memuat ulang dalam ≤60 detik.",
      invalidate: [["admin", "email-settings"]],
    },
  );

  // D15 — send a test email to the current admin to verify SMTP end-to-end.
  const test = useAdminMutation<void, { ok: boolean; sentTo: string }>(
    () =>
      apiFetch<{ ok: boolean; sentTo: string }>(
        "/api/admin/email-settings/test",
        { method: "POST" },
      ),
    {
      successMessage: (d) => `Tes terkirim ke ${d.sentTo}.`,
    },
  );

  const handleReset = () => {
    setEnabled(initial.enabled);
    setOffsets(initial.reminderOffsetsDays.map(String));
    setSenderName(initial.senderName ?? "");
    setReplyTo(initial.replyTo ?? "");
  };

  const canSave = dirty && replyToValid && !save.isPending;

  return (
    <Section
      title="Email & Reminder"
      desc="Saklar dan pengirim email pengingat trial + perpanjangan."
    >
      <div className="space-y-4">
        {/* Master switch */}
        <div className="flex items-center justify-between gap-3 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-sm text-zinc-200">Email reminder aktif</div>
            <div className="text-xs text-zinc-500">
              Saklar utama SEMUA email trial + perpanjangan. Off = tak ada email
              terkirim.
            </div>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} />
        </div>

        <FormRow
          label="Reminder offset TRIAL (hari sebelum berakhir)"
          help="Khusus trial — pengingat langganan pakai jadwal tetap H-7/3/1/0. Ketik angka 1–90, Enter. Maks 6."
        >
          <MultiSelectChips
            values={offsets}
            onChange={(v) =>
              setOffsets(
                Array.from(new Set(v.filter(isValidOffset))).slice(
                  0,
                  OFFSET_LIMIT,
                ),
              )
            }
            placeholder="mis. 3, 2, 1"
            max={OFFSET_LIMIT}
            validate={isValidOffset}
          />
        </FormRow>

        <FormRow
          label="Nama pengirim"
          help="Nama yang muncul sebagai pengirim email. Kosong = AgentBuff."
        >
          <div className="relative">
            <input
              value={senderName}
              maxLength={SENDER_MAX}
              onChange={(e) => setSenderName(e.target.value.slice(0, SENDER_MAX))}
              placeholder="AgentBuff"
              className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 pr-14 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] tabular-nums text-zinc-600">
              {senderName.length}/{SENDER_MAX}
            </span>
          </div>
        </FormRow>

        <FormRow
          label="Reply-to email"
          help="Alamat balasan email. Kosong = tanpa reply-to."
          error={replyToError}
        >
          <div className="relative">
            <input
              type="email"
              value={replyTo}
              maxLength={REPLYTO_MAX}
              onChange={(e) => setReplyTo(e.target.value.slice(0, REPLYTO_MAX))}
              placeholder="halo@agentbuff.id"
              className={cn(
                "w-full rounded-md border bg-zinc-900 px-2.5 py-1.5 pr-20 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:ring-2",
                replyToValid
                  ? "border-zinc-700 focus:border-cyan-500/50 focus:ring-cyan-500/30"
                  : "border-red-500/50 focus:border-red-500/60 focus:ring-red-500/30",
              )}
            />
            <span className="pointer-events-none absolute right-2.5 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
              {replyToTrimmed !== "" &&
                (replyToValid ? (
                  <Check className="size-3.5 text-emerald-400" />
                ) : (
                  <X className="size-3.5 text-red-400" />
                ))}
              <span className="text-[11px] tabular-nums text-zinc-600">
                {replyTo.length}/{REPLYTO_MAX}
              </span>
            </span>
          </div>
        </FormRow>

        {/* Test send — separate from the save flow, inline result chip */}
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-800 pt-3">
          <button
            type="button"
            disabled={test.isPending}
            onClick={() => test.mutate()}
            className="inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-50"
          >
            <Send className="size-3.5" />
            {test.isPending ? "Mengirim…" : "Kirim tes ke email saya"}
          </button>
          {test.isSuccess && test.data ? (
            <span className="text-xs text-emerald-400">
              Tes terkirim ke {test.data.sentTo}.
            </span>
          ) : null}
          {test.isError ? (
            <span className="text-xs text-red-300">
              Tes gagal — cek SMTP env / log.
            </span>
          ) : null}
        </div>

        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          onSave={() => {
            if (canSave) save.mutate();
          }}
          onReset={handleReset}
          message={
            replyToValid
              ? "Ada perubahan belum disimpan. Worker memuat ulang ≤60 dtk."
              : "Perbaiki format reply-to dulu sebelum simpan."
          }
        />
      </div>
    </Section>
  );
}
