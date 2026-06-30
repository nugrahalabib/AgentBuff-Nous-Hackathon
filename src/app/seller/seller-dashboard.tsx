"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

// D4 seller self-service portal UI. One client component that routes the user
// through apply -> pending -> active and, when active, exposes profile/bank,
// listings (create draft + submit + edit + delete), and sales/payouts.

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) {
    const d = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(d.error ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

const rp = (n: number) => `Rp ${(n ?? 0).toLocaleString("id-ID")}`;
const fmtDate = (s: string | null | undefined) =>
  s ? new Date(s).toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" }) : "—";

const CARD = "rounded-xl border border-zinc-800 bg-zinc-900/40 p-4";
const INPUT =
  "w-full rounded-md border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none";
const BTN =
  "rounded-md bg-gradient-to-br from-cyan-400 to-fuchsia-500 px-4 py-2 text-sm font-medium text-zinc-950 transition hover:brightness-110 disabled:opacity-50";

type Me = {
  seller: {
    id: string;
    status: string;
    displayName: string;
    commissionPct: number | null;
    payout: { bankCode: string; accountNumber: string; accountName: string } | null;
  } | null;
  summary?: {
    listings: number;
    sales: number;
    grossRp: number;
    earnedNetRp: number;
    paidNetRp: number;
  };
};

export function SellerDashboard() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ["seller", "me"],
    queryFn: () => api<Me>("/api/seller/me"),
  });

  if (isLoading) return <div className="text-sm text-zinc-500">Memuat…</div>;
  if (isError || !data)
    return <div className="text-sm text-red-300">Gagal memuat.</div>;
  if (!data.seller) return <ApplyForm />;
  if (data.seller.status === "pending") return <PendingNotice />;
  if (data.seller.status === "suspended")
    return (
      <div className={CARD}>
        <div className="text-sm font-medium text-amber-300">
          Akun penjual ditangguhkan
        </div>
        <p className="mt-1 text-xs text-zinc-500">
          Hubungi support kalau menurutmu ini keliru.
        </p>
      </div>
    );
  return <ActiveDashboard me={data} />;
}

function ApplyForm() {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const apply = useMutation({
    mutationFn: () =>
      api("/api/seller/me", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ displayName: name.trim() }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["seller", "me"] }),
  });
  return (
    <div className={`${CARD} space-y-3`}>
      <div className="text-sm font-medium text-zinc-200">Jadi penjual</div>
      <p className="text-xs text-zinc-500">
        Daftar untuk jualan skill/app di Item Shop. Setelah disetujui admin, kamu
        bisa submit listing dan terima payout.
      </p>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Nama toko / kreator"
        className={INPUT}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={apply.isPending || !name.trim()}
          onClick={() => apply.mutate()}
          className={BTN}
        >
          {apply.isPending ? "Mendaftar…" : "Daftar jadi penjual"}
        </button>
        {apply.isError ? (
          <span className="text-xs text-red-300">Gagal mendaftar.</span>
        ) : null}
      </div>
    </div>
  );
}

function PendingNotice() {
  return (
    <div className={CARD}>
      <div className="text-sm font-medium text-cyan-300">
        Menunggu persetujuan admin
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Pendaftaran penjual kamu sedang ditinjau. Kamu bisa atur rekening payout
        sekarang; submit listing terbuka setelah disetujui.
      </p>
      <div className="mt-3">
        <BankForm />
      </div>
    </div>
  );
}

function ActiveDashboard({ me }: { me: Me }) {
  const s = me.summary;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Listing" value={String(s?.listings ?? 0)} />
        <Stat label="Penjualan" value={String(s?.sales ?? 0)} />
        <Stat label="Pendapatan (net)" value={rp(s?.earnedNetRp ?? 0)} />
        <Stat label="Sudah dibayar" value={rp(s?.paidNetRp ?? 0)} />
      </div>
      <BankForm />
      <ListingsSection />
      <SalesSection />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <div className="text-sm font-semibold tabular-nums text-zinc-100">{value}</div>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">{label}</div>
    </div>
  );
}

