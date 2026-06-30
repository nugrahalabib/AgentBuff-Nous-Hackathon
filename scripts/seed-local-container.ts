import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import postgres from "postgres";

for (const envFile of [".env.local", ".env"]) {
  try {
    const txt = readFileSync(resolve(process.cwd(), envFile), "utf8");
    for (const raw of txt.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
  } catch {
    // file missing — fine
  }
}

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is not set");
  process.exit(1);
}

const sql = postgres(url, { max: 1 });

async function main() {
  const targetEmail = process.argv[2] ?? "agentbuff.id@gmail.com";

  const users = await sql<
    { id: string; email: string | null }[]
  >`SELECT id, email FROM "user" ORDER BY created_at ASC`;

  if (users.length === 0) {
    console.error(
      "No users in DB yet. Register via /register first, then rerun this script.",
    );
    process.exit(2);
  }

  console.log("Users in DB:");
  for (const u of users) console.log(`  ${u.id}  ${u.email}`);

  const user = users.find((u) => u.email === targetEmail) ?? users[0];
  console.log(`\nSeeding user_container for: ${user.email} (${user.id})`);

  const existing = await sql<
    { id: string; port: number; status: string }[]
  >`SELECT id, port, status FROM user_container WHERE user_id = ${user.id}`;

  const localToken = process.env.OPENCLAW_LOCAL_TOKEN ?? "local-dev";

  async function pickFreePort() {
    if (existing[0]) return existing[0].port;
    const used = await sql<
      { port: number }[]
    >`SELECT port FROM user_container ORDER BY port ASC`;
    const taken = new Set(used.map((r) => r.port));
    for (let p = 18900; p < 19000; p++) if (!taken.has(p)) return p;
    throw new Error("no free port in 18900-18999");
  }
  const port = await pickFreePort();

  if (existing.length > 0) {
    await sql`
      UPDATE user_container
      SET gateway_token = ${localToken},
          status = 'running',
          container_name = 'openclaw-local-dev',
          error_message = NULL,
          updated_at = NOW()
      WHERE user_id = ${user.id}
    `;
    console.log(`Updated existing row (stored port=${port}) status=running.`);
  } else {
    await sql`
      INSERT INTO user_container
        (id, user_id, container_name, port, gateway_token, status)
      VALUES
        (gen_random_uuid(), ${user.id}, 'openclaw-local-dev', ${port}, ${localToken}, 'running')
    `;
    console.log(`Inserted new row stored port=${port} status=running.`);
  }
  console.log(
    `(IS_LOCAL=true overrides to ${process.env.OPENCLAW_LOCAL_PORT ?? "18789"} at runtime.)`,
  );

  const energy = await sql<
    { balance: number }[]
  >`SELECT balance FROM user_energy WHERE user_id = ${user.id}`;
  if (energy.length === 0) {
    await sql`
      INSERT INTO user_energy (user_id, balance, max_balance)
      VALUES (${user.id}, 500, 500)
    `;
    console.log("Seeded user_energy balance=500/500.");
  } else {
    console.log(`user_energy already exists (balance=${energy[0].balance}).`);
  }

  await sql.end({ timeout: 2 });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
