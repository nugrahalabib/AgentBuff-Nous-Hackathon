"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import {
  Section,
  Badge,
  FormRow,
  Combobox,
  SegmentedControl,
  SaveBar,
  EmptyState,
  useAdminQuery,
  useAdminMutation,
  apiFetch,
  type Option,
} from "./ui";

// D6 — per-tier engine defaults editor. Model + lean-engine + auto-update per
// subscription tier, plus a global default timezone. "Pakai default" / blank =
// use the env default (saving deletes the override). Applies on the next
// provision/restart. Restyled to the dark kit; data layer + wire shapes
// (PUT /api/admin/engine-defaults, tri-state wire "default"/true/false) unchanged.

type EngineData = {
  overrides: Record<
    string,
    { model?: string; leanEngine?: boolean; autoUpdate?: boolean }
  >;
  timezone: string;
  defaults: {
    model: string;
    timezone: string;
    leanEngine: boolean;
    autoUpdate: boolean;
  };
};

const TIERS: { id: string; label: string }[] = [
  { id: "starter", label: "Starter (gratis)" },
  { id: "op_buff", label: "OP Buff" },
  { id: "guild_master", label: "Guild Master" },
];

// Tri-state: "" = pakai default (route deletes override), "on" = true, "off" = false.
type Tri = "" | "on" | "off";
type EngineForm = { model: string; leanEngine: Tri; autoUpdate: Tri };

const triFromBool = (v: boolean | undefined): Tri =>
  v === undefined ? "" : v ? "on" : "off";
// "" -> "default" (route deletes the override). on/off -> boolean.
const triToWire = (t: Tri): boolean | "default" =>
  t === "" ? "default" : t === "on";

// A model id like "google/gemini-2.5-flash" or "anthropic/claude-opus-4-8". No
// spaces; engine validates the rest. Mirrors MODEL_RE in the route.
const MODEL_RE = /^[\w.\-/:]{1,100}$/;

// Curated default-model suggestions; Combobox allowCustom keeps free entry open.
const MODEL_OPTIONS: Option[] = [
  { value: "google/gemini-2.5-flash", label: "google/gemini-2.5-flash", hint: "Cepat & murah" },
  { value: "google/gemini-2.5-pro", label: "google/gemini-2.5-pro", hint: "Lebih pintar" },
  { value: "deepseek/deepseek-chat", label: "deepseek/deepseek-chat" },
  { value: "qwen/qwen-max", label: "qwen/qwen-max" },
  { value: "moonshotai/kimi-k2", label: "moonshotai/kimi-k2" },
];

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// Timezone list from the platform, biased Asia/* first with a live UTC offset.
function buildTimezoneOptions(): Option[] {
  let zones: string[] = [];
  try {
    const sv = (
      Intl as unknown as { supportedValuesOf?: (k: string) => string[] }
    ).supportedValuesOf;
    zones = typeof sv === "function" ? sv("timeZone") : [];
  } catch {
    zones = [];
  }
  if (zones.length === 0)
    zones = ["Asia/Jakarta", "Asia/Makassar", "Asia/Jayapura", "UTC"];
  const asia = zones.filter((z) => z.startsWith("Asia/"));
  const rest = zones.filter((z) => !z.startsWith("Asia/"));
  return [...asia, ...rest].map((z) => ({
    value: z,
    label: z,
    hint: offsetHint(z),
  }));
}

function offsetHint(tz: string): string | undefined {
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      timeZoneName: "shortOffset",
    }).formatToParts(new Date());
    return parts.find((p) => p.type === "timeZoneName")?.value;
  } catch {
    return undefined;
  }
}

export function EngineDefaultsForm() {
  const { data, isLoading, error } = useAdminQuery<EngineData>(
    ["admin", "engine-defaults"],
    "/api/admin/engine-defaults",
  );

  if (isLoading)
    return (
      <Section title="Engine default per tier" desc="Memuat…">
        <div className="text-sm text-zinc-500">Memuat…</div>
      </Section>
    );
  if (error || !data)
    return (
      <Section
        title="Engine default per tier"
        desc="Model, lean-engine, dan auto-update mesin per tier langganan."
      >
        <EmptyState
          title="Gagal memuat engine defaults"
          body="Coba muat ulang halaman."
        />
      </Section>
    );
  return <Form initial={data} />;
}

