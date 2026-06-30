"use client";

import { useMemo, useState } from "react";
import { Check, Copy, Server, Send } from "lucide-react";
import {
  apiFetch,
  useAdminQuery,
  Section,
  Badge,
  EmptyState,
  Combobox,
  FormRow,
  ConfirmDialog,
  useToast,
  errorToBahasa,
  fmtDateTime,
  type Option,
} from "./ui";

// D12/D13 — RPC console. Pick a running container, send one JSON-RPC method with
// JSON params, view the raw response. Backed by POST /api/admin/rpc-test (admin
// only, audited). The method catalog is a suggestion — any gateway method is
// allowed (free-entry). Mutating methods require a typed confirm naming the
// container + method, since they change the user's container for real.

type ContainerRow = {
  userId: string;
  email: string | null;
  status: string;
  port: number | null;
};
type ContainersResp = { rows: ContainerRow[] };

type RpcResp =
  | { ok: true; payload: unknown; ms: number }
  | { ok: false; error: { code: string | number; message: string; data?: unknown }; ms?: number };

// Read-only methods (group "Baca") — safe to call without a confirm.
const READ_METHODS: { method: string; hint: string }[] = [
  { method: "health", hint: "Cek kontainer hidup" },
  { method: "sessions.list", hint: "Daftar sesi user" },
  { method: "sessions.usage", hint: "Ringkasan token & energi sesi" },
  { method: "sessions.get", hint: "Detail satu sesi" },
  { method: "agents.list", hint: "Daftar agen" },
  { method: "agent.status", hint: "Status agen aktif" },
  { method: "channels.status", hint: "Status saluran (WA/TG/dst)" },
  { method: "skills.list", hint: "Skill terpasang" },
  { method: "models.list", hint: "Model tersedia" },
  { method: "config.get", hint: "Baca config kontainer" },
  { method: "cron.list", hint: "Jadwal cron" },
  { method: "memory.list", hint: "Daftar memori" },
];

// Well-known mutating methods (group "Mutasi") — these change container state.
const MUTATE_METHODS: { method: string; hint: string }[] = [
  { method: "config.patch", hint: "Ubah config kontainer" },
  { method: "skills.install", hint: "Pasang skill" },
  { method: "skills.update", hint: "Ubah skill" },
  { method: "skills.delete", hint: "Hapus skill" },
  { method: "agents.update", hint: "Ubah agen" },
  { method: "agents.delete", hint: "Hapus agen" },
  { method: "cron.delete", hint: "Hapus jadwal cron" },
];

// Params skeletons for "Isi contoh".
const PARAM_TEMPLATES: Record<string, string> = {
  "sessions.get": '{\n  "sessionKey": ""\n}',
  "sessions.usage": '{\n  "sessionKey": ""\n}',
  "config.get": '{\n  "path": ""\n}',
  "config.patch": '{\n  "patch": {}\n}',
  "skills.install": '{\n  "source": "clawhub",\n  "slug": ""\n}',
  "agent.status": "{}",
};

const METHOD_RE = /^[\w.]{1,64}$/;
// Mirrors the server-side detection: any of these markers = mutating.
const MUTATE_RE = /\.(patch|install|delete|update|create|set|remove)$/;

type MethodKind = "read" | "mutate" | "uncategorized" | "blocked";

function classifyMethod(method: string): MethodKind {
  if (method === "connect") return "blocked";
  if (READ_METHODS.some((m) => m.method === method)) return "read";
  if (MUTATE_METHODS.some((m) => m.method === method)) return "mutate";
  if (MUTATE_RE.test(method)) return "mutate";
  return "uncategorized";
}

const PRETTY = "max-h-96 overflow-auto rounded-md border border-zinc-800 bg-zinc-950/60 p-3 text-xs text-zinc-300";

type HistoryEntry = {
  id: number;
  method: string;
  userId: string;
  label: string;
  ok: boolean;
  ms: number | null;
  at: string;
  params: string;
};

let historySeq = 1;

