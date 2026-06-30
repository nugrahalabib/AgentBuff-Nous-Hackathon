/**
 * src/lib/hermes/docker.ts
 *
 * Per-user Hermes container provisioning + lifecycle.
 *
 * Mirrors the contract shape of `src/lib/openclaw/docker.ts`:
 *   - `provisionContainer(userId)` — idempotent, state-machine driven
 *   - `getContainerStatus(userId)` — read DB row + docker inspect
 *   - `startContainer(userId)` / `stopContainer(userId)` / `destroyContainer(userId)`
 *
 * Differences from OpenClaw:
 *   - Image: `hermes-agent:local` (built from docker/Dockerfile.hermes)
 *   - No bind-mount UI rebrand (Phase 3 dead — /app IS the UI)
 *   - Bridge token (not gateway token) is the credential injected
 *   - Bridge exposes 2 ports: 18789 (WS) + 18790 (health)
 *   - No OpenClaw-specific openclaw.json seeding — bridge boot does config seed
 *
 * Hard constraint reminders:
 *   - Don't modify HermesAgent/ source.
 *   - Container hardening flags must always be set (cap-drop, no-new-privileges).
 *   - Loopback-only port publish (never 0.0.0.0).
 */

import { randomBytes } from "node:crypto";
import { exec as execCallback, spawn } from "node:child_process";
import { promisify } from "node:util";

import { eq, sql } from "drizzle-orm";

import { db } from "@/lib/db";
import { userContainers, userProfiles, containerEvents } from "@/lib/db/schema";
import { hermesConfig } from "./config";
import { claimPort, releasePort } from "./ports";
import { resolveSetting } from "@/lib/admin/settings";
import { resolveEngineDefaults } from "@/lib/hermes/engine-defaults";
import { resolveUserLimits } from "@/lib/admin/limits";
import { resolveSubscription } from "@/lib/dashboard/subscription-resolver";
import type { ContainerStatus, HermesContainerConfig } from "./types";

const exec = promisify(execCallback);

// ---------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------

/**
 * Ensure a running Hermes container exists for the user.
 * Idempotent: safe to call repeatedly.
 *
 * State machine: queued → starting → awaiting-health → running
 *                                                     ↘ failed
 */
/**
 * Append a container lifecycle event (F4 fleet-monitor log). Fire-and-forget +
 * never throws — observability must NEVER break the lifecycle path that called
 * it. docker.ts is the single authoritative emitter for the automated paths
 * (provision/stop/start/destroy with the REAL outcome); the admin action route
 * only records "health" for a manual refresh.
 */
function recordContainerEvent(
  userId: string,
  event: "provision" | "health" | "restart" | "stop" | "start" | "destroy",
  ok: boolean,
  errorMessage?: string,
): void {
  void db
    .insert(containerEvents)
    .values({ userId, event, ok, errorMessage: errorMessage?.slice(0, 500) })
    .catch(() => {
      /* best-effort lifecycle log */
    });
}

