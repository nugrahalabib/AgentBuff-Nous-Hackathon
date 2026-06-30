"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { cn } from "@/lib/utils";

type Ticket = {
  id: string;
  ref: string;
  category: string;
  subject: string;
  message: string;
  status: string;
  reply: string | null;
  repliedAt: string | null;
  createdAt: string;
};

const CATS = [
  { id: "keluhan", label: "Keluhan", desc: "Ada yang error / nggak beres" },
  { id: "pengembangan", label: "Usulan", desc: "Minta fitur / pengembangan" },
  { id: "pertanyaan", label: "Pertanyaan", desc: "Mau nanya cara pakai" },
];

const STATUS: Record<string, { label: string; cls: string }> = {
  open: { label: "Baru", cls: "bg-amber-400/15 text-amber-300" },
  in_progress: { label: "Diproses", cls: "bg-cyan-400/15 text-cyan-300" },
  answered: { label: "Dijawab", cls: "bg-emerald-400/15 text-emerald-300" },
  closed: { label: "Ditutup", cls: "bg-white/10 text-white/50" },
};

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

function fmt(s: string): string {
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("id-ID", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

export function BantuanClient() {
  const qc = useQueryClient();
  const [category, setCategory] = useState("keluhan");
  const [subject, setSubject] = useState("");
  const [message, setMessage] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const { data } = useQuery({
    queryKey: ["support", "tickets"],
    queryFn: () => api<{ tickets: Ticket[] }>("/api/support/tickets"),
  });

  const submit = useMutation({
    mutationFn: () =>
      api<{ ok: boolean; ref: string }>("/api/support/tickets", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          category,
          subject: subject.trim(),
          message: message.trim(),
        }),
      }),
    onSuccess: () => {
      setSubject("");
      setMessage("");
      setErr(null);
      qc.invalidateQueries({ queryKey: ["support", "tickets"] });
    },
    onError: (e: unknown) => {
      const m = e instanceof Error ? e.message : "";
      if (m.includes("429"))
        setErr("Terlalu sering kirim tiket. Coba lagi sebentar lagi.");
      else if (m.includes("400"))
        setErr("Subjek min 5 huruf, pesan min 10 huruf.");
      else setErr("Gagal mengirim. Coba lagi.");
    },
  });

  const canSubmit =
    subject.trim().length >= 5 &&
    message.trim().length >= 10 &&
    !submit.isPending;

  const tickets = data?.tickets ?? [];

  return (
    <div className="space-y-8">
      {/* Form */}
      <div className="space-y-4 rounded-2xl border border-white/10 bg-white/[0.03] p-5">
        <div className="grid grid-cols-3 gap-2">
          {CATS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setCategory(c.id)}
              className={cn(
                "rounded-xl border px-3 py-2.5 text-left transition",
                category === c.id
                  ? "border-cyan-400/50 bg-cyan-400/10"
                  : "border-white/10 bg-white/[0.02] hover:border-white/25",
              )}
            >
              <div className="text-sm font-medium text-white/90">{c.label}</div>
              <div className="mt-0.5 text-[11px] text-white/45">{c.desc}</div>
            </button>
          ))}
        </div>

        <label className="block space-y-1">
          <span className="text-xs text-white/50">Subjek</span>
          <input
            value={subject}
            onChange={(e) => {
              setSubject(e.target.value);
              setErr(null);
            }}
            maxLength={200}
            placeholder="Ringkas masalahnya…"
            className="w-full rounded-lg border border-white/10 bg-[#0B0E14]/80 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
          />
        </label>

        <label className="block space-y-1">
          <span className="text-xs text-white/50">Detail</span>
          <textarea
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setErr(null);
            }}
            maxLength={4000}
            rows={5}
            placeholder="Ceritakan detailnya — langkah, pesan error, dll."
            className="w-full rounded-lg border border-white/10 bg-[#0B0E14]/80 px-3 py-2 text-sm text-white placeholder:text-white/30 focus:border-cyan-400/50 focus:outline-none"
          />
        </label>

        {err ? <div className="text-xs text-red-300">{err}</div> : null}
        {submit.isSuccess && !submit.isPending ? (
          <div className="text-xs text-emerald-300">
            Tiket terkirim. Tim kami balas lewat halaman ini + notifikasi.
          </div>
        ) : null}

        <button
          type="button"
          disabled={!canSubmit}
          onClick={() => {
            setErr(null);
            submit.mutate();
          }}
          className="rounded-lg bg-gradient-to-br from-cyan-400 via-indigo-500 to-fuchsia-500 px-5 py-2.5 text-sm font-semibold text-[#0B0E14] transition hover:brightness-110 disabled:opacity-40"
        >
          {submit.isPending ? "Mengirim…" : "Kirim tiket"}
        </button>
      </div>

      {/* My tickets */}
      <div className="space-y-2">
        <div className="text-[11px] font-medium uppercase tracking-[0.2em] text-white/40">
          Tiket kamu
        </div>
        {tickets.length === 0 ? (
          <p className="text-sm text-white/45">Belum ada tiket.</p>
        ) : (
          <div className="space-y-2">
            {tickets.map((t) => {
              const st = STATUS[t.status] ?? STATUS.open;
              return (
                <div
                  key={t.id}
                  className="rounded-xl border border-white/10 bg-white/[0.03] p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono text-[11px] text-white/40">
                      {t.ref}
                    </span>
                    <span
                      className={cn(
                        "rounded px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide",
                        st.cls,
                      )}
                    >
                      {st.label}
                    </span>
                  </div>
                  <div className="mt-1 text-sm font-medium text-white/90">
                    {t.subject}
                  </div>
                  <p className="mt-1 whitespace-pre-wrap text-xs text-white/55">
                    {t.message}
                  </p>
                  {t.reply ? (
                    <div className="mt-3 rounded-lg border border-cyan-400/20 bg-cyan-400/5 p-3">
                      <div className="text-[10px] font-medium uppercase tracking-wide text-cyan-300/80">
                        Balasan tim
                      </div>
                      <p className="mt-1 whitespace-pre-wrap text-xs text-white/80">
                        {t.reply}
                      </p>
                    </div>
                  ) : null}
                  <div className="mt-2 text-[10px] text-white/30">
                    {fmt(t.createdAt)}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