function BankForm() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["seller", "me"], queryFn: () => api<Me>("/api/seller/me") });
  const p = data?.seller?.payout;
  const [bankCode, setBankCode] = useState(p?.bankCode ?? "");
  const [accountNumber, setAccountNumber] = useState(p?.accountNumber ?? "");
  const [accountName, setAccountName] = useState(p?.accountName ?? "");
  const save = useMutation({
    mutationFn: () =>
      api("/api/seller/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bankCode, accountNumber, accountName }),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["seller", "me"] }),
  });
  return (
    <div className={`${CARD} space-y-2`}>
      <div className="text-sm font-medium text-zinc-200">Rekening payout</div>
      <div className="grid gap-2 sm:grid-cols-3">
        <input value={bankCode} onChange={(e) => setBankCode(e.target.value)} placeholder="Kode bank (mis. bca)" className={INPUT} />
        <input value={accountNumber} onChange={(e) => setAccountNumber(e.target.value)} placeholder="No. rekening" inputMode="numeric" className={INPUT} />
        <input value={accountName} onChange={(e) => setAccountName(e.target.value)} placeholder="Nama pemilik" className={INPUT} />
      </div>
      <div className="flex items-center gap-2">
        <button type="button" disabled={save.isPending} onClick={() => save.mutate()} className={BTN}>
          {save.isPending ? "Menyimpan…" : "Simpan rekening"}
        </button>
        {save.isSuccess ? <span className="text-xs text-emerald-400">Tersimpan.</span> : null}
        {save.isError ? <span className="text-xs text-red-300">Gagal (cek no. rekening = angka).</span> : null}
      </div>
    </div>
  );
}

type Listing = {
  id: string;
  kind: string;
  title: string;
  description: string | null;
  category: string | null;
  priceRp: number;
  status: string;
  reviewNotes: string | null;
};

function ListingsSection() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["seller", "listings"],
    queryFn: () => api<{ rows: Listing[] }>("/api/seller/listings"),
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ["seller", "listings"] });
  const [showNew, setShowNew] = useState(false);

  return (
    <div className={`${CARD} space-y-3`}>
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-zinc-200">Listing kamu</div>
        <button type="button" onClick={() => setShowNew((v) => !v)} className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:border-zinc-500">
          {showNew ? "Tutup" : "+ Listing baru"}
        </button>
      </div>
      {showNew ? <NewListingForm onDone={() => { setShowNew(false); invalidate(); }} /> : null}
      {isLoading ? (
        <div className="text-xs text-zinc-600">Memuat…</div>
      ) : !data || data.rows.length === 0 ? (
        <div className="text-xs text-zinc-600">Belum ada listing.</div>
      ) : (
        <div className="space-y-2">
          {data.rows.map((l) => (
            <ListingRow key={l.id} l={l} onChange={invalidate} />
          ))}
        </div>
      )}
    </div>
  );
}

function statusTone(s: string): string {
  if (s === "published") return "text-emerald-400";
  if (s === "approved") return "text-cyan-300";
  if (s === "pending") return "text-amber-300";
  if (s === "rejected") return "text-red-400";
  return "text-zinc-500";
}