export async function provisionContainer(userId: string): Promise<HermesContainerConfig> {
  // 1) Idempotency check — already running?
  const existing = await getContainerRow(userId);
  if (existing && existing.status === "running") {
    const alive = await isContainerAlive(existing.containerName);
    // isContainerAlive uses runDockerSilent which swallows transient docker
    // errors → false. Before tearing down + re-provisioning (which then hits a
    // `docker run --name` conflict on the still-present container → an endless
    // [retry] provision loop), positively confirm the container is genuinely
    // GONE. If it still exists by name, ADOPT it (keep its existing token,
    // never rotate) instead of recreating.
    if (alive || (await containerExists(existing.containerName))) {
      if (!alive) {
        await db
          .update(userContainers)
          .set({ status: "running", lastHealthAt: new Date(), updatedAt: new Date() })
          .where(eq(userContainers.userId, userId));
      }
      return {
        userId,
        containerName: existing.containerName,
        port: existing.port,
        bridgeToken: existing.gatewayToken,
        volumePath: volumeName(userId),
        imageVersion: existing.imageVersion ?? hermesConfig.image,
      };
    }
    // Genuinely gone — mark stopped + fall through to re-provision
    await db
      .update(userContainers)
      .set({ status: "stopped", updatedAt: new Date() })
      .where(eq(userContainers.userId, userId));
  }

  // 2) Claim port (race-safe via container_port_slot)
  const port = await claimPort(userId);

  // 3) Generate bridge token
  const bridgeToken = generateBridgeToken();

  // 4) Insert or update DB row to "queued"
  const containerName = `${hermesConfig.containerPrefix}-${userId.slice(0, 16)}`;
  const now = new Date();

  if (existing) {
    await db
      .update(userContainers)
      .set({
        gatewayToken: bridgeToken,
        port,
        containerName,
        status: "queued",
        provisionAttempts: existing.provisionAttempts + 1,
        errorMessage: null,
        updatedAt: now,
      })
      .where(eq(userContainers.userId, userId));
  } else {
    await db.insert(userContainers).values({
      userId,
      gatewayToken: bridgeToken,
      port,
      containerName,
      status: "queued",
      provisionAttempts: 1,
      createdAt: now,
      updatedAt: now,
    });
  }

  try {
    // 5) Ensure network + volume exist
    await ensureIsolatedNetwork();
    await ensureVolume(volumeName(userId));

    // 6) Mark starting + spawn container (no separate initVolume needed —
    //    bridge entrypoint seeds config from env on first run)
    await setStatus(userId, "starting");

    // 7) Destroy any stale container with the same name (defensive)
    await destroyContainerByName(containerName);

    // 8) Run the container
    await runContainer({
      userId,
      containerName,
      port,
      bridgeToken,
    });

    // 9) Wait for healthcheck
    await setStatus(userId, "awaiting-health");
    await waitForHealth(port);

    // 10) Mark running
    await db
      .update(userContainers)
      .set({
        status: "running",
        errorMessage: null,
        lastHealthAt: new Date(),
        imageVersion: hermesConfig.image,
        updatedAt: new Date(),
      })
      .where(eq(userContainers.userId, userId));

    recordContainerEvent(userId, "provision", true);

    // 11) Self-heal paid skills onto the fresh volume. A destroy → reprovision
    // gives the user a brand-new empty volume, so any marketplace skill they
    // already paid for must be re-installed. Fire-and-forget — the retry worker
    // owns delivery; we MUST NOT await installs here (would blow out the
    // health-check latency window for the /loby redirect). Dynamic import keeps
    // the billing module out of the provisioning module's load graph (avoids a
    // potential circular import: skill-installer pulls gateway-client which
    // pulls config which... — lazy import sidesteps the whole question).
    void import("@/lib/billing/skill-installer")
      .then(({ reinstallSkillsForUser }) => reinstallSkillsForUser(userId))
      .then((n) => {
        if (n > 0) {
          console.log(
            `[provision] re-queued ${n} paid skill(s) for user=${userId} onto fresh volume`,
          );
        }
      })
      .catch((e) => {
        console.error(
          `[provision] skill self-heal dispatch failed for user=${userId}:`,
          e,
        );
      });

    // 12. Re-dress the agent (persona + BYOK keys) onto the fresh volume, same
    //     resilient path onboarding uses. NO-OP during the initial onboarding
    //     (the complete route provisions BEFORE writing the user_agent spec, so
    //     this reads no spec → {kind:"no-spec"}); on a rebuild/retry the spec
    //     already exists so it re-applies it. Fire-and-forget — the apply job
    //     owns its own retry of the post-boot RPC race. Lazy import mirrors the
    //     skill self-heal above (keeps onboarding off the provision load graph).
    void import("@/lib/onboarding/apply-to-container")
      .then(({ applyOnboardingToContainer }) =>
        applyOnboardingToContainer(userId, { port, bridgeToken }),
      )
      .then((r) => {
        if (r && r.kind === "applied") {
          console.log(
            `[provision] re-dressed agent for user=${userId} (${r.keysApplied} key(s))`,
          );
        }
      })
      .catch((e) => {
        console.error(
          `[provision] agent re-dress dispatch failed for user=${userId}:`,
          e,
        );
      });

    return {
      userId,
      containerName,
      port,
      bridgeToken,
      volumePath: volumeName(userId),
      imageVersion: hermesConfig.image,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await db
      .update(userContainers)
      .set({
        status: "failed",
        errorMessage: truncate(message, 500),
        updatedAt: new Date(),
      })
      .where(eq(userContainers.userId, userId));
    recordContainerEvent(userId, "provision", false, message);
    throw err;
  }
}

/**
 * Read current state of user's container from DB.
 * Returns null if no container row exists.
 */
export async function getContainerStatus(
  userId: string,
): Promise<{
  port: number;
  bridgeToken: string;
  containerName: string;
  status: ContainerStatus;
  errorMessage: string | null;
  createdAt: Date;
  lastHealthAt: Date | null;
} | null> {
  const row = await getContainerRow(userId);
  if (!row) return null;
  return {
    port: row.port,
    bridgeToken: row.gatewayToken,
    containerName: row.containerName,
    status: row.status as ContainerStatus,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    lastHealthAt: row.lastHealthAt,
  };
}

/**
 * Stop the container without destroying its volume (preserves all user data).
 */
export async function stopContainer(userId: string): Promise<void> {
  const row = await getContainerRow(userId);
  if (!row) return;
  // Idempotent: the lifecycle worker's expire pass and the orphan-reconcile
  // pass can both target the same user in overlapping ticks. Skip if already
  // stopped/destroyed so `docker stop` never errors on a non-running container.
  if (row.status === "stopped" || row.status === "destroyed") return;
  await runDockerOk(["stop", row.containerName]);
  await db
    .update(userContainers)
    .set({ status: "stopped", updatedAt: new Date() })
    .where(eq(userContainers.userId, userId));
  recordContainerEvent(userId, "stop", true);
}

/**
 * Start a previously-stopped container (volume + data preserved).
 */
export async function startContainer(userId: string): Promise<void> {
  const row = await getContainerRow(userId);
  if (!row) return;
  try {
    await runDockerOk(["start", row.containerName]);
    await setStatus(userId, "awaiting-health");
    await waitForHealth(row.port);
    await db
      .update(userContainers)
      .set({
        status: "running",
        lastHealthAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(userContainers.userId, userId));
    recordContainerEvent(userId, "start", true);
  } catch (err) {
    // Record the real failure so the fleet log doesn't show a phantom success
    // (admin start is fire-and-forget; without this the failure was console-only).
    const message = err instanceof Error ? err.message : String(err);
    recordContainerEvent(userId, "start", false, message);
    throw err;
  }
}

/**
 * Hard destroy: remove container + volume, release port slot.
 * Used by /api/account/delete + admin reset scripts.
 */
export async function destroyContainer(userId: string): Promise<void> {
  const row = await getContainerRow(userId);
  if (!row) return;

  // Best-effort: stop + remove regardless of engine type so callers can
  // clean up after a partial migration.
  await destroyContainerByName(row.containerName);

  // Remove the volume too — caller wants it gone.
  await runDockerSilent(["volume", "rm", volumeName(userId)]);

  // Release port
  await releasePort(userId);

  // Mark row as destroyed (don't delete row — preserve audit trail).
  // Caller (account-delete) may CASCADE delete the user row, which cascades here.
  await db
    .update(userContainers)
    .set({
      status: "destroyed",
      containerId: null,
      errorMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(userContainers.userId, userId));
  recordContainerEvent(userId, "destroy", true);
}

// ---------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------

function generateBridgeToken(): string {
  // 32 bytes = 64 hex chars → meets bridge auth.py minimum (16, recommend 32)
  return randomBytes(32).toString("hex");
}

export function volumeName(userId: string): string {
  // Defense-in-depth: the result becomes a docker `-v <vol>` arg, and our
  // shellEscape double-quotes but does not block $()/backtick substitution.
  // NextAuth ids are always uuid/cuid; reject anything else so a crafted id can
  // never reach the shell (route boundaries also validate, this is the backstop).
  if (!/^[a-zA-Z0-9_-]+$/.test(userId)) {
    throw new Error("unsafe userId for volume name");
  }
  return `${hermesConfig.volumePrefix}-${userId.slice(0, 16)}`;
}

async function getContainerRow(userId: string) {
  const [row] = await db
    .select()
    .from(userContainers)
    .where(eq(userContainers.userId, userId))
    .limit(1);
  return row ?? null;
}

/**
 * Resolve the per-user IANA timezone for container env injection.
 * Reads user_profile.timezone (captured at onboarding); falls back to the
 * global hermesConfig.timezone default when unset or invalid.
 *
 * NOTE: env is fixed at `docker run`, so an already-running container keeps
 * its provisioned timezone until re-provisioned (or a Settings config.patch
 * with restart). New provisions pick up the per-user value immediately.
 */
async function resolveUserTimezone(
  userId: string,
  fallbackTz: string = hermesConfig.timezone,
): Promise<string> {
  try {
    const [row] = await db
      .select({ timezone: userProfiles.timezone })
      .from(userProfiles)
      .where(eq(userProfiles.userId, userId))
      .limit(1);
    const tz = row?.timezone?.trim();
    return tz && tz.length > 0 ? tz : fallbackTz;
  } catch {
    return fallbackTz;
  }
}

async function setStatus(userId: string, status: ContainerStatus): Promise<void> {
  await db
    .update(userContainers)
    .set({ status, updatedAt: new Date() })
    .where(eq(userContainers.userId, userId));
}

async function isContainerAlive(containerName: string): Promise<boolean> {
  const { stdout } = await runDockerSilent([
    "inspect",
    "--format",
    "{{.State.Running}}",
    containerName,
  ]);
  return stdout.trim() === "true";
}

// Positively confirm a container with this EXACT name exists (any state).
// Distinct from isContainerAlive: this answers "is it still there?" so a
// transient `docker inspect` hiccup does not trigger a destroy+recreate that
// then conflicts on the name. Anchored regex (^/name$) so prefixes don't match.
async function containerExists(containerName: string): Promise<boolean> {
  const { stdout } = await runDockerSilent([
    "ps",
    "-a",
    "--filter",
    `name=^/${containerName}$`,
    "--format",
    "{{.Names}}",
  ]);
  return stdout.split(/\r?\n/).some((l) => l.trim() === containerName);
}

async function ensureIsolatedNetwork(): Promise<void> {
  const name = hermesConfig.network;
  const { stdout } = await runDockerSilent(["network", "ls", "--format", "{{.Name}}"]);
  if (stdout.split(/\r?\n/).some((line) => line.trim() === name)) {
    return;
  }
  await runDockerOk([
    "network",
    "create",
    "--driver=bridge",
    "--opt",
    "com.docker.network.bridge.enable_icc=false",
    name,
  ]);
}

async function ensureVolume(name: string): Promise<void> {
  const { stdout } = await runDockerSilent(["volume", "ls", "--format", "{{.Name}}"]);
  if (stdout.split(/\r?\n/).some((line) => line.trim() === name)) {
    return;
  }
  await runDockerOk(["volume", "create", name]);
}

async function destroyContainerByName(name: string): Promise<void> {
  await runDockerSilent(["rm", "-f", name]);
}

interface RunContainerArgs {
  userId: string;
  containerName: string;
  port: number;
  bridgeToken: string;
}

async function runContainer(args: RunContainerArgs): Promise<void> {
  // Dashboard port: deterministic offset from the bridge port so we don't
  // need a 2nd port-pool table. Bridge pool is 18800-19299, dashboard
  // ports land in 28800-29299 — well clear of the bridge range.
  const dashboardHostPort = args.port + hermesConfig.dashboardPortOffset;

  // Bridge media-serve host port (token-URL HTTP file delivery — see
  // `docker/hermes-bridge/media_serve.py`). Same per-user offset pattern
  // as dashboard. The bridge embeds this host:port pair into the
  // attachment displayUrl AND into PORTAL_ATTACHMENT_URLS sentinel so
  // the same URL survives session persistence + page refresh.
  const bridgeHealthHostPort = args.port + hermesConfig.bridgeHealthPortOffset;

  // Resolve the subscription tier ONCE; an admin can override the env-backed
  // engine defaults + container caps per tier via admin_setting (admin-panel
  // D6/D7). Wrapped so a DB hiccup or unknown tier NEVER breaks provisioning.
  let tier: string | null = null;
  try {
    tier = (await resolveSubscription(args.userId)).tier;
  } catch (e) {
    console.error("[provision] tier resolution failed; using env defaults:", e);
  }

  // Per-tier engine defaults (model / lean-engine / auto-update + global tz
  // default). Seeded into the container env below; never throws.
  const engineDefaults = await resolveEngineDefaults(tier);

  // Per-user timezone (Chief #1 mandate): the agent's system-prompt date, cron,
  // channels, and libc clock follow the user's own locale instead of a hardcoded
  // WIB for everyone. Falls back to the admin/tier engine-default when unset.
  const timezone = await resolveUserTimezone(args.userId, engineDefaults.timezone);

  // Per-tier container resource caps (admin-panel D7). The operator can override
  // the env defaults per subscription tier via admin_setting; resolved here and
  // baked into the docker run flags below (applies on this provision/restart).
  // Wrapped so a DB hiccup NEVER breaks provisioning — any failure falls back to
  // the env caps. (resolveSetting rejects on a DB error rather than returning its
  // fallback, so the try/catch is load-bearing.)
  let memoryLimit = hermesConfig.memoryLimit;
  let cpuLimit = hermesConfig.cpuLimit;
  let pidsLimit = hermesConfig.pidsLimit;
  try {
    memoryLimit = await resolveSetting(
      "limit.container.memory",
      hermesConfig.memoryLimit,
      { tier },
    );
    cpuLimit = await resolveSetting(
      "limit.container.cpus",
      hermesConfig.cpuLimit,
      { tier },
    );
    pidsLimit = await resolveSetting(
      "limit.container.pids",
      hermesConfig.pidsLimit,
      { tier },
    );
  } catch (e) {
    console.error(
      "[provision] per-tier cap resolution failed; using env defaults:",
      e,
    );
  }

  // Per-tier media upload caps (admin-panel D7). Resolved for the user's effective
  // tier (resolveUserLimits handles trial -> op_buff) and injected as BYTES; the
  // bridge reads these env vars to override its attachment-cap constants. Never
  // throws — a failure falls back to the marketing-baseline media caps, which equal
  // the bridge's own defaults, so the bridge behaves exactly as today.
  const MB = 1_000_000;
  const limits = await resolveUserLimits(args.userId).catch(() => null);
  const media = limits?.media ?? {
    imageMb: 50,
    audioMb: 100,
    videoMb: 200,
    documentMb: 100,
    filesPerMessage: 10,
    totalMb: 300,
  };

  const env: Record<string, string> = {
    BRIDGE_TOKEN: args.bridgeToken,
    BRIDGE_PORT: String(hermesConfig.bridgePortInside),
    BRIDGE_HEALTH_PORT: String(hermesConfig.bridgeHealthPortInside),
    BRIDGE_HOST: "0.0.0.0",
    // `attachment_preprocessor.py::_register_and_record` reads these to
    // build the public displayUrl. Must match the host:port we actually
    // publish below — otherwise the URL we embed in PORTAL_ATTACHMENT_URLS
    // would point at a dead address and chief's audio would never load.
    BRIDGE_PUBLIC_HOST: hermesConfig.publicHost,
    BRIDGE_PUBLIC_HEALTH_PORT: String(bridgeHealthHostPort),
    // Per-tier media upload caps (D7) — bytes. The bridge's attachment
    // preprocessor reads these to override its hardcoded constants. Applies on
    // this provision/restart (frozen at docker run, like the resource caps).
    AGENTBUFF_MAX_IMAGE_BYTES: String(media.imageMb * MB),
    AGENTBUFF_MAX_AUDIO_BYTES: String(media.audioMb * MB),
    AGENTBUFF_MAX_VIDEO_BYTES: String(media.videoMb * MB),
    AGENTBUFF_MAX_DOCUMENT_BYTES: String(media.documentMb * MB),
    AGENTBUFF_MAX_FILES_PER_MESSAGE: String(media.filesPerMessage),
    AGENTBUFF_MAX_TOTAL_BYTES: String(media.totalMb * MB),
    // Per-tier entitlement gate (D7). When true, the bridge fetches the user's
    // {maxAgents,maxChannels,maxSkills} from /api/users/me/limits and blocks
    // agents.create / channels.pair / skills.install over the cap. Default on.
    AGENTBUFF_TIER_LIMITS_ENABLED: hermesConfig.tierLimitsEnabled ? "true" : "false",
    HERMES_HOME: "/home/hermes/.hermes",
    // Triggers Hermes' `PLATFORM_HINTS["webui"]` system-prompt block which
    // explicitly tells the agent: "to display media inline, include
    // MEDIA:/absolute/path or MEDIA:https://...". Without this env, agent
    // describes file paths in prose instead of emitting MEDIA: tags →
    // bridge can't extract media → no AudioCard/ImageCard/VideoCard
    // renders. Verified hint exists in 0.14.0 via
    // `docker exec ... python -c "from agent.prompt_builder import PLATFORM_HINTS; print('webui' in PLATFORM_HINTS)"`.
    HERMES_PLATFORM: "webui",
    // Timezone — engine injects the current DATE into every agent's system
    // prompt via hermes_time.now() (reads HERMES_TIMEZONE first). Without this
    // the container runs UTC and the agent thinks it's ~7h behind WIB. TZ also
    // sets libc/system clock so shell `date`, cron, and logs are WIB.
    HERMES_TIMEZONE: timezone,
    TZ: timezone,
    // Default model is the per-tier admin override (engine-defaults D6), env
    // fallback. The provider key seed stays env-only (BYOK safety gate).
    // HACKATHON (isolated copy): seed the operator NVIDIA NIM key + pin Nemotron
    // so every container boots with a working managed brain → onboarding's
    // verify-provider finds a valid provider and /app chats on Nemotron. The
    // empty-string filter below makes this a no-op when NVIDIA_API_KEY is unset.
    HERMES_DEFAULT_MODEL: process.env.NVIDIA_API_KEY
      ? "nvidia/nemotron-3-super-120b-a12b"
      : engineDefaults.model,
    HERMES_DEFAULT_API_KEY: hermesConfig.defaultApiKey,
    HERMES_DEFAULT_GEMINI_KEY: hermesConfig.defaultGeminiKey,
    NVIDIA_API_KEY: process.env.NVIDIA_API_KEY ?? "",
    // HACKATHON: shared secret so the agent can call the internal BuffHub-buy
    // endpoint (the agent-driven purchase). Empty -> filtered out (no-op).
    INTERNAL_BRIDGE_SECRET: process.env.INTERNAL_BRIDGE_SECRET ?? "",
    PORTAL_BASE_URL: hermesConfig.portalBaseUrl,
    ENERGY_GATE_ENABLED: hermesConfig.energyGateEnabled ? "true" : "false",
    // Lean engine: run containers as stock vanilla Hermes (no AgentBuff
    // plugins, no optional "junk" skill packs). Per-tier admin override (D6),
    // env fallback.
    AGENTBUFF_LEAN_ENGINE: engineDefaults.leanEngine ? "true" : "false",
    MIN_ENERGY_TO_PROMPT: String(hermesConfig.minEnergyToPrompt),
    STRICT_ON_PORTAL_DOWN: hermesConfig.strictOnPortalDown ? "true" : "false",
    HERMES_AUTO_UPDATE: engineDefaults.autoUpdate ? "true" : "false",
    HERMES_UPDATE_INTERVAL_HOURS: String(hermesConfig.autoUpdateIntervalHours),
    HERMES_UPDATE_WINDOW: hermesConfig.autoUpdateWindow,
    HERMES_PINNED_VERSION: hermesConfig.pinnedVersion,
    HERMES_BLOCKED_VERSIONS: hermesConfig.blockedVersions,
    LOG_LEVEL: hermesConfig.logLevel,
    BRIDGE_TRACE_EVENTS: process.env.BRIDGE_TRACE_EVENTS ?? "",
    // Override Hermes WhatsApp adapter's hardcoded
    // `DEFAULT_REPLY_PREFIX = "⚕ *Hermes Agent*\n────────────\n"` so
    // outbound WhatsApp messages don't leak the upstream engine brand.
    // See gateway/platforms/whatsapp.py:262 — the adapter reads this env
    // (via WHATSAPP_REPLY_PREFIX) when channel.extra.reply_prefix is unset.
    WHATSAPP_REPLY_PREFIX: "⚡ *Buff*\\n────────────\\n",
  };

  const envArgs: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || value === null || value === "") continue;
    envArgs.push("-e", `${key}=${value}`);
  }

  const runArgs = [
    "run",
    "-d",
    "--name", args.containerName,
    "--network", hermesConfig.network,
    "--restart", "unless-stopped",
    // Loopback-only port publish — bridge WS for portal /api/ws/hermes
    "-p", `${hermesConfig.bindHost}:${args.port}:${hermesConfig.bridgePortInside}`,
    // Loopback-only port publish — Hermes admin dashboard (`hermes dashboard`)
    // for /loby redirect target so chief can compare with /app.
    "-p", `${hermesConfig.bindHost}:${dashboardHostPort}:${hermesConfig.dashboardPortInside}`,
    // Loopback-only port publish — bridge media-serve HTTP delivery
    // (token URLs for user uploads + bot-generated MEDIA: files). The
    // browser hits `http://127.0.0.1:<bridgeHealthHostPort>/media/...`
    // when rendering AudioCard / ImageCard / VideoCard / DocumentCard.
    "-p", `${hermesConfig.bindHost}:${bridgeHealthHostPort}:${hermesConfig.bridgeHealthPortInside}`,
    // Resource caps (per-tier via admin_setting; env fallback). See above.
    "--memory", memoryLimit,
    "--cpus", cpuLimit,
    "--pids-limit", String(pidsLimit),
    // Hardening
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    // Host gateway resolution for Linux Docker (Windows/macOS already have it)
    "--add-host", "host.docker.internal:host-gateway",
    // Volume mount for persistent data
    "-v", `${volumeName(args.userId)}:/home/hermes/.hermes`,
    // Env
    ...envArgs,
    // Image
    hermesConfig.image,
  ];

  const { stdout } = await runDockerOk(runArgs);
  const containerId = stdout.trim();
  await db
    .update(userContainers)
    .set({ containerId, updatedAt: new Date() })
    .where(eq(userContainers.userId, args.userId));
}

/**
 * Poll the bridge health endpoint until it responds 200, or timeout.
 *
 * Two layers of resilience:
 *   1. Auto-restart on persistent ECONNREFUSED (Windows vpnkit race)
 *   2. Per-iteration timeout so a slow Hermes pip install doesn't hang us
 */
async function waitForHealth(port: number): Promise<void> {
  const deadline = Date.now() + hermesConfig.healthTimeoutMs;
  const interval = hermesConfig.healthIntervalMs;
  // Bridge health endpoint inside container is bridgeHealthPortInside,
  // but it's NOT published to host. We probe the published bridge WS port
  // by attempting a TCP connect — the bridge WS server is up == container healthy.
  // Alternative: publish health port and probe HTTP. For now, TCP probe is enough.
  let firstRefusedAt: number | null = null;
  let restartedOnce = false;

  while (Date.now() < deadline) {
    const ok = await tcpProbe(hermesConfig.bindHost, port, 1500);
    if (ok) {
      return;
    }

    if (firstRefusedAt === null) {
      firstRefusedAt = Date.now();
    }

    // After 30s of refused connections, try a `docker restart` once
    // (Windows Docker Desktop vpnkit port-forward race fix).
    if (!restartedOnce && Date.now() - firstRefusedAt > 30000) {
      restartedOnce = true;
      try {
        // Look up container name from DB
        const row = await db
          .select({ containerName: userContainers.containerName })
          .from(userContainers)
          .where(eq(userContainers.port, port))
          .limit(1);
        if (row[0]?.containerName) {
          await runDockerSilent(["restart", row[0].containerName]);
        }
      } catch {
        // best-effort; ignore failures
      }
    }

    await sleep(interval);
  }

  throw new Error(
    `bridge did not become healthy on port ${port} within ${hermesConfig.healthTimeoutMs}ms`,
  );
}

async function tcpProbe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const net = await import("node:net");
  return new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const cleanup = () => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => {
      cleanup();
      resolve(true);
    });
    socket.once("timeout", () => {
      cleanup();
      resolve(false);
    });
    socket.once("error", () => {
      cleanup();
      resolve(false);
    });
    try {
      socket.connect(port, host);
    } catch {
      cleanup();
      resolve(false);
    }
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// ---------------------------------------------------------------------
// Docker CLI runners
// ---------------------------------------------------------------------