export function RpcConsole() {
  const { toast } = useToast();
  const containers = useAdminQuery<ContainersResp>(["admin", "containers"], "/api/admin/containers");
  const running = useMemo(
    () => (containers.data?.rows ?? []).filter((r) => r.status === "running"),
    [containers.data],
  );

  const [userId, setUserId] = useState("");
  const [method, setMethod] = useState("health");
  const [paramsText, setParamsText] = useState("{}");
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<RpcResp | null>(null);
  const [clientError, setClientError] = useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);

  const containerOptions: Option[] = running.map((r) => ({
    value: r.userId,
    label: `${r.email ?? r.userId.slice(0, 8)} · :${r.port}`,
    hint: r.userId,
  }));

  // Container label for confirm + history, resolved from the live list.
  const selected = running.find((r) => r.userId === userId);
  const containerLabel = selected
    ? `${selected.email ?? selected.userId.slice(0, 8)} (:${selected.port})`
    : userId.slice(0, 8);

  const methodOptions: Option[] = useMemo(() => {
    const read = READ_METHODS.map<Option>((m) => ({
      value: m.method,
      label: m.method,
      hint: `Baca · ${m.hint}`,
      tone: "ok",
    }));
    const mutate = MUTATE_METHODS.map<Option>((m) => ({
      value: m.method,
      label: m.method,
      hint: `Mutasi ⚠ · ${m.hint}`,
      tone: "warn",
    }));
    return [...read, ...mutate];
  }, []);

  const trimmedMethod = method.trim();
  const kind = classifyMethod(trimmedMethod);
  const needsConfirm = kind === "mutate" || kind === "uncategorized";

  // Validate everything except the actual JSON parse, which also runs at send.
  const validate = (): { params: unknown } | null => {
    setClientError(null);
    if (!userId) {
      setClientError("Pilih kontainer dulu.");
      return null;
    }
    if (!METHOD_RE.test(trimmedMethod)) {
      setClientError("Nama method tidak valid (hanya huruf, angka, titik; maks 64).");
      return null;
    }
    if (trimmedMethod === "connect") {
      setClientError("Method 'connect' adalah handshake internal — ditolak server.");
      return null;
    }
    let params: unknown = undefined;
    const trimmed = paramsText.trim();
    if (trimmed !== "") {
      try {
        params = JSON.parse(trimmed);
      } catch {
        setClientError("Params bukan JSON yang valid.");
        return null;
      }
    }
    return { params };
  };

  const runRpc = async (params: unknown) => {
    setResult(null);
    setSending(true);
    try {
      const res = await apiFetch<RpcResp>("/api/admin/rpc-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userId, method: trimmedMethod, params }),
      });
      setResult(res);
      setHistory((xs) =>
        [
          {
            id: historySeq++,
            method: trimmedMethod,
            userId,
            label: containerLabel,
            ok: res.ok,
            ms: res.ms ?? null,
            at: new Date().toISOString(),
            params: paramsText,
          },
          ...xs,
        ].slice(0, 5),
      );
    } catch (e) {
      const msg = errorToBahasa(e);
      setClientError(msg);
      toast(msg, { tone: "bad" });
    } finally {
      setSending(false);
    }
  };

  const onSend = () => {
    const v = validate();
    if (!v) return;
    if (needsConfirm) {
      setConfirmOpen(true);
      return;
    }
    void runRpc(v.params);
  };

  const onConfirm = () => {
    setConfirmOpen(false);
    const v = validate();
    if (!v) return;
    void runRpc(v.params);
  };

  const fillExample = () => {
    setParamsText(PARAM_TEMPLATES[trimmedMethod] ?? "{}");
  };

  const copyResult = async () => {
    if (!result) return;
    const text = JSON.stringify(result.ok ? result.payload : result.error, null, 2);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast("Gagal menyalin ke clipboard.", { tone: "bad" });
    }
  };

  const rerun = (h: HistoryEntry) => {
    setUserId(h.userId);
    setMethod(h.method);
    setParamsText(h.params);
    setResult(null);
    setClientError(null);
  };

  const noRunning = !containers.isLoading && running.length === 0;
  const kindBadge =
    kind === "read" ? (
      <Badge tone="ok">Baca</Badge>
    ) : kind === "mutate" ? (
      <Badge tone="warn">Mutasi</Badge>
    ) : kind === "blocked" ? (
      <Badge tone="bad">Terlarang</Badge>
    ) : (
      <Badge tone="muted">Tak terkategori — anggap berisiko</Badge>
    );

  return (
    <Section
      title="RPC Console"
      desc="Kirim satu panggilan JSON-RPC ke mesin kontainer user yang sedang jalan. Method mutasi mengubah kontainer milik user — semua panggilan tercatat di audit log."
    >
      {noRunning ? (
        <EmptyState
          icon={<Server className="size-8" />}
          title="Tak ada kontainer jalan"
          body="Kontainer harus berstatus running untuk bisa dipanggil. Cek tab Kontainer untuk menyalakan salah satu."
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-start">
          <div className="space-y-4">
            <div className="grid gap-3 md:grid-cols-2">
              <FormRow
                label="Kontainer (running)"
                help="Hanya kontainer yang sedang jalan bisa dipanggil."
              >
                <Combobox
                  value={userId}
                  onChange={setUserId}
                  options={containerOptions}
                  placeholder={containers.isLoading ? "Memuat…" : `Pilih (${running.length} jalan)`}
                  loading={containers.isLoading}
                  emptyText="Tak ada kontainer cocok"
                />
              </FormRow>

              <FormRow
                label="Method"
                help="Grup Baca aman; grup Mutasi mengubah kontainer user. Method lain boleh diketik manual."
              >
                <Combobox
                  value={method}
                  onChange={setMethod}
                  options={methodOptions}
                  allowCustom
                  placeholder="health"
                  emptyText="Ketik method gateway apa pun"
                />
              </FormRow>
            </div>

            <div className="flex items-center gap-2">
              {kindBadge}
              {kind === "blocked" && (
                <span className="text-xs text-red-300">
                  Method ini di-block di client (mirror server).
                </span>
              )}
            </div>

            <FormRow
              label="Params (JSON)"
              help="Argumen JSON-RPC. Pakai 'Isi contoh' untuk kerangka, atau tulis JSON langsung. Kosong = tanpa params."
            >
              <div className="space-y-1.5">
                <textarea
                  value={paramsText}
                  onChange={(e) => setParamsText(e.target.value)}
                  rows={5}
                  spellCheck={false}
                  className="w-full rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-sm text-zinc-100 placeholder:text-zinc-500 outline-none transition focus:border-cyan-500/50 focus:ring-2 focus:ring-cyan-500/30"
                />
                <button
                  type="button"
                  onClick={fillExample}
                  className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 transition hover:bg-zinc-800"
                >
                  Isi contoh
                </button>
              </div>
            </FormRow>

            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                disabled={sending || !userId || kind === "blocked"}
                onClick={onSend}
                className="inline-flex items-center gap-1.5 rounded-md bg-cyan-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:bg-cyan-400 disabled:opacity-50"
              >
                <Send className="size-3.5" />
                {sending ? "Mengirim…" : "Kirim RPC"}
              </button>
              {result ? (
                <Badge tone={result.ok ? "ok" : "bad"}>
                  {result.ok ? "OK" : "ERROR"}
                  {result.ms != null ? ` · ${result.ms}ms` : ""}
                </Badge>
              ) : null}
              {clientError ? <span className="text-xs text-red-300">{clientError}</span> : null}
              <span className="text-[11px] text-zinc-500">
                Maks 60 panggilan / 60 dtk · timeout 20 dtk · tercatat audit.
              </span>
            </div>

            {result ? (
              result.ok ? (
                <div>
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                      Hasil
                    </span>
                    <button
                      type="button"
                      onClick={copyResult}
                      className="inline-flex items-center gap-1 text-xs text-zinc-400 transition hover:text-zinc-100"
                    >
                      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                      {copied ? "Tersalin" : "Salin"}
                    </button>
                  </div>
                  <pre className={PRETTY}>{JSON.stringify(result.payload, null, 2)}</pre>
                </div>
              ) : (
                <div className="rounded-md border border-red-500/30 bg-red-500/5 p-3">
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="inline-flex items-center gap-2 text-sm font-medium text-red-300">
                      Panggilan gagal
                      <Badge tone="bad">{String(result.error.code)}</Badge>
                    </span>
                    <button
                      type="button"
                      onClick={copyResult}
                      className="inline-flex items-center gap-1 text-xs text-zinc-400 transition hover:text-zinc-100"
                    >
                      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
                      {copied ? "Tersalin" : "Salin"}
                    </button>
                  </div>
                  <p className="text-xs text-red-200/90">{result.error.message}</p>
                  {result.error.data != null && (
                    <pre className={`${PRETTY} mt-2`}>
                      {JSON.stringify(result.error.data, null, 2)}
                    </pre>
                  )}
                </div>
              )
            ) : null}
          </div>

          <aside className="w-full lg:w-64">
            <div className="rounded-lg border border-zinc-800 bg-zinc-900/40 p-3">
              <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
                5 panggilan terakhir
              </div>
              {history.length === 0 ? (
                <p className="text-xs text-zinc-600">Belum ada panggilan di sesi ini.</p>
              ) : (
                <ul className="space-y-1.5">
                  {history.map((h) => (
                    <li key={h.id}>
                      <button
                        type="button"
                        onClick={() => rerun(h)}
                        className="w-full rounded-md border border-zinc-800 px-2.5 py-1.5 text-left transition hover:border-zinc-700 hover:bg-zinc-800/60"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span className="truncate font-mono text-xs text-zinc-200">{h.method}</span>
                          <Badge tone={h.ok ? "ok" : "bad"}>{h.ok ? "OK" : "ERR"}</Badge>
                        </div>
                        <div className="mt-0.5 flex items-center justify-between gap-2 text-[10px] text-zinc-500">
                          <span className="truncate">{h.label}</span>
                          {h.ms != null && <span className="shrink-0 tabular-nums">{h.ms}ms</span>}
                        </div>
                        <div className="text-[10px] text-zinc-600">{fmtDateTime(h.at)}</div>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </aside>
        </div>
      )}

      <ConfirmDialog
        open={confirmOpen}
        onConfirm={onConfirm}
        onCancel={() => setConfirmOpen(false)}
        title="Jalankan method mutasi?"
        danger
        confirmLabel="Jalankan"
        loading={sending}
        body={
          <span>
            Ini menjalankan <span className="font-mono font-semibold text-zinc-200">{trimmedMethod}</span> pada
            kontainer milik user. Aksi ini mengubah state kontainer dan tercatat di audit log.
          </span>
        }
        summary={[
          { label: "Method", value: trimmedMethod, tone: kind === "mutate" ? "warn" : "muted" },
          { label: "Kontainer", value: containerLabel },
          {
            label: "Kategori",
            value: kind === "mutate" ? "Mutasi" : "Tak terkategori",
            tone: kind === "mutate" ? "warn" : "muted",
          },
        ]}
      />
    </Section>
  );
}
