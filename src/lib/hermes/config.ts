/**
 * src/lib/hermes/config.ts
 *
 * Environment-variable-backed configuration for Hermes container provisioning.
 *
 * Mirrors the contract shape of `src/lib/openclaw/config.ts` so call sites
 * can swap by import path; semantics differ where Hermes operates
 * differently (e.g., no Control-UI bind mount because the rebrand is the
 * portal's own /app, not a Lit fork).
 *
 * Convention: read env at module load (cached at first import) so callers
 * don't pay the lookup cost per call.
 */

const PARSED_INT_CACHE = new Map<string, number>();

function envInt(name: string, defaultValue: number): number {
  const cached = PARSED_INT_CACHE.get(name);
  if (cached !== undefined) return cached;
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    PARSED_INT_CACHE.set(name, defaultValue);
    return defaultValue;
  }
  const parsed = Number.parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    console.warn(
      `[hermes/config] env ${name}=${JSON.stringify(raw)} is not an int; using default ${defaultValue}`,
    );
    PARSED_INT_CACHE.set(name, defaultValue);
    return defaultValue;
  }
  PARSED_INT_CACHE.set(name, parsed);
  return parsed;
}

function envStr(name: string, defaultValue: string): string {
  const raw = process.env[name];
  return raw === undefined || raw === "" ? defaultValue : raw;
}

function envBool(name: string, defaultValue: boolean): boolean {
  const raw = (process.env[name] ?? "").toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return defaultValue;
}

