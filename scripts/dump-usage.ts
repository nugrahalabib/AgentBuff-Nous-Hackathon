// Dump usage.cost + sessions.usage from engine — verify what we're actually
// showing in /app/usage. Usage:
//   pnpm tsx --env-file=.env.local scripts/dump-usage.ts
import { eq } from "drizzle-orm";
import { db } from "@/lib/db";
import * as schema from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import { withGateway } from "@/lib/hermes/gateway-client";

async function main() {
  const [row] = await db
    .select({
      userId: schema.userContainers.userId,
      port: schema.userContainers.port,
      gatewayToken: schema.userContainers.gatewayToken,
      status: schema.userContainers.status,
    })
    .from(schema.userContainers)
    .where(eq(schema.userContainers.status, "running"))
    .limit(1);
  if (!row) {
    console.error("no running container");
    process.exit(1);
  }
  const url = `ws://${hermesConfig.publicHost}:${row.port}/`;
  const result = await withGateway(
    {
      url,
      token: row.gatewayToken,
      clientId: "openclaw-control-ui",
      instanceId: `usage-dump-${row.userId.slice(0, 8)}`,
      defaultCallTimeoutMs: 30_000,
    },
    async (client) => {
      const cost = await client.call("usage.cost", { days: 30 });
      const sessions = await client.call("sessions.usage", {
        limit: 20,
        includeContextWeight: false,
      });
      const list = await client.call("sessions.list", {
        limit: 50,
        includeDerivedTitles: true,
        includeLastMessage: false,
      });
      return { cost, sessions, list };
    },
  );

  // Cast to known shape (we're not type-checking dump scripts strictly)
  const cost = result.cost as any;
  const sessions = result.sessions as any;
  const list = result.list as any;

  console.log("=".repeat(60));
  console.log("WAKTU SEKARANG (server):", new Date().toISOString());
  console.log("=".repeat(60));

  // ── usage.cost
  console.log("\n=== usage.cost (30 hari) ===");
  console.log("updatedAt:", new Date(cost.updatedAt).toISOString());
  console.log("days requested:", cost.days);
  console.log("daily entries:", cost.daily?.length ?? 0);
  console.log("\nTOTALS:");
  console.log("  totalCost:", cost.totals?.totalCost);
  console.log("  totalTokens:", cost.totals?.totalTokens);
  console.log("  input:", cost.totals?.input);
  console.log("  output:", cost.totals?.output);
  console.log("  cacheRead:", cost.totals?.cacheRead);
  console.log("  cacheWrite:", cost.totals?.cacheWrite);
  console.log("  missingCostEntries:", cost.totals?.missingCostEntries);

  console.log("\nDAILY (semua hari yang punya cost > 0):");
  const dailyWithCost = (cost.daily ?? []).filter(
    (d: any) => (d.totalCost ?? 0) > 0 || (d.totalTokens ?? 0) > 0,
  );
  if (dailyWithCost.length === 0) {
    console.log("  (kosong — gak ada hari dengan cost > 0)");
  } else {
    for (const d of dailyWithCost) {
      console.log(
        `  ${d.date}: $${d.totalCost?.toFixed(4)} · ${d.totalTokens} tok`,
      );
    }
  }

  // ── sessions.usage
  console.log("\n=== sessions.usage ===");
  console.log("startDate:", sessions.startDate);
  console.log("endDate:", sessions.endDate);
  console.log("sessions count:", sessions.sessions?.length ?? 0);

  console.log("\nSESSIONS DENGAN COST > 0:");
  const sessionsWithCost = (sessions.sessions ?? []).filter(
    (s: any) => s.usage && (s.usage.totalCost ?? 0) > 0,
  );
  if (sessionsWithCost.length === 0) {
    console.log("  (kosong)");
  } else {
    for (const s of sessionsWithCost) {
      const updated = s.updatedAt
        ? new Date(s.updatedAt).toISOString()
        : "tidak diketahui";
      console.log(
        `  key=${s.key}\n    label=${s.label ?? "(tidak ada)"}\n    updatedAt=${updated}\n    channel=${s.channel ?? "-"}\n    cost=$${s.usage.totalCost} tokens=${s.usage.totalTokens}`,
      );
    }
  }

  console.log("\nAGGREGATES:");
  if (sessions.aggregates?.messages) {
    console.log("  messages:", sessions.aggregates.messages);
  }
  if (sessions.aggregates?.tools) {
    console.log("  tools:", {
      totalCalls: sessions.aggregates.tools.totalCalls,
      uniqueTools: sessions.aggregates.tools.uniqueTools,
      top: sessions.aggregates.tools.tools?.slice(0, 5),
    });
  }
  if (sessions.aggregates?.daily) {
    console.log("  daily entries:", sessions.aggregates.daily.length);
    const dailyAgg = sessions.aggregates.daily.filter(
      (d: any) => (d.cost ?? 0) > 0 || (d.tokens ?? 0) > 0,
    );
    for (const d of dailyAgg) {
      console.log(
        `    ${d.date}: $${d.cost?.toFixed(4)} · ${d.tokens} tok · ${d.messages ?? 0} pesan · ${d.toolCalls ?? 0} tool`,
      );
    }
  }
  if (sessions.aggregates?.byChannel) {
    console.log("  byChannel:");
    for (const c of sessions.aggregates.byChannel) {
      console.log(
        `    ${c.channel}: $${c.totals.totalCost} · ${c.totals.totalTokens} tok`,
      );
    }
  }

  // ── sessions.list (untuk verify updatedAt tiap sesi)
  console.log("\n=== sessions.list (terakhir update kapan) ===");
  console.log("total sesi:", list.count);
  const sorted = [...(list.sessions ?? [])].sort(
    (a: any, b: any) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
  );
  for (const s of sorted.slice(0, 10)) {
    const updated = s.updatedAt
      ? new Date(s.updatedAt).toISOString()
      : "(tidak ada updatedAt)";
    const ago = s.updatedAt
      ? `${((Date.now() - s.updatedAt) / 1000 / 60 / 60).toFixed(1)} jam lalu`
      : "?";
    console.log(
      `  ${s.key}\n    label=${s.label ?? s.displayName ?? "(tidak ada)"}\n    updatedAt=${updated} (${ago})\n    totalTokens=${s.totalTokens ?? 0}`,
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("FAIL:", err);
  process.exit(1);
});
