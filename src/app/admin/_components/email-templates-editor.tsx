"use client";

import { useState } from "react";
import {
  AlarmClock,
  ChevronDown,
  ChevronRight,
  Mail,
  Receipt,
  XCircle,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  apiFetch,
  Badge,
  EmptyState,
  FormRow,
  SegmentedControl,
  Section,
  useAdminMutation,
  useAdminQuery,
  type Option,
} from "./ui";
import { ConfirmDialog } from "./ui";

// D15 — email template copy editor. Per template + locale, override the compiled
// subject/preheader/badge/heading/body/cta. Blank field = use the default. {n}
// is the days-left placeholder (valid only in reminder templates).

type Variant = {
  subject: string;
  preheader: string;
  badge: string;
  heading: string;
  body: string[];
  cta: string;
};
type Tpl = {
  templateKey: string;
  locale: "id" | "en";
  default: Variant;
  override: Partial<Variant> | null;
};
type Resp = { templates: Tpl[] };

const LABELS: Record<string, string> = {
  trialReminder: "Trial — pengingat",
  trialLastDay: "Trial — hari terakhir",
  trialExpired: "Trial — sudah berakhir",
  subReminder: "Langganan — pengingat",
  subExpired: "Langganan — sudah berakhir",
  paymentReceipt: "Struk pembayaran",
};

// Per-field max length — mirrors the zod schema in route.ts so the client blocks
// over-length before the server rejects it.
const MAX_SUBJECT = 300;
const MAX_PREHEADER = 400;
const MAX_BADGE = 80;
const MAX_HEADING = 300;
const MAX_CTA = 80;
const MAX_BODY_PARAGRAPH = 2000;
const MAX_BODY_PARAGRAPHS = 8;

// Templates where the {n} (sisa hari) placeholder is meaningful.
const REMINDER_KEYS = new Set(["trialReminder", "trialLastDay", "subReminder"]);

const LOCALE_OPTIONS: Option<"id" | "en">[] = [
  { value: "id", label: "ID" },
  { value: "en", label: "EN" },
];

function tplIcon(key: string) {
  if (key === "paymentReceipt") return <Receipt className="size-3.5" />;
  if (key.endsWith("Expired")) return <XCircle className="size-3.5" />;
  if (REMINDER_KEYS.has(key)) return <AlarmClock className="size-3.5" />;
  return <Mail className="size-3.5" />;
}

export function EmailTemplatesEditor() {
  const [locale, setLocale] = useState<"id" | "en">("id");
  const { data, isLoading, error } = useAdminQuery<Resp>(
    ["admin", "email-templates"],
    "/api/admin/email-templates",
  );

  const rows = (data?.templates ?? []).filter((t) => t.locale === locale);

  return (
    <Section
      title="Template email"
      desc="Ganti teks email trial, perpanjangan & struk pembayaran. Kosongkan field untuk pakai teks bawaan. {n} = sisa hari (hanya di template pengingat)."
      actions={
        <SegmentedControl
          value={locale}
          onChange={setLocale}
          options={LOCALE_OPTIONS}
          size="sm"
        />
      }
    >
      {isLoading ? (
        <p className="text-sm text-zinc-500">Memuat…</p>
      ) : error || !data ? (
        <EmptyState
          icon={<Mail className="size-8" />}
          title="Gagal memuat template"
          body="Coba muat ulang halaman. Jika tetap gagal, cek log server."
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={<Mail className="size-8" />}
          title="Tidak ada template"
          body="Tidak ada template untuk locale ini."
        />
      ) : (
        <div className="space-y-2.5">
          {rows.map((t) => (
            <TemplateCard key={`${t.templateKey}:${t.locale}`} tpl={t} />
          ))}
        </div>
      )}
    </Section>
  );
}

