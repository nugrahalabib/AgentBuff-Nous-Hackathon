import { redirect } from "next/navigation";
import { auth } from "@/lib/auth.config";
import { BantuanClient } from "@/components/bantuan/bantuan-client";

export const dynamic = "force-dynamic";

// Support / "Bantuan" — auth-only, deliberately OUTSIDE the /app container gate
// so a user whose container is down (the people who need support most) can still
// file a ticket and read replies.
export default async function BantuanPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login?next=/bantuan");

  return (
    <main className="min-h-screen bg-[#0B0E14] px-4 py-10 text-white sm:px-6">
      <div className="mx-auto max-w-2xl">
        <a
          href="/app"
          className="text-xs text-white/40 transition hover:text-white/70"
        >
          ← Kembali ke app
        </a>
        <h1 className="mt-3 font-display text-2xl font-bold">
          Bantuan &{" "}
          <span className="bg-gradient-to-r from-cyan-300 to-fuchsia-400 bg-clip-text text-transparent">
            Dukungan
          </span>
        </h1>
        <p className="mt-1 text-sm text-white/55">
          Ada kendala, usulan fitur, atau mau nanya? Kirim tiket — tim kami balas
          lewat halaman ini + notifikasi.
        </p>
        <div className="mt-6">
          <BantuanClient />
        </div>
      </div>
    </main>
  );
}
