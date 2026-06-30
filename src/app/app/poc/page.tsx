import Link from "next/link";
import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth.config";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { PocClient } from "./poc-client";

export const dynamic = "force-dynamic";

export default async function PocPage() {
  const session = await auth();
  if (!session?.user?.id) redirect("/login?next=/app/poc");

  const userId = session.user.id;

  const [row] = await db
    .select()
    .from(schema.userContainers)
    .where(eq(schema.userContainers.userId, userId))
    .limit(1);

  if (!row || row.status !== "running") {
    return (
      <main style={{ padding: 24, fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ fontSize: 20, marginBottom: 12 }}>POC — Container not ready</h1>
        <p style={{ color: "#555", marginBottom: 12 }}>
          Status saat ini: <code>{row?.status ?? "no-row"}</code>
        </p>
        <p>
          <Link href="/loby" style={{ color: "#0a5" }}>
            Buka /loby untuk provisioning
          </Link>
        </p>
      </main>
    );
  }

  return <PocClient userEmail={session.user.email ?? null} />;
}