function TemplateCard({ tpl }: { tpl: Tpl }) {
  const ov = tpl.override ?? {};
  // Prefill from override; placeholder shows the default so the editor sees both.
  const [subject, setSubject] = useState(ov.subject ?? "");
  const [preheader, setPreheader] = useState(ov.preheader ?? "");
  const [badge, setBadge] = useState(ov.badge ?? "");
  const [heading, setHeading] = useState(ov.heading ?? "");
  const [body, setBody] = useState((ov.body ?? []).join("\n\n"));
  const [cta, setCta] = useState(ov.cta ?? "");
  const [open, setOpen] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const invalidate = ["admin", "email-templates"];
  const label = LABELS[tpl.templateKey] ?? tpl.templateKey;
  const localeUpper = tpl.locale.toUpperCase();
  const isReminder = REMINDER_KEYS.has(tpl.templateKey);

  const paragraphs = body.split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const tooManyParagraphs = paragraphs.length > MAX_BODY_PARAGRAPHS;
  const longParagraph = paragraphs.some((p) => p.length > MAX_BODY_PARAGRAPH);
  const overLimit =
    subject.length > MAX_SUBJECT ||
    preheader.length > MAX_PREHEADER ||
    badge.length > MAX_BADGE ||
    heading.length > MAX_HEADING ||
    cta.length > MAX_CTA ||
    tooManyParagraphs ||
    longParagraph;

  const save = useAdminMutation<void>(
    () =>
      apiFetch("/api/admin/email-templates", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          templateKey: tpl.templateKey,
          locale: tpl.locale,
          fields: {
            subject,
            preheader,
            badge,
            heading,
            body: paragraphs,
            cta,
          },
        }),
      }),
    { successMessage: "Template tersimpan.", invalidate: [invalidate] },
  );

  const reset = useAdminMutation<void>(
    () =>
      apiFetch(
        `/api/admin/email-templates?templateKey=${tpl.templateKey}&locale=${tpl.locale}`,
        { method: "DELETE" },
      ),
    {
      successMessage: "Template direset ke bawaan.",
      invalidate: [invalidate],
      onSuccess: () => {
        setSubject("");
        setPreheader("");
        setBadge("");
        setHeading("");
        setBody("");
        setCta("");
        setConfirmReset(false);
      },
    },
  );

  const d = tpl.default;
  const customized = !!tpl.override;

  const insertDaysToken = () => {
    setBody((prev) => (prev ? `${prev} {n}` : "{n}"));
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-2.5 text-left"
      >
        <span className="text-zinc-500">{tplIcon(tpl.templateKey)}</span>
        <span className="text-sm font-medium text-zinc-200">{label}</span>
        <Badge tone={customized ? "info" : "muted"}>
          {customized ? "diubah" : "bawaan"}
        </Badge>
        <span className="ml-auto text-zinc-500">
          {open ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-zinc-800 px-3 py-3">
          <CountedField
            label="Subject"
            value={subject}
            onChange={setSubject}
            placeholder={d.subject}
            max={MAX_SUBJECT}
            defaultHint={d.subject}
          />
          <CountedField
            label="Preheader"
            value={preheader}
            onChange={setPreheader}
            placeholder={d.preheader}
            max={MAX_PREHEADER}
            defaultHint={d.preheader}
          />
          <CountedField
            label="Badge"
            value={badge}
            onChange={setBadge}
            placeholder={d.badge}
            max={MAX_BADGE}
            defaultHint={d.badge}
          />
          <CountedField
            label="Heading"
            value={heading}
            onChange={setHeading}
            placeholder={d.heading}
            max={MAX_HEADING}
            defaultHint={d.heading}
          />

          <FormRow
            label="Isi (paragraf dipisah baris kosong)"
            help={`bawaan: ${d.body.join(" / ")}`}
            error={
              tooManyParagraphs
                ? `Maks ${MAX_BODY_PARAGRAPHS} paragraf — ada ${paragraphs.length}.`
                : longParagraph
                  ? `Satu paragraf melebihi ${MAX_BODY_PARAGRAPH} karakter.`
                  : null
            }
          >
            <textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={5}
              placeholder={d.body.join("\n\n")}
              className={cn(
                "w-full rounded-md border bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:ring-2 focus:ring-cyan-500/30",
                tooManyParagraphs || longParagraph
                  ? "border-red-500/50 focus:border-red-500/50"
                  : "border-zinc-700 focus:border-cyan-500/50",
              )}
            />
            <div className="flex items-center justify-between gap-2 pt-0.5">
              <span
                className={cn(
                  "text-[11px]",
                  tooManyParagraphs ? "text-red-400" : "text-zinc-500",
                )}
              >
                paragraf {paragraphs.length}/{MAX_BODY_PARAGRAPHS}
              </span>
              {isReminder && (
                <button
                  type="button"
                  onClick={insertDaysToken}
                  className="rounded border border-zinc-700 px-1.5 py-0.5 text-[11px] text-zinc-400 transition hover:border-cyan-500/40 hover:text-cyan-300"
                >
                  Sisipkan {"{n}"}
                </button>
              )}
            </div>
          </FormRow>

          <CountedField
            label="Tombol (CTA)"
            value={cta}
            onChange={setCta}
            placeholder={d.cta}
            max={MAX_CTA}
            defaultHint={d.cta}
          />

          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              disabled={save.isPending || overLimit}
              onClick={() => save.mutate()}
              className="rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-50"
            >
              {save.isPending ? "Menyimpan…" : "Simpan"}
            </button>
            {customized && (
              <button
                type="button"
                disabled={reset.isPending}
                onClick={() => setConfirmReset(true)}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition hover:border-zinc-500 disabled:opacity-50"
              >
                Reset ke bawaan
              </button>
            )}
            {overLimit && (
              <span className="text-[11px] text-red-400">
                Perbaiki field yang melebihi batas dulu.
              </span>
            )}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmReset}
        onCancel={() => setConfirmReset(false)}
        onConfirm={() => reset.mutate()}
        title="Reset template ke bawaan?"
        body={
          <>
            Override untuk template <span className="font-medium text-zinc-200">{label} ({localeUpper})</span> akan dihapus dan email kembali pakai teks default.
          </>
        }
        confirmLabel="Reset"
        cancelLabel="Batal"
        danger
        loading={reset.isPending}
      />
    </div>
  );
}

function CountedField({
  label,
  value,
  onChange,
  placeholder,
  max,
  defaultHint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  max: number;
  defaultHint: string;
}) {
  const over = value.length > max;
  return (
    <FormRow
      label={label}
      help={defaultHint ? `bawaan: ${defaultHint}` : undefined}
      error={over ? `Maks ${max} karakter.` : null}
    >
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(
          "w-full rounded-md border bg-zinc-900 px-2.5 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:ring-2 focus:ring-cyan-500/30",
          over
            ? "border-red-500/50 focus:border-red-500/50"
            : "border-zinc-700 focus:border-cyan-500/50",
        )}
      />
      <div className="pt-0.5 text-right">
        <span className={cn("text-[11px]", over ? "text-red-400" : "text-zinc-500")}>
          {value.length}/{max}
        </span>
      </div>
    </FormRow>
  );
}
