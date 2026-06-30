"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Copy, Download, RefreshCw, ScrollText } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  EmptyState,
  SearchInput,
  SegmentedControl,
  Section,
  Toggle,
  errorToBahasa,
  useAdminQuery,
  useToast,
  type Option,
} from "./ui";

// D5 — per-container log tail panel. Sub-panel rendered inside the Fleet detail
// drawer (no TabIntro). Contract: GET /api/admin/containers/{userId}/logs?tail=N
// → { logs: string; note?: string }. Server clamps tail to [1,1000] (default 200);
// note==="no container" means no row. Read-only (admin OR support).

type LogsResp = { logs: string; note?: string };

// Tail presets — must stay within the route's MAX_TAIL=1000 clamp.
const TAIL_OPTIONS: Option<string>[] = [
  { value: "100", label: "100" },
  { value: "200", label: "200" },
  { value: "500", label: "500" },
  { value: "1000", label: "1000" },
];
const DEFAULT_TAIL = "200";
const AUTO_FOLLOW_MS = 5_000;

// Lines worth flagging when scanning a failed container.
const ERROR_LINE_RE = /error|fail|econnrefused|exception|fatal|panic/i;

export function ContainerLogs({ userId }: { userId: string }) {
  const { toast } = useToast();
  const [tail, setTail] = useState<string>(DEFAULT_TAIL);
  const [autoFollow, setAutoFollow] = useState(false);
  const [search, setSearch] = useState("");
  const preRef = useRef<HTMLPreElement>(null);

  const { data, isLoading, isError, error, refetch, isFetching } = useAdminQuery<LogsResp>(
    ["admin", "container-logs", userId, tail],
    `/api/admin/containers/${userId}/logs?tail=${tail}`,
    { refetchInterval: autoFollow ? AUTO_FOLLOW_MS : undefined },
  );

  const noContainer = data?.note === "no container";
  const rawLogs = data?.logs ?? "";

  const lines = useMemo(() => {
    const trimmed = rawLogs.trimEnd();
    if (!trimmed) return [];
    const q = search.trim().toLowerCase();
    return trimmed
      .split("\n")
      .filter((l) => (q ? l.toLowerCase().includes(q) : true));
  }, [rawLogs, search]);

  const matchCount = lines.length;
  const hasQuery = search.trim().length > 0;

  // Auto-scroll to the newest line while following.
  useEffect(() => {
    if (!autoFollow) return;
    const el = preRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [autoFollow, lines]);

  const handleCopy = async () => {
    if (!rawLogs.trim()) return;
    try {
      await navigator.clipboard.writeText(rawLogs);
      toast("Log disalin.", { tone: "ok" });
    } catch {
      toast("Gagal menyalin log.", { tone: "bad" });
    }
  };

  const handleDownload = () => {
    if (!rawLogs.trim()) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const blob = new Blob([rawLogs], { type: "text/plain" });
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = `${userId}-${stamp}.log`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(href);
  };

  const canExport = !noContainer && rawLogs.trim().length > 0;

  const actions: ReactNode = (
    <div className="flex items-center gap-1.5">
      <IconButton label="Salin log" onClick={handleCopy} disabled={!canExport} icon={<Copy className="size-3.5" />} />
      <IconButton
        label="Unduh .log"
        onClick={handleDownload}
        disabled={!canExport}
        icon={<Download className="size-3.5" />}
      />
      <button
        type="button"
        disabled={isFetching}
        onClick={() => void refetch()}
        className="inline-flex items-center gap-1 rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 transition hover:border-zinc-500 hover:text-zinc-100 disabled:opacity-40"
      >
        <RefreshCw className={cn("size-3.5", isFetching && "animate-spin")} />
        {isFetching ? "Memuat…" : "Refresh"}
      </button>
    </div>
  );

  return (
    <Section
      title="Log kontainer"
      desc="Log mentah kontainer (stdout gateway + engine) — read-only untuk diagnosa."
      actions={actions}
    >
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <label className="flex items-center gap-2">
            <span className="text-xs text-zinc-500">Jumlah baris</span>
            <SegmentedControl value={tail} onChange={setTail} options={TAIL_OPTIONS} size="sm" />
          </label>
          <Toggle checked={autoFollow} onChange={setAutoFollow} label="Ikuti otomatis (5 dtk)" />
          <div className="min-w-[14rem]">
            <SearchInput
              value={search}
              onChange={setSearch}
              placeholder="Cari di log (mis. error)…"
              scopeHint="baris log"
            />
          </div>
        </div>

        <p className="text-[11px] text-zinc-500">
          Menampilkan {tail} baris terakhir. Lebih besar = lebih lambat. Baris yang memuat error disorot merah otomatis.
          {hasQuery && (
            <span className="ml-1 text-zinc-400">
              {matchCount} baris cocok dengan &ldquo;{search.trim()}&rdquo;.
            </span>
          )}
        </p>

        {isLoading ? (
          <div className="rounded-md border border-zinc-800 bg-black/40 px-3 py-8 text-center text-xs text-zinc-600">
            Memuat…
          </div>
        ) : isError ? (
          <EmptyState
            icon={<ScrollText className="size-8" />}
            title="Gagal memuat log."
            body={errorToBahasa(error)}
            action={
              <button
                type="button"
                onClick={() => void refetch()}
                className="rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400"
              >
                Coba lagi
              </button>
            }
          />
        ) : noContainer ? (
          <EmptyState icon={<ScrollText className="size-8" />} title="Belum ada kontainer." />
        ) : lines.length === 0 ? (
          <EmptyState
            icon={<ScrollText className="size-8" />}
            title={hasQuery ? "Tidak ada baris yang cocok." : "(kosong)"}
            body={hasQuery ? "Coba ubah kata kunci pencarian." : undefined}
          />
        ) : (
          <pre
            ref={preRef}
            className="max-h-80 overflow-auto whitespace-pre-wrap break-all rounded-md border border-zinc-800 bg-black/40 p-3 font-mono text-[11px] leading-relaxed text-zinc-400"
          >
            {lines.map((line, i) => (
              <div
                key={i}
                className={cn("py-px", ERROR_LINE_RE.test(line) && "rounded bg-red-500/10 text-red-300")}
              >
                {line || " "}
              </div>
            ))}
          </pre>
        )}
      </div>
    </Section>
  );
}

// Small dark-kit icon button (clipboard / download). Kept local — single file.
function IconButton({
  label,
  icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      disabled={disabled}
      className="inline-flex items-center justify-center rounded-md border border-zinc-700 p-1.5 text-zinc-400 transition hover:border-zinc-500 hover:text-zinc-100 disabled:cursor-not-allowed disabled:opacity-40"
    >
      {icon}
    </button>
  );
}
