"use client";

/**
 * CronTimezonePicker — auto-detect dari browser + dropdown pilihan
 * IANA timezone umum (Indonesia + global).
 *
 * Default: kalau tz kosong, auto-set ke timezone browser user. User bisa
 * pencet "Ubah" untuk pilih dari daftar atau ketik custom.
 *
 * Engine `schedule.tz` adalah IANA timezone string. Engine tetep accept
 * undefined (pake server default), tapi kita warning kalau user pilih itu
 * karena "0 8 * * *" tanpa tz akan jalan di tz server, bukan tz user.
 */
import { Globe, ChevronDown, X, Check } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";

const TZ_GROUPS: Array<{ label: string; options: Array<{ value: string; label: string; hint?: string }> }> = [
  {
    label: "🇮🇩 Indonesia",
    options: [
      { value: "Asia/Jakarta", label: "Asia/Jakarta", hint: "WIB · GMT+7" },
      { value: "Asia/Pontianak", label: "Asia/Pontianak", hint: "WIB · GMT+7" },
      { value: "Asia/Makassar", label: "Asia/Makassar", hint: "WITA · GMT+8" },
      { value: "Asia/Jayapura", label: "Asia/Jayapura", hint: "WIT · GMT+9" },
    ],
  },
  {
    label: "🌐 Asia",
    options: [
      { value: "Asia/Singapore", label: "Asia/Singapore", hint: "SGT · GMT+8" },
      { value: "Asia/Kuala_Lumpur", label: "Asia/Kuala_Lumpur", hint: "MYT · GMT+8" },
      { value: "Asia/Bangkok", label: "Asia/Bangkok", hint: "ICT · GMT+7" },
      { value: "Asia/Hong_Kong", label: "Asia/Hong_Kong", hint: "HKT · GMT+8" },
      { value: "Asia/Tokyo", label: "Asia/Tokyo", hint: "JST · GMT+9" },
      { value: "Asia/Shanghai", label: "Asia/Shanghai", hint: "CST · GMT+8" },
    ],
  },
  {
    label: "🌍 Internasional",
    options: [
      { value: "UTC", label: "UTC", hint: "GMT+0" },
      { value: "Europe/London", label: "Europe/London", hint: "GMT/BST" },
      { value: "Europe/Berlin", label: "Europe/Berlin", hint: "CET/CEST" },
      { value: "America/New_York", label: "America/New_York", hint: "ET" },
      { value: "America/Los_Angeles", label: "America/Los_Angeles", hint: "PT" },
      { value: "Australia/Sydney", label: "Australia/Sydney", hint: "AET" },
    ],
  },
];

export function getDefaultTimezone(): string {
  if (typeof Intl === "undefined") return "Asia/Jakarta";
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || "Asia/Jakarta";
  } catch {
    return "Asia/Jakarta";
  }
}

