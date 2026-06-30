/**
 * scripts/provision-hermes-test-container.ts
 *
 * Provision a Hermes container for a specific user — for end-to-end testing
 * parallel to existing OpenClaw flows.
 *
 * Usage:
 *   pnpm tsx --env-file=.env.local scripts/provision-hermes-test-container.ts <userId>
 *   pnpm tsx --env-file=.env.local scripts/provision-hermes-test-container.ts --email user@example.com
 *
 * Pre-flight:
 *   1. `hermes-agent:local` image is built (run `./scripts/build-hermes-image.sh` first)
 *   2. Docker daemon reachable
 *   3. User exists in Postgres
 *   4. User does NOT already have an OpenClaw container (migration script
 *      `hermes-claw-migrate` would handle that case — out of scope here)
 *
 * Output:
 *   - Container `hermes-user-<userId>` running
 *   - Healthcheck passing within 120s
 *   - DB row in user_container with engineType="hermes", bridgeToken set
 *   - Connection URL printed for manual wscat testing
 */

import { eq } from "drizzle-orm";

import { db } from "@/lib/db";
import { users, userContainers } from "@/lib/db/schema";
import { hermesConfig } from "@/lib/hermes/config";
import {
  destroyContainer,
  getContainerStatus,
  provisionContainer,
} from "@/lib/hermes/docker";

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    printUsageAndExit();
  }

  // Parse args: either --email user@... or a positional userId
  let userId: string | null = null;
  if (argv[0] === "--email") {
    const email = argv[1];
    if (!email) printUsageAndExit();
    const [user] = await db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);
    if (!user) {
      console.error(`No user found with email ${email}`);
      return 1;
    }
    userId = user.id;
    console.log(`Resolved email ${email} → userId ${userId}`);
  } else {
    userId = argv[0];
  }

  if (!userId) printUsageAndExit();

  // Pre-flight: confirm user exists
  const [user] = await db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.id, userId!))
    .limit(1);
  if (!user) {
    console.error(`No user found with id ${userId}`);
    return 1;
  }

  console.log("=".repeat(60));
  console.log("Hermes test container provisioning");
  console.log(`  user:     ${user.id} (${user.email ?? "<no email>"})`);
  console.log(`  image:    ${hermesConfig.image}`);
  console.log(`  network:  ${hermesConfig.network}`);
  console.log("=".repeat(60));

  // Check pre-existing container
  const existing = await getContainerStatus(userId!);
  if (existing) {
    console.log(`\nExisting container row:`);
    console.log(`  status:      ${existing.status}`);
    console.log(`  port:        ${existing.port}`);
    console.log(`  containerName: ${existing.containerName}`);
    if (existing.status === "running") {
      console.log("\nContainer already running. Skipping provision.");
      printConnectionDetails(userId!, existing);
      return 0;
    }
  }

  console.log("\nProvisioning Hermes container...");
  const t0 = Date.now();

  try {
    const config = await provisionContainer(userId!);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n✅ Container provisioned in ${elapsed}s`);
    console.log(`  containerName: ${config.containerName}`);
    console.log(`  port:          ${config.port}`);
    console.log(`  bridgeToken:   ${maskToken(config.bridgeToken)}`);
    console.log(`  volumePath:    ${config.volumePath}`);
    console.log(`  imageVersion:  ${config.imageVersion}`);

    const status = await getContainerStatus(userId!);
    if (status) printConnectionDetails(userId!, status);

    console.log("\nNext steps:");
    console.log("  1. Verify health via Docker:");
    console.log(`       docker logs ${config.containerName} --tail 20`);
    console.log("  2. Test bridge RPC roundtrip:");
    console.log("       pnpm tsx scripts/test-hermes-bridge.ts " + userId);
    console.log("  3. Browser: open http://localhost:617/app (after wiring portal /api/ws/hermes route)");

    return 0;
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.error(`\n❌ Provisioning failed after ${elapsed}s`);
    console.error(err instanceof Error ? err.message : String(err));
    console.error("\nTroubleshoot:");
    console.error("  - Run `./scripts/build-hermes-image.sh` to (re)build image");
    console.error("  - Check Docker daemon: `docker info`");
    console.error("  - Inspect container logs: `docker logs <containerName>`");
    console.error("  - Inspect failed row: SELECT * FROM user_container WHERE user_id = '" + userId + "'");
    return 3;
  }
}

function printConnectionDetails(
  userId: string,
  status: { port: number; bridgeToken: string; containerName: string },
): void {
  console.log("\nConnection details:");
  console.log(`  Container:  ${status.containerName}`);
  console.log(`  Host port:  ${hermesConfig.bindHost}:${status.port}`);
  console.log(`  Bridge URL: ws://${hermesConfig.bindHost}:${status.port}/`);
  console.log(`  Bridge token (masked): ${maskToken(status.bridgeToken)}`);
  console.log(`\nManual wscat test:`);
  console.log(`  wscat -c ws://${hermesConfig.bindHost}:${status.port}/`);
  console.log(`  Then paste connect frame (single line):`);
  const connectFrame = {
    type: "req",
    id: "test-1",
    method: "connect",
    params: {
      auth: { token: status.bridgeToken },
      client: { id: "agentbuff-portal", version: "1", platform: "node" },
      role: "operator",
      scopes: [
        "operator.admin",
        "operator.read",
        "operator.write",
        "operator.approvals",
        "operator.pairing",
      ],
      userId,
    },
  };
  console.log("    " + JSON.stringify(connectFrame));
}

function maskToken(token: string): string {
  if (!token) return "<empty>";
  if (token.length <= 8) return "***";
  return token.slice(0, 4) + "..." + token.slice(-4);
}

function printUsageAndExit(): never {
  console.log("Usage:");
  console.log(
    "  pnpm tsx --env-file=.env.local scripts/provision-hermes-test-container.ts <userId>",
  );
  console.log(
    "  pnpm tsx --env-file=.env.local scripts/provision-hermes-test-container.ts --email <email>",
  );
  process.exit(64);
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error("Uncaught error:", err);
    process.exit(1);
  });