function Form({ initial }: { initial: EngineData }) {
  const [engine, setEngine] = useState<Record<string, EngineForm>>(() => {
    const out: Record<string, EngineForm> = {};
    for (const t of TIERS) {
      const o = initial.overrides[t.id];
      out[t.id] = {
        model: o?.model ?? "",
        leanEngine: triFromBool(o?.leanEngine),
        autoUpdate: triFromBool(o?.autoUpdate),
      };
    }
    return out;
  });
  const [timezone, setTimezone] = useState(initial.timezone);

  const initialEngine = useMemo<Record<string, EngineForm>>(() => {
    const out: Record<string, EngineForm> = {};
    for (const t of TIERS) {
      const o = initial.overrides[t.id];
      out[t.id] = {
        model: o?.model ?? "",
        leanEngine: triFromBool(o?.leanEngine),
        autoUpdate: triFromBool(o?.autoUpdate),
      };
    }
    return out;
  }, [initial.overrides]);

  const tzOptions = useMemo(() => buildTimezoneOptions(), []);
  const d = initial.defaults;

  const set = (tier: string, field: keyof EngineForm, value: string) => {
    setEngine((prev) => ({
      ...prev,
      [tier]: { ...prev[tier], [field]: value },
    }));
  };

  const dirty =
    timezone.trim() !== initial.timezone.trim() ||
    TIERS.some((t) => {
      const a = engine[t.id];
      const b = initialEngine[t.id];
      return (
        a.model.trim() !== b.model.trim() ||
        a.leanEngine !== b.leanEngine ||
        a.autoUpdate !== b.autoUpdate
      );
    });

  const modelInvalid = TIERS.some((t) => {
    const v = engine[t.id].model.trim();
    return v !== "" && !MODEL_RE.test(v);
  });
  const tzInvalid = timezone.trim() !== "" && !isValidTimezone(timezone.trim());
  const canSave = dirty && !modelInvalid && !tzInvalid;

  const save = useAdminMutation<void, { ok: boolean }>(
    () =>
      apiFetch<{ ok: boolean }>("/api/admin/engine-defaults", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          engine: Object.fromEntries(
            TIERS.map((t) => [
              t.id,
              {
                model: engine[t.id].model.trim(),
                leanEngine: triToWire(engine[t.id].leanEngine),
                autoUpdate: triToWire(engine[t.id].autoUpdate),
              },
            ]),
          ),
          timezone: timezone.trim(),
        }),
      }),
    {
      successMessage:
        "Tersimpan. Berlaku saat provision/restart kontainer berikutnya.",
      invalidate: [["admin", "engine-defaults"]],
    },
  );

  const reset = () => {
    setEngine(initialEngine);
    setTimezone(initial.timezone);
  };

  const leanOptions: Option<Tri>[] = [
    { value: "", label: `Default (${d.leanEngine ? "Vanilla" : "Plugin"})` },
    { value: "on", label: "Vanilla", hint: "Mesin inti, ringan" },
    { value: "off", label: "Plugin lengkap", hint: "Semua kemampuan aktif" },
  ];
  const autoOptions: Option<Tri>[] = [
    { value: "", label: `Default (${d.autoUpdate ? "On" : "Off"})` },
    { value: "on", label: "On" },
    { value: "off", label: "Off" },
  ];

  return (
    <Section
      title="Engine default per tier"
      desc="Model, mode lean, dan auto-update mesin per tier langganan, plus timezone default global. Kosong / Default = ikut env."
    >
      <div className="space-y-5">
        <p className="text-xs leading-relaxed text-zinc-400">
          Default env: model{" "}
          <span className="font-medium text-zinc-300">{d.model}</span>, lean{" "}
          {d.leanEngine ? "Vanilla" : "Plugin"}, auto-update{" "}
          {d.autoUpdate ? "On" : "Off"}. Perubahan berlaku saat kontainer
          di-provision / restart berikutnya — untuk yang sudah jalan, re-provision
          dari{" "}
          <Link
            href="/admin/kontainer"
            className="text-cyan-400 hover:underline"
          >
            menu Kontainer
          </Link>
          . Key provider (BYOK) tidak diatur di sini.
        </p>

        <div className="flex items-center gap-2">
          <Badge tone="warn">Berlaku saat provision/restart</Badge>
        </div>

        <div className="grid gap-3 md:grid-cols-3">
          {TIERS.map((t) => {
            const f = engine[t.id];
            const mv = f.model.trim();
            const modelErr =
              mv !== "" && !MODEL_RE.test(mv)
                ? "Tanpa spasi; contoh google/gemini-2.5-flash."
                : null;
            return (
              <div
                key={t.id}
                className="space-y-3 rounded-lg border border-zinc-800 bg-zinc-900/40 p-3"
              >
                <div className="text-xs font-semibold uppercase tracking-wide text-zinc-400">
                  {t.label}
                </div>

                <FormRow
                  label="Model"
                  help="Kosong = pakai default env."
                  error={modelErr}
                >
                  <Combobox<string>
                    value={f.model}
                    onChange={(v) => set(t.id, "model", v)}
                    options={MODEL_OPTIONS}
                    allowCustom
                    placeholder={d.model}
                    emptyText="Ketik model kustom lalu Enter"
                  />
                </FormRow>

                <FormRow label="Lean engine">
                  <SegmentedControl<Tri>
                    value={f.leanEngine}
                    onChange={(v) => set(t.id, "leanEngine", v)}
                    options={leanOptions}
                    size="sm"
                  />
                </FormRow>

                <FormRow label="Auto-update">
                  <SegmentedControl<Tri>
                    value={f.autoUpdate}
                    onChange={(v) => set(t.id, "autoUpdate", v)}
                    options={autoOptions}
                    size="sm"
                  />
                </FormRow>
              </div>
            );
          })}
        </div>

        <div className="border-t border-zinc-800 pt-4">
          <FormRow
            label="Timezone default (global)"
            help="Zona waktu untuk user yang belum set saat onboarding. Timezone per-user tetap menang. Kosong = pakai default env."
            error={
              tzInvalid ? "Timezone IANA tidak valid (mis. Asia/Jakarta)." : null
            }
          >
            <div className="max-w-xs">
              <Combobox<string>
                value={timezone}
                onChange={setTimezone}
                options={tzOptions}
                allowCustom
                placeholder={d.timezone}
                emptyText="Ketik zona waktu lalu Enter"
              />
            </div>
          </FormRow>
        </div>

        <SaveBar
          dirty={dirty}
          saving={save.isPending}
          onSave={() => {
            if (canSave) save.mutate();
          }}
          onReset={reset}
          message={
            modelInvalid || tzInvalid
              ? "Ada isian belum valid — periksa field bertanda merah."
              : "Ada perubahan belum disimpan. Berlaku saat provision/restart kontainer."
          }
        />
      </div>
    </Section>
  );
}