export function CronTimezonePicker({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (next: string | undefined) => void;
}) {
  const detected = useMemo(() => getDefaultTimezone(), []);
  const [mode, setMode] = useState<"info" | "select" | "custom">("info");
  const [customDraft, setCustomDraft] = useState("");

  // Auto-fill detected tz on first mount kalau kosong — biar "jam 8 pagi"
  // beneran 8 pagi di tz user, bukan tz server container.
  useEffect(() => {
    if (!value) onChange(detected);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const effective = value || detected;
  const isAutoDetected = !value || value === detected;
  const isInCommonList = useMemo(
    () => TZ_GROUPS.some((g) => g.options.some((o) => o.value === effective)),
    [effective],
  );

  return (
    <div>
      <div className="mb-1 flex items-baseline gap-1 font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
        <Globe className="size-3" aria-hidden />
        Zona waktu
      </div>

      {mode === "info" ? (
        <button
          type="button"
          onClick={() => setMode("select")}
          className="group flex w-full items-center justify-between gap-3 rounded-lg border border-cyan-400/20 bg-cyan-400/[0.04] px-3 py-2 text-left transition hover:border-cyan-400/40 hover:bg-cyan-400/[0.06]"
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 truncate font-mono text-[13px] font-semibold text-cyan-100">
              <span aria-hidden>🌐</span>
              {effective}
            </div>
            <p className="mt-0.5 text-[10px] leading-snug text-white/55">
              {isAutoDetected
                ? "Otomatis terdeteksi dari browser kamu — jadi 'jam 8 pagi' beneran jam 8 di tempat kamu."
                : `Manual override. (Browser kamu di ${detected})`}
            </p>
          </div>
          <span className="shrink-0 rounded-md border border-white/15 bg-white/[0.04] px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.18em] text-white/70 group-hover:border-cyan-400/40 group-hover:text-cyan-200">
            Ubah
          </span>
        </button>
      ) : null}

      {mode === "select" ? (
        <div className="rounded-lg border border-white/10 bg-white/[0.02]">
          <div className="flex items-center justify-between gap-2 border-b border-white/[0.06] px-3 py-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
              Pilih zona waktu
            </span>
            <button
              type="button"
              onClick={() => setMode("info")}
              aria-label="Tutup"
              className="rounded p-1 text-white/55 hover:bg-white/[0.05] hover:text-white"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
          <div className="max-h-72 overflow-y-auto px-2 py-2">
            {/* Auto option */}
            <TzRow
              label={`Otomatis (${detected})`}
              hint="Pakai timezone browser kamu"
              active={isAutoDetected}
              onClick={() => {
                onChange(detected);
                setMode("info");
              }}
            />

            {/* Common groups */}
            {TZ_GROUPS.map((group) => (
              <div key={group.label} className="mt-2">
                <div className="px-2 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-white/40">
                  {group.label}
                </div>
                {group.options.map((opt) => (
                  <TzRow
                    key={opt.value}
                    label={opt.label}
                    hint={opt.hint}
                    active={value === opt.value}
                    onClick={() => {
                      onChange(opt.value);
                      setMode("info");
                    }}
                  />
                ))}
              </div>
            ))}

            {/* Server default option (advanced — engine uses container tz) */}
            <div className="mt-2">
              <div className="px-2 py-1 font-mono text-[9px] uppercase tracking-[0.18em] text-white/40">
                Lainnya
              </div>
              <TzRow
                label="Server default"
                hint="ADVANCED · pakai timezone engine (Asia/Jakarta · WIB)"
                active={value === ""}
                onClick={() => {
                  onChange(undefined);
                  setMode("info");
                }}
              />
              <TzRow
                label={isInCommonList ? "Custom..." : `Custom (${effective})`}
                hint="IANA timezone manual (mis. Pacific/Auckland)"
                active={!isInCommonList && !!value}
                onClick={() => {
                  setCustomDraft(value ?? "");
                  setMode("custom");
                }}
              />
            </div>
          </div>
        </div>
      ) : null}

      {mode === "custom" ? (
        <div className="rounded-lg border border-white/10 bg-white/[0.02] px-3 py-2">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/55">
              IANA timezone custom
            </span>
            <button
              type="button"
              onClick={() => setMode("select")}
              className="rounded p-1 text-white/55 hover:bg-white/[0.05] hover:text-white"
            >
              <X className="size-3.5" aria-hidden />
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={customDraft}
              onChange={(e) => setCustomDraft(e.target.value)}
              placeholder="Pacific/Auckland"
              className="flex-1 rounded-md border border-white/10 bg-black/40 px-3 py-1.5 font-mono text-[13px] text-white focus:border-cyan-400/50 focus:outline-none"
            />
            <button
              type="button"
              onClick={() => {
                const v = customDraft.trim();
                if (v) onChange(v);
                else onChange(undefined);
                setMode("info");
              }}
              className="inline-flex items-center gap-1 rounded-md bg-gradient-to-r from-cyan-400 to-fuchsia-500 px-3 py-1.5 font-mono text-[10px] font-bold uppercase tracking-[0.16em] text-[#0B0E14] hover:brightness-110"
            >
              <Check className="size-3" aria-hidden />
              Pakai
            </button>
          </div>
          <p className="mt-1 text-[10px] text-white/45">
            Format IANA database. Contoh:{" "}
            <code className="text-cyan-200">Asia/Jakarta</code>,{" "}
            <code className="text-cyan-200">Pacific/Auckland</code>,{" "}
            <code className="text-cyan-200">America/Sao_Paulo</code>.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function TzRow({
  label,
  hint,
  active,
  onClick,
}: {
  label: string;
  hint?: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left transition",
        active
          ? "bg-cyan-400/15 text-cyan-100"
          : "text-white/85 hover:bg-white/[0.04]",
      )}
    >
      <div className="min-w-0">
        <div className="truncate font-mono text-[12px] font-semibold">
          {label}
        </div>
        {hint ? (
          <div className="truncate text-[10px] leading-tight text-white/45">
            {hint}
          </div>
        ) : null}
      </div>
      {active ? (
        <Check className="size-3.5 shrink-0 text-cyan-300" aria-hidden />
      ) : null}
    </button>
  );
}
