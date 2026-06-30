"use client";

import type { ReactNode } from "react";
import { Info, AlertTriangle, Inbox } from "lucide-react";
import { cn } from "@/lib/utils";
import { type Tone, TONE_BADGE, TONE_DOT } from "./enums";

// --- Fetch + format helpers (moved from the old ui.tsx; signatures preserved
// so existing imports keep working through ui/index.ts). ---

export async function apiFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { error?: string; message?: string };
      detail = body.error || body.message || detail;
    } catch {
      /* non-JSON body — keep the HTTP code */
    }
    throw new Error(detail);
  }
  return res.json() as Promise<T>;
}

export function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
}

export function fmtDateTime(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function str(v: unknown): string | null {
  if (v === null || v === undefined || v === "") return null;
  return String(v);
}

// --- Badges ---

export function Badge({ children, tone = "muted" }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-md px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
        TONE_BADGE[tone],
      )}
    >
      {children}
    </span>
  );
}

export type StatusMap = Record<string, { tone: Tone; label: string; hint?: string }>;

/** Badge driven by a central enum->tone+label map. Unknown values render muted
 *  with the raw value so nothing is silently hidden. */
export function StatusBadge({ value, map }: { value: string | null | undefined; map: StatusMap }) {
  if (!value) return <span className="text-zinc-600">—</span>;
  const e = map[value];
  return (
    <span title={e?.hint} className="inline-flex items-center gap-1">
      <span className={cn("size-1.5 rounded-full", TONE_DOT[e?.tone ?? "muted"])} />
      <Badge tone={e?.tone ?? "muted"}>{e?.label ?? value}</Badge>
    </span>
  );
}

// --- Card / section ---

export function Section({
  title,
  desc,
  actions,
  children,
  className,
}: {
  title?: string;
  desc?: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("rounded-xl border border-zinc-800 bg-zinc-900/40", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-zinc-800 px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>}
            {desc && <p className="mt-0.5 text-xs text-zinc-400">{desc}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className="p-4">{children}</div>
    </section>
  );
}

// --- Read-only key/value detail (replaces DRow stacks) ---

export function KeyValueGrid({
  items,
  cols = 1,
}: {
  items: { label: string; value: ReactNode; tone?: Tone }[];
  cols?: 1 | 2;
}) {
  return (
    <dl className={cn("grid gap-x-6 gap-y-1", cols === 2 ? "sm:grid-cols-2" : "grid-cols-1")}>
      {items.map((it, i) => (
        <div key={i} className="flex items-baseline justify-between gap-3 py-1 text-sm">
          <dt className="shrink-0 text-zinc-500">{it.label}</dt>
          <dd className="text-right font-medium text-zinc-200">{it.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Back-compat single row (old DRow). Prefer KeyValueGrid for new code. */
export function DRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex justify-between gap-3 py-1 text-sm">
      <span className="shrink-0 text-zinc-500">{label}</span>
      <span className="text-right text-zinc-200">{value ?? "—"}</span>
    </div>
  );
}

// --- TabIntro: the "what is this / what can I do / how" header every tab gets ---

export type LegendItem = { tone: Tone; label: string };

export function TabIntro({
  eyebrow,
  title,
  what,
  canDo,
  how,
  legend,
  warning,
}: {
  eyebrow?: string;
  title: string;
  what: string;
  canDo?: string[];
  how?: string;
  legend?: LegendItem[];
  warning?: string;
}) {
  return (
    <div className="mb-5 rounded-xl border border-zinc-800 bg-gradient-to-b from-zinc-900/70 to-zinc-900/20 p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {eyebrow && (
            <div className="font-mono text-[10px] font-medium uppercase tracking-[0.2em] text-cyan-400">
              {eyebrow}
            </div>
          )}
          <h1 className="mt-0.5 text-lg font-semibold text-zinc-100">{title}</h1>
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">{what}</p>
        </div>
        {legend && legend.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2">
            {legend.map((l, i) => (
              <span key={i} className="inline-flex items-center gap-1.5 text-[11px] text-zinc-400">
                <span className={cn("size-1.5 rounded-full", TONE_DOT[l.tone])} />
                {l.label}
              </span>
            ))}
          </div>
        )}
      </div>

      {(canDo?.length || how) && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {canDo && canDo.length > 0 && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                Yang bisa kamu lakukan
              </div>
              <ul className="space-y-0.5 text-xs text-zinc-400">
                {canDo.map((c, i) => (
                  <li key={i} className="flex gap-1.5">
                    <span className="text-cyan-400">•</span>
                    <span>{c}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {how && (
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="mb-1 inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                <Info className="size-3" /> Cara pakai
              </div>
              <p className="text-xs leading-relaxed text-zinc-400">{how}</p>
            </div>
          )}
        </div>
      )}

      {warning && (
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>{warning}</span>
        </div>
      )}
    </div>
  );
}

// --- Empty state ---

export function EmptyState({
  icon,
  title,
  body,
  action,
}: {
  icon?: ReactNode;
  title: string;
  body?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-4 py-12 text-center">
      <div className="text-zinc-700">{icon ?? <Inbox className="size-8" />}</div>
      <div className="text-sm font-medium text-zinc-300">{title}</div>
      {body && <p className="max-w-sm text-xs text-zinc-500">{body}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

// --- RoleGate: wrap admin-only actions; render disabled + tooltip for support ---

export function RoleGate({
  need = "admin",
  role,
  children,
  fallbackTitle = "Khusus admin",
}: {
  need?: string;
  role: string;
  children: ReactNode;
  fallbackTitle?: string;
}) {
  if (role === need || role === "admin") return <>{children}</>;
  return (
    <span title={fallbackTitle} className="inline-flex cursor-not-allowed opacity-40 [&_*]:pointer-events-none">
      {children}
    </span>
  );
}
