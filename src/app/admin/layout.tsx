import type { Metadata } from "next";
import { requireAdminPage } from "@/lib/admin/rbac";
import { AdminNav, AdminSignOut } from "./_components/admin-chrome";
import { ToastProvider } from "./_components/ui";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "AgentBuff Admin",
  robots: { index: false, follow: false },
};

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  // Server-side gate (no middleware — matches the /app layout convention).
  // Reads users.role from the DB on every request; non-staff are bounced.
  const actor = await requireAdminPage();
  const isAdmin = actor.role === "admin";

  return (
    <ToastProvider>
      <div className="flex min-h-screen bg-zinc-950 text-zinc-100">
        <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40 p-3">
          <div className="flex items-center gap-2 px-2 py-2">
            <div className="flex size-7 items-center justify-center rounded-md bg-gradient-to-br from-cyan-400 to-fuchsia-500 text-[11px] font-bold text-zinc-950">
              AB
            </div>
            <div className="leading-tight">
              <div className="text-sm font-semibold text-zinc-100">AgentBuff</div>
              <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-zinc-500">Admin</div>
            </div>
          </div>
          <div className="my-3 h-px bg-zinc-800" />
          <AdminNav role={actor.role} />
          <div className="mt-auto px-2 pt-3 text-[11px] text-zinc-600">
            {isAdmin ? "Akses penuh" : "Mode Support (baca-saja)"}
          </div>
        </aside>

        <div className="flex min-h-screen flex-1 flex-col">
          <header className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950/80 px-6 py-3 backdrop-blur">
            <h1 className="text-sm font-medium text-zinc-400">Panel Admin</h1>
            <div className="flex items-center gap-3">
              <span className="flex items-center gap-2 text-xs text-zinc-500">
                <span className="max-w-[180px] truncate">{actor.email ?? actor.id.slice(0, 8)}</span>
                <span
                  className={
                    isAdmin
                      ? "rounded bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-400 ring-1 ring-emerald-500/25"
                      : "rounded bg-cyan-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-cyan-300 ring-1 ring-cyan-500/25"
                  }
                >
                  {actor.role}
                </span>
              </span>
              <AdminSignOut />
            </div>
          </header>
          <main className="flex-1 overflow-auto p-6">{children}</main>
        </div>
      </div>
    </ToastProvider>
  );
}