/** Run docker; throw on non-zero exit. */
export async function runDockerOk(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const cmd = "docker " + args.map(shellEscape).join(" ");
  try {
    return await exec(cmd, { maxBuffer: 16 * 1024 * 1024 });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`docker command failed: ${cmd}\n${msg}`);
  }
}

/** Run docker; swallow errors (used for inspection commands). */
export async function runDockerSilent(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const cmd = "docker " + args.map(shellEscape).join(" ");
  try {
    return await exec(cmd, { maxBuffer: 16 * 1024 * 1024 });
  } catch {
    return { stdout: "", stderr: "" };
  }
}

function shellEscape(arg: string): string {
  // Minimal shell escape — works on Windows bash + POSIX shells
  if (/^[A-Za-z0-9_./:=@%-]+$/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '\\"')}"`;
}

/**
 * Provisional fire-and-forget helper used by registration handler.
 * Wraps `provisionContainer` to swallow errors (we don't want signup
 * to fail if Docker is down — user can retry from /loby).
 */
export function fireAndForgetProvision(userId: string): void {
  void (async () => {
    try {
      await provisionContainer(userId);
    } catch (err) {
      console.error(
        `[hermes/docker] background provision failed for user=${userId}:`,
        err,
      );
    }
  })();
}

// Export raw helpers for admin scripts
export const __testing__ = {
  ensureIsolatedNetwork,
  ensureVolume,
  destroyContainerByName,
  runDockerOk,
  runDockerSilent,
  volumeName,
};
