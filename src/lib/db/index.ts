import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL!;

// Reuse ONE pool across HMR reloads / module re-evaluations. Without the
// globalThis cache, Next dev (+ the custom server) re-evaluates this module on
// every hot reload, each time opening a fresh postgres.js pool and orphaning the
// old one — connections accumulate until Postgres rejects with "too many clients
// already" (53300). Capping `max` + `idle_timeout` also bounds the steady-state
// count so a burst of per-render queries (CMS overlay + pricing resolver) can't
// exhaust the server's max_connections.
const globalForDb = globalThis as unknown as {
  __agentbuffPg?: ReturnType<typeof postgres>;
};

const client =
  globalForDb.__agentbuffPg ??
  postgres(connectionString, { max: 10, idle_timeout: 20 });

if (process.env.NODE_ENV !== "production") globalForDb.__agentbuffPg = client;

export const db = drizzle(client, { schema });