function ListingRow({ l, onChange }: { l: Listing; onChange: () => void }) {
  const submit = useMutation({
    mutationFn: () =>
      api(`/api/seller/listings/${l.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "submit" }),
      }),
    onSuccess: onChange,
  });
  const del = useMutation({
    mutationFn: () => api(`/api/seller/listings/${l.id}`, { method: "DELETE" }),
    onSuccess: onChange,
  });
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
      <div className="flex items-center gap-2 text-sm">
        <span className="text-zinc-200">{l.title}</span>
        <span className="text-[10px] text-zinc-600">{l.kind}</span>
        <span className="text-zinc-400">{rp(l.priceRp)}</span>
        <span className={`ml-auto text-xs font-medium ${statusTone(l.status)}`}>{l.status}</span>
      </div>
      {l.reviewNotes && l.status === "rejected" ? (
        <div className="mt-1 text-[11px] text-red-300">Catatan admin: {l.reviewNotes}</div>
      ) : null}
      {l.status === "draft" ? (
        <div className="mt-2 flex gap-2">
          <button type="button" disabled={submit.isPending} onClick={() => submit.mutate()} className="rounded border border-cyan-500/50 px-2 py-0.5 text-[11px] text-cyan-300 hover:bg-cyan-500/10 disabled:opacity-40">
            {submit.isPending ? "…" : "Submit untuk review"}
          </button>
          <button type="button" disabled={del.isPending} onClick={() => del.mutate()} className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-400 hover:border-red-500/40 hover:text-red-400 disabled:opacity-40">
            Hapus
          </button>
        </div>
      ) : null}
    </div>
  );
}

function NewListingForm({ onDone }: { onDone: () => void }) {
  const [title, setTitle] = useState("");
  const [kind, setKind] = useState("skill");
  const [priceRp, setPriceRp] = useState("");
  const [category, setCategory] = useState("");
  const [clawhubSlug, setClawhubSlug] = useState("");
  const [description, setDescription] = useState("");
  const create = useMutation({
    mutationFn: () =>
      api("/api/seller/listings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: title.trim(),
          kind,
          priceRp: Number(priceRp) || 0,
          category: category.trim() || undefined,
          clawhubSlug: clawhubSlug.trim() || undefined,
          description: description.trim() || undefined,
        }),
      }),
    onSuccess: onDone,
  });
  return (
    <div className="space-y-2 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
      <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Judul listing" className={INPUT} />
      <div className="grid gap-2 sm:grid-cols-3">
        <select value={kind} onChange={(e) => setKind(e.target.value)} className={INPUT}>
          <option value="skill">skill</option>
          <option value="mcp_app">mcp_app</option>
          <option value="bundle">bundle</option>
        </select>
        <input value={priceRp} onChange={(e) => setPriceRp(e.target.value)} placeholder="Harga Rp (0 = gratis)" inputMode="numeric" className={INPUT} />
        <input value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Kategori (mis. mlops)" className={INPUT} />
      </div>
      {kind === "skill" ? (
        <input value={clawhubSlug} onChange={(e) => setClawhubSlug(e.target.value)} placeholder="ClawHub slug (untuk install)" className={INPUT} />
      ) : null}
      <textarea value={description} onChange={(e) => setDescription(e.target.value)} rows={2} placeholder="Deskripsi" className={INPUT} />
      <div className="flex items-center gap-2">
        <button type="button" disabled={create.isPending || !title.trim()} onClick={() => create.mutate()} className={BTN}>
          {create.isPending ? "Membuat…" : "Buat draft"}
        </button>
        {create.isError ? <span className="text-xs text-red-300">Gagal membuat.</span> : null}
      </div>
    </div>
  );
}

type Sale = {
  id: string;
  listingTitle: string | null;
  grossRp: number;
  commissionRp: number;
  netRp: number;
  status: string;
  period: string;
  createdAt: string;
};
type Batch = { id: string; totalNetRp: number; status: string; createdAt: string };

function SalesSection() {
  const { data, isLoading } = useQuery({
    queryKey: ["seller", "sales"],
    queryFn: () => api<{ sales: Sale[]; batches: Batch[] }>("/api/seller/sales"),
  });
  return (
    <div className={`${CARD} space-y-3`}>
      <div className="text-sm font-medium text-zinc-200">Penjualan & payout</div>
      {isLoading ? (
        <div className="text-xs text-zinc-600">Memuat…</div>
      ) : !data ? (
        <div className="text-xs text-red-300">Gagal memuat.</div>
      ) : (
        <>
          {data.batches.length > 0 ? (
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-zinc-500">Batch payout</div>
              {data.batches.map((b) => (
                <div key={b.id} className="flex items-center gap-2 text-[11px] text-zinc-400">
                  <span>{fmtDate(b.createdAt)}</span>
                  <span className="text-zinc-300">{rp(b.totalNetRp)}</span>
                  <span className="ml-auto">{b.status}</span>
                </div>
              ))}
            </div>
          ) : null}
          {data.sales.length === 0 ? (
            <div className="text-xs text-zinc-600">Belum ada penjualan.</div>
          ) : (
            <div className="overflow-x-auto rounded-lg border border-zinc-800">
              <table className="w-full text-left text-[11px]">
                <thead className="bg-zinc-900/60 text-zinc-500">
                  <tr>
                    <th className="px-2 py-1.5">Tgl</th>
                    <th className="px-2 py-1.5">Item</th>
                    <th className="px-2 py-1.5 text-right">Bruto</th>
                    <th className="px-2 py-1.5 text-right">Komisi</th>
                    <th className="px-2 py-1.5 text-right">Net</th>
                    <th className="px-2 py-1.5">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sales.map((s) => (
                    <tr key={s.id} className="border-t border-zinc-800/70">
                      <td className="px-2 py-1.5 text-zinc-500">{fmtDate(s.createdAt)}</td>
                      <td className="px-2 py-1.5 text-zinc-300">{s.listingTitle ?? "—"}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-400">{rp(s.grossRp)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-zinc-500">-{rp(s.commissionRp)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-emerald-400">{rp(s.netRp)}</td>
                      <td className="px-2 py-1.5 text-zinc-400">{s.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