export const hermesConfig = {
  // Container image — built by docker/Dockerfile.hermes
  // Pinned to a specific Hermes upstream version at build time;
  // override via HERMES_IMAGE if running custom-tagged image.
  get image(): string {
    // ISOLATED hackathon copy: fallbacks are hack-scoped so a missing-env run can
    // never resolve to a PRODUCTION resource (prod = hermes-agent:local). .env.local
    // supplies the real value; this default is purely a safety floor.
    return envStr("HERMES_IMAGE", "hermes-agent-hack:local");
  },

  // Port pool for published bridge WS port (host loopback only).
  get portMin(): number {
    return envInt("HERMES_PORT_MIN", 19300);
  },
  get portMax(): number {
    return envInt("HERMES_PORT_MAX", 19799);
  },

  // Bridge WebSocket port inside container
  get bridgePortInside(): number {
    return envInt("HERMES_BRIDGE_PORT_INSIDE", 18789);
  },

  // Bridge HTTP health endpoint inside container (separate from WS port)
  get bridgeHealthPortInside(): number {
    return envInt("HERMES_BRIDGE_HEALTH_PORT_INSIDE", 18790);
  },

  // `hermes dashboard` admin web UI port inside container. Published to
  // `port + dashboardPortOffset` on the host so /loby can redirect there.
  // Default 9119 matches Hermes' own CLI default.
  get dashboardPortInside(): number {
    return envInt("HERMES_DASHBOARD_PORT_INSIDE", 9119);
  },
  // Host-side offset for the published dashboard port. Bridge pool is
  // 18800-19299, dashboard pool lands at 28800-29299 — well clear so
  // there's no overlap as the pool grows.
  get dashboardPortOffset(): number {
    return envInt("HERMES_DASHBOARD_PORT_OFFSET", 10000);
  },

  // Host-side offset for the published bridge media-serve port (token-URL
  // HTTP file delivery — see `docker/hermes-bridge/media_serve.py`). The
  // browser side of /app fetches user-uploaded VN/image/video/document
  // attachments + bot-generated MEDIA: tag files from this port via
  // `http://127.0.0.1:<port>/media/<token>/<filename>`. Bridge pool
  // 18800-19299 → media-serve pool 38800-39299 (offset 20000) clears
  // both dashboard pool (28800-29299) and bridge pool itself with
  // plenty of headroom.
  get bridgeHealthPortOffset(): number {
    return envInt("HERMES_BRIDGE_HEALTH_PORT_OFFSET", 20000);
  },

  // Loopback-only publish host on the Docker engine side
  get bindHost(): string {
    return envStr("HERMES_BIND_HOST", "127.0.0.1");
  },

  // Host used by portal-side URL composition (mostly cosmetic since /app
  // is the UI and we don't redirect to a per-container URL anymore).
  get publicHost(): string {
    return envStr("HERMES_PUBLIC_HOST", "127.0.0.1");
  },

  // Docker network — ICC=off bridge enforces per-container isolation.
  // Hack-scoped fallback (prod = agentbuff_isolated) — see image getter note.
  get network(): string {
    return envStr("HERMES_NETWORK", "agentbuff_hack_isolated");
  },

  // Naming prefixes for Docker resources. Hack-scoped fallbacks (prod =
  // hermes-user) so destructive prefix-filtered scripts (reset-all.ts etc.) can
  // never match a PRODUCTION container/volume even if run without --env-file.
  get volumePrefix(): string {
    return envStr("HERMES_VOLUME_PREFIX", "hermes-hack-user");
  },
  get containerPrefix(): string {
    return envStr("HERMES_CONTAINER_PREFIX", "hermes-hack-user");
  },

  // D5 volume backup/restore (admin). Host directory where tarballs land + the
  // tiny image used as the tar sidecar. On VPS (DOCKER_HOST=ssh://) the backup
  // dir is the REMOTE host's path. Defaults under the repo so dev works out of
  // the box; set HERMES_VOLUME_BACKUP_DIR to a real path in prod.
  get volumeBackupDir(): string {
    return envStr(
      "HERMES_VOLUME_BACKUP_DIR",
      `${process.cwd()}/.volume-backups`,
    );
  },
  get tarImage(): string {
    return envStr("HERMES_TAR_IMAGE", "alpine:3.20");
  },

  // Resource caps
  get memoryLimit(): string {
    return envStr("HERMES_MEM_LIMIT", "2048m");
  },
  get cpuLimit(): string {
    return envStr("HERMES_CPU_LIMIT", "1.0");
  },
  get pidsLimit(): number {
    return envInt("HERMES_PIDS_LIMIT", 512);
  },

  // Healthcheck waits (used by provisionContainer.waitForHealth)
  get healthTimeoutMs(): number {
    return envInt("HERMES_HEALTH_TIMEOUT_MS", 120000);
  },
  get healthIntervalMs(): number {
    return envInt("HERMES_HEALTH_INTERVAL_MS", 1500);
  },

  // Provider keys + default model — pre-seeded into container env.
  //
  // BYOK SAFETY (Chief 2026-06-15): a brand-new user's container MUST start
  // with an EMPTY .env — it must never carry a provider key the user did not
  // enter themselves. The operator-default key (HERMES_DEFAULT_*) is a
  // local-dev convenience ONLY and is OFF unless explicitly opted in via
  // HERMES_SEED_DEFAULT_KEY=true. When off, defaultGeminiKey/defaultApiKey
  // return "" → docker.ts passes no key → the bridge's _seed_initial_config
  // skips the GEMINI_API_KEY write (its `if api_key:` guard stays false).
  // Existing containers are untouched (their .env was already written, and
  // skipping the seed never deletes an existing key).
  get seedDefaultKey(): boolean {
    return envBool("HERMES_SEED_DEFAULT_KEY", false);
  },
  get defaultGeminiKey(): string {
    if (!envBool("HERMES_SEED_DEFAULT_KEY", false)) return "";
    return envStr("HERMES_DEFAULT_GEMINI_KEY", "");
  },
  get defaultModel(): string {
    return envStr("HERMES_DEFAULT_MODEL", "google/gemini-2.5-flash");
  },
  // IANA timezone the engine uses for the date it injects into every agent's
  // system prompt (hermes_time.now → agent/system_prompt.py) + cron + logs.
  // Default WIB (Asia/Jakarta) for the Indonesian market; override per deploy.
  get timezone(): string {
    return envStr("HERMES_TIMEZONE", "Asia/Jakarta");
  },
  get defaultApiKey(): string {
    // Generic provider API key (any provider). Falls back to Gemini key.
    // Gated by HERMES_SEED_DEFAULT_KEY for the same BYOK reason as
    // defaultGeminiKey — new containers start with no seeded provider key.
    if (!envBool("HERMES_SEED_DEFAULT_KEY", false)) return "";
    const v = envStr("HERMES_DEFAULT_API_KEY", "");
    return v || envStr("HERMES_DEFAULT_GEMINI_KEY", "");
  },

  // Portal URL the bridge calls for energy balance checks.
  // host.docker.internal resolves to the host machine from inside Docker
  // Desktop on Windows/macOS. On Linux containers, requires
  // --add-host=host.docker.internal:host-gateway in the run args.
  get portalBaseUrl(): string {
    return envStr("HERMES_PORTAL_BASE_URL", "http://host.docker.internal:617");
  },

  // Energy gating policy (passed through to bridge as env)
  // BYOK PHASE (Chief 2026-06-02): AgentBuff saat ini full BYOK — user bawa
  // API key & model sendiri, jadi BELUM ada energy beneran. Gate ini (blokir
  // chat saat balance < min) HARUS off, kalau gak user BYOK balance habis →
  // ke-blok padahal bayar provider sendiri. Default false sampai skema energy
  // launch. Set HERMES_ENERGY_GATE_ENABLED=true untuk re-enable nanti.
  get energyGateEnabled(): boolean {
    return envBool("HERMES_ENERGY_GATE_ENABLED", false);
  },
  // Per-tier entitlement gate (D7). When true, the bridge enforces
  // {maxAgents,maxChannels,maxSkills} per tier on agents.create / channels.pair /
  // skills.install. Default on (Starter is constrained, OP Buff + Guild unlimited;
  // trial maps to op_buff). Kill-switch: HERMES_TIER_LIMITS_ENABLED=false.
  get tierLimitsEnabled(): boolean {
    return envBool("HERMES_TIER_LIMITS_ENABLED", true);
  },
  get minEnergyToPrompt(): number {
    return envInt("HERMES_MIN_ENERGY_TO_PROMPT", 1);
  },
  // Lean engine: provision containers as stock vanilla Hermes — no AgentBuff
  // multimodal/multichannel plugins, no optional "junk" skill packs. The agent
  // then mirrors a clean `hermes` install (lean tools + core skills only).
  // Set HERMES_LEAN_ENGINE=true in .env.local.
  get leanEngine(): boolean {
    return envBool("HERMES_LEAN_ENGINE", false);
  },
  get strictOnPortalDown(): boolean {
    return envBool("HERMES_STRICT_ON_PORTAL_DOWN", false);
  },

  // Hermes auto-update — see docker/hermes-bridge/hermes_updater.py
  get autoUpdate(): boolean {
    return envBool("HERMES_AUTO_UPDATE", false);
  },
  get autoUpdateIntervalHours(): number {
    return envInt("HERMES_UPDATE_INTERVAL_HOURS", 6);
  },
  get autoUpdateWindow(): string {
    return envStr("HERMES_UPDATE_WINDOW", ""); // empty = any time
  },
  get pinnedVersion(): string {
    return envStr("HERMES_PINNED_VERSION", "");
  },
  get blockedVersions(): string {
    return envStr("HERMES_BLOCKED_VERSIONS", "");
  },

  // Usage poller / billing
  // BYOK PHASE (Chief 2026-06-02): poller debit energy per token, lalu saat
  // balance <= 0 men-`docker stop` container. Untuk BYOK ini SALAH + bahaya
  // (user bayar provider sendiri, gak boleh di-meter/di-stop). Default DISABLED
  // sampai skema energy launch. Set HERMES_USAGE_POLLER_DISABLED=false untuk
  // re-enable nanti. (debitEnergy/throttle/midtrans tetap utuh, cuma gak
  // dipanggil selama poller off.)
  get usagePollerEnabled(): boolean {
    return !envBool("HERMES_USAGE_POLLER_DISABLED", true);
  },
  get usagePollIntervalMs(): number {
    return envInt("HERMES_USAGE_POLL_INTERVAL_MS", 20000);
  },
  get usagePollConcurrency(): number {
    return envInt("HERMES_USAGE_POLL_CONCURRENCY", 8);
  },
  get tokensPerEnergy(): number {
    return envInt("HERMES_TOKENS_PER_ENERGY", 2000);
  },
  get balanceGraceMs(): number {
    return envInt("HERMES_BALANCE_GRACE_MS", 10000);
  },

  // Logging
  get logLevel(): string {
    return envStr("HERMES_LOG_LEVEL", "INFO");
  },
};

export type HermesConfig = typeof hermesConfig;
