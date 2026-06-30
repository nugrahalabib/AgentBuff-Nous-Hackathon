"use client";

/**
 * Detail Engine — Zone 7.
 *
 * `<details>` collapsible default closed. Technical engine state for power
 * users. Mass-market users don't need to open this.
 *
 * Sources (Hermes bridge only — the OpenClaw `status`, `health.heartbeatSeconds`
 * and `model.auth.status` RPCs do NOT exist on this bridge and were removed):
 * - Engine info: version + uptime from the connect snapshot (store).
 * - Quest Otomatis summary: `cron.list` RPC.
 * - BYOK keys: managed in the dedicated Providers tab (linked, not duplicated).
 */
import { ChevronRight, KeyRound } from "lucide-react";
import { useRouter } from "next/navigation";
import { useAppStore } from "@/lib/app/store";
import { useRpc } from "@/lib/app/use-rpc";
import { useI18n } from "@/lib/i18n/context";
import { formatUptimeShort } from "./helpers";
import { cn } from "@/lib/utils";

type CronJobSummary = {
  state?: { lastStatus?: string; nextRunAtMs?: number };
};

type CronListResult = {
  jobs?: CronJobSummary[];
  nextWakeAtMs?: number;
};

export function DetailEngine() {
  const { t } = useI18n();

  // Engine snapshot from store (populated via proxy.ready connect payload).
  // Source of truth for uptime + version — no extra RPC. uptime now =
  // uptimeMs + (now - receivedAt), since uptime grows monotonically.
  const engineSnap = useAppStore((s) => s.engineSnapshot);
  const cron = useRpc<CronListResult>({ method: "cron.list" });

  const liveUptimeMs = (() => {
    if (!engineSnap?.uptimeMs) return null;
    const sinceReceived = Date.now() - new Date(engineSnap.receivedAt).getTime();
    return engineSnap.uptimeMs + Math.max(0, sinceReceived);
  })();

  const runtimeVersion = engineSnap?.runtimeVersion ?? null;

  return (
    <details
      id="detail-engine"
      className="group rounded-2xl border border-white/[0.06] bg-[#0B0E14]/40 backdrop-blur-xl"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 transition hover:bg-white/[0.02]">
        <span className="font-mono text-[10px] font-semibold uppercase tracking-[0.24em] text-white/55">
          {t.app.overview.detailEngine.toggleLabel}
        </span>
        <ChevronRight
          aria-hidden
          className="size-3.5 text-white/40 transition-transform group-open:rotate-90"
        />
      </summary>

      <div className="grid grid-cols-1 gap-3 border-t border-white/[0.04] p-4 md:grid-cols-2">
        <InfoRow
          label={t.app.overview.detailEngine.versionLabel}
          value={runtimeVersion ?? "—"}
        />
        <InfoRow
          label={t.app.overview.detailEngine.uptimeLabel}
          value={liveUptimeMs != null ? formatUptimeShort(liveUptimeMs) : "—"}
        />
      </div>

      {/* Providers (BYOK) — managed in the dedicated tab, not duplicated here. */}
      <ProvidersLink />

      {/* Cron summary */}
      <CronSection data={cron.data} loading={cron.loading} />
    </details>
  );
}

function ProvidersLink() {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <section className="border-t border-white/[0.04] p-4">
      <button
        type="button"
        onClick={() => router.push("/app/providers")}
        className="flex w-full items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2.5 text-left transition hover:border-cyan-400/30 hover:bg-white/[0.04]"
      >
        <span className="flex items-center gap-2 text-[12px] text-white/80">
          <KeyRound className="size-3.5 text-cyan-300/80" aria-hidden />
          {t.app.overview.detailEngine.byokTitle}
        </span>
        <ChevronRight className="size-3.5 text-white/40" aria-hidden />
      </button>
    </section>
  );
}

function CronSection({
  data,
  loading,
}: {
  data: CronListResult | null;
  loading: boolean;
}) {
  const { t } = useI18n();
  if (loading) return null;
  if (!data) return null;

  // Server kadang return jobs sebagai primitive/number, defensive guard.
  const safeJobs = Array.isArray(data.jobs) ? data.jobs : [];
  const total = safeJobs.length;
  const failed = safeJobs.filter((j) => j.state?.lastStatus === "error").length;

  return (
    <section className="border-t border-white/[0.04] p-4">
      <h4 className="mb-2 font-mono text-[10px] font-semibold uppercase tracking-[0.18em] text-white/55">
        {t.app.overview.detailEngine.cronTitle}
      </h4>
      <div className="grid grid-cols-2 gap-3 text-[12px] sm:grid-cols-3">
        <KeyValue label={t.app.overview.detailEngine.cronJobs} value={String(total)} />
        <KeyValue
          label={t.app.overview.detailEngine.cronNextRun}
          value={
            data.nextWakeAtMs
              ? formatUptimeShort(data.nextWakeAtMs - Date.now())
              : "—"
          }
        />
        <KeyValue
          label={t.app.overview.detailEngine.cronFailed}
          value={String(failed)}
          tone={failed > 0 ? "danger" : "default"}
        />
      </div>
    </section>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-[0.18em] text-white/45">
        {label}
      </span>
      <span className="text-[12px] font-medium text-white/85">{value}</span>
    </div>
  );
}

function KeyValue({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: string;
  tone?: "default" | "danger";
}) {
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] px-3 py-2">
      <div className="font-mono text-[9px] uppercase tracking-[0.16em] text-white/40">
        {label}
      </div>
      <div
        className={cn(
          "mt-0.5 text-[13px] font-semibold",
          tone === "danger" ? "text-red-300/90" : "text-white/85",
        )}
      >
        {value}
      </div>
    </div>
  );
}
