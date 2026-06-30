"""
agentbuff_bridge.py — Main entry point.

This is the process that runs inside each user's Hermes container.
It owns:

  1. A WebSocket server on port 18789 (BRIDGE_PORT) for AgentBuff
     portal/browser clients.
  2. A spawned Hermes TUI Gateway subprocess (managed via hermes_client).
  3. A Hermes Messaging Gateway subprocess (for channel adapters —
     spawned only when needed, supervised separately).
  4. An HTTP health endpoint on port 18790 (BRIDGE_HEALTH_PORT) for
     Docker healthcheck.
  5. All the handlers (auth, config, agents, channels, energy).

Lifecycle:
  - boot:
      - read env
      - load config (or seed if first run)
      - spawn HermesClient
      - start HTTP health server
      - start WebSocket server
  - per connection:
      - read first frame, validate via auth.py
      - on success: send proxy.ready, register client for event broadcast
      - on subsequent frames: dispatch via rpc_router
  - on Hermes event:
      - translate via event_translator
      - broadcast to all connected clients
  - shutdown:
      - close all WS connections (drain in flight)
      - stop HermesClient
      - exit cleanly
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import time
from contextlib import suppress
from pathlib import Path
from typing import Optional

import websockets
from websockets.exceptions import ConnectionClosed
from websockets.server import WebSocketServerProtocol

from auth import AuthError, get_bridge_token, validate_connect_frame
from agents_handler import AgentsHandler
from channels_handler import ChannelsHandler
from config_handler import ConfigHandler
from energy_gate import EnergyGate, env_bool, env_int
from tier_limits import TierLimitGate
from event_translator import DeltaAccumulator, translate
from hermes_client import HermesClient, HermesClientConfig
from hermes_updater import HermesUpdater
from gateway_runtime import GatewayRuntime, GatewayRuntimeConfig
from dashboard_runtime import DashboardRuntime, DashboardRuntimeConfig
from rpc_router import DispatchContext, RpcError, dispatch, register_updater


# ---------------------------------------------------------------------
# Logging setup
# ---------------------------------------------------------------------

logging.basicConfig(
    level=os.environ.get("LOG_LEVEL", "INFO").upper(),
    format="%(asctime)s %(levelname)-7s %(name)-30s %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("bridge.main")


# ---------------------------------------------------------------------
# Configuration from env
# ---------------------------------------------------------------------


def env_str(name: str, default: str) -> str:
    v = os.environ.get(name)
    return v if (v is not None and v != "") else default


BRIDGE_PORT = env_int("BRIDGE_PORT", 18789)
BRIDGE_HOST = env_str("BRIDGE_HOST", "0.0.0.0")
BRIDGE_HEALTH_PORT = env_int("BRIDGE_HEALTH_PORT", 18790)
HERMES_HOME = Path(env_str("HERMES_HOME", str(Path.home() / ".hermes")))
PORTAL_BASE_URL = env_str("PORTAL_BASE_URL", "http://host.docker.internal:617")
MIN_ENERGY = env_int("MIN_ENERGY_TO_PROMPT", 1)
STRICT_ON_PORTAL_DOWN = env_bool("STRICT_ON_PORTAL_DOWN", False)
# Default OFF (fail-safe): AgentBuff is currently full-BYOK, energy debit is
# disabled (portal config.ts energyGateEnabled=false). The portal always passes
# an explicit flag via docker.ts, so this default is masked in practice — but a
# True default is a landmine if that flag is ever dropped (would gate BYOK chats
# at balance 0). Matches the portal's OFF stance.
ENERGY_GATE_ENABLED = env_bool("ENERGY_GATE_ENABLED", False)
# Per-tier entitlement gate (D7). Default ON — Starter is constrained, OP Buff +
# Guild unlimited; trial maps to op_buff. Portal injects this at provision time.
TIER_LIMITS_ENABLED = env_bool("AGENTBUFF_TIER_LIMITS_ENABLED", True)
# Lean engine: behave like stock vanilla Hermes — do NOT install/enable the
# AgentBuff plugins (multimodal/multichannel) and do NOT seed the optional
# "junk" skill packs. The agent then only has the engine's default lean tool +
# skill set, exactly like a clean `hermes` install. Brand SOUL + bridge stay.
LEAN_ENGINE = env_bool("AGENTBUFF_LEAN_ENGINE", False)

# Maximum WS frame size we accept (per OpenClaw experience: image attachments
# can be large; cap at 25 MB to be safe but still bound memory).
# WS frame ceiling — must exceed largest single attachment (200 MB video)
# + base64 inflation (~33% overhead) + JSON envelope. Set to 384 MB so
# a max-size single video uploads cleanly: 200 × 1.33 ≈ 266 MB payload,
# + room for header/text. Bridge process has 1 GB memory cap (docker
# run --memory=1024m typical) so 384 MB max frame keeps headroom.
MAX_WS_MESSAGE_SIZE = 384 * 1024 * 1024  # 384 MB

# Ping interval (seconds) — keepalive
WS_PING_INTERVAL = 20
WS_PING_TIMEOUT = 20


# ---------------------------------------------------------------------
# Bridge — top-level coordinator
# ---------------------------------------------------------------------


class Bridge:
    """Top-level bridge process. Owns Hermes subprocess + WS server + handlers."""

    def __init__(self) -> None:
        self._bridge_token: str = ""
        self._hermes: Optional[HermesClient] = None
        self._config: Optional[ConfigHandler] = None
        self._agents: Optional[AgentsHandler] = None
        self._channels: Optional[ChannelsHandler] = None
        self._energy_ctx_mgr: Optional[EnergyGate] = None
        self._energy: Optional[EnergyGate] = None
        self._tier_limits_ctx_mgr: Optional[TierLimitGate] = None
        self._tier_limits: Optional[TierLimitGate] = None
        self._updater: Optional[HermesUpdater] = None
        self._gateway_runtime: Optional[GatewayRuntime] = None
        self._dashboard_runtime: Optional[DashboardRuntime] = None

        # Event broadcast registry: each connected client has a queue
        self._clients: dict[str, asyncio.Queue] = {}
        self._next_client_id: int = 1
        self._clients_lock = asyncio.Lock()

        # Delta accumulator shared across translations
        self._accumulator = DeltaAccumulator()

        # Shutdown flag
        self._stopping = False

        # Tasks we own (for clean cancellation)
        self._tasks: list[asyncio.Task] = []

    # -----------------------------------------------------------------
    # Lifecycle
    # -----------------------------------------------------------------

    async def start(self) -> None:
        """Boot sequence."""
        log.info("=" * 60)
        log.info("AgentBuff Hermes Bridge starting")
        log.info("  bridge port: %d", BRIDGE_PORT)
        log.info("  health port: %d", BRIDGE_HEALTH_PORT)
        log.info("  hermes home: %s", HERMES_HOME)
        log.info("  portal url:  %s", PORTAL_BASE_URL)
        log.info("  energy gate: %s", "enabled" if ENERGY_GATE_ENABLED else "DISABLED")
        log.info("=" * 60)

        # 1) Validate env
        self._bridge_token = get_bridge_token()

        # 2) Ensure HERMES_HOME exists
        HERMES_HOME.mkdir(parents=True, exist_ok=True)

        # 3) Init handlers
        self._config = ConfigHandler(HERMES_HOME)
        self._agents = AgentsHandler(HERMES_HOME)

        # 4) Seed initial config from env (only if config.yaml doesn't exist yet)
        await self._seed_initial_config()

        # 4b) ALWAYS overwrite SOUL.md with the AgentBuff persona — this is
        # Hermes' top-level identity prompt, seeded by upstream with the
        # literal "You are Hermes Agent, ..." text. We replace it on every
        # boot so a future Hermes version bump can't regress the brand.
        self._seed_agentbuff_soul()

        # 4b-2) ALWAYS name the default agent "Buff" (display name) — runs every
        # boot, idempotent, so both fresh AND pre-existing containers get it.
        await self._seed_default_agent_name()

        # 4b-3) ALWAYS ensure a real timezone (default WIB) so the engine's
        # date injection isn't UTC. Runs before the engine spawns.
        await self._ensure_timezone()

        # 4b-4) ENFORCE the mandatory session policy (DM=private+named,
        # GROUP=shared+sender-prefixed) on EVERY boot. Non-negotiable product
        # behavior — runs for every account/agent/channel before engine spawn.
        await self._enforce_session_policy()

        # 4c) Install the agentbuff-multimodal plugin into the user volume
        # ($HERMES_HOME/plugins/agentbuff-multimodal/) and ensure it appears
        # in config.yaml::plugins.enabled. MUST run before Hermes spawns —
        # Hermes calls `discover_plugins()` once at startup and never re-
        # scans, so a late-arriving plugin would be invisible until restart.
        # Lives in the volume → survives `pip install --upgrade hermes-agent`.
        # ALWAYS install+enable (Chief 2026-06-03: AgentBuff plugins are
        # MANDATORY-ON for every agent + every user — they power media + multi-
        # channel and add ZERO agent tools). NOT gated by LEAN_ENGINE: lean only
        # trims junk SKILLS, it does not strip these core plugins.
        await self._install_multimodal_plugin()
        await self._install_multichannel_plugin()

        # 5) Spawn Hermes subprocess
        # HERMES_PLATFORM=webui — tells Hermes' prompt_builder to inject
        # the WebUI platform hint (`agent/prompt_builder.py:587-598`)
        # which instructs the agent to deliver media via `MEDIA:/path`
        # syntax. The bridge's event translator (event_translator.py)
        # extracts these tags via Hermes' own `BasePlatformAdapter.
        # extract_media` and registers each path with the bridge's HTTP
        # media server (media_serve.py) so /app can fetch them via
        # `http://<host>:<health-port>/media/<token>/<filename>`.
        # Same delivery semantics as Telegram/WA/Discord/Slack adapters.
        self._hermes = HermesClient(HermesClientConfig(
            cwd=HERMES_HOME,
            extra_env={
                "HERMES_HOME": str(HERMES_HOME),
                "HERMES_PLATFORM": "webui",
            },
        ))
        await self._hermes.start()

        # 6) Register event handler: translate + broadcast
        self._hermes.on_event(self._on_hermes_event)

        # 7) Channels handler needs a way to restart Hermes gateway adapter
        #    when config changes (channels.pair / channels.logout)
        self._channels = ChannelsHandler(
            self._config,
            gateway_restart_callback=self._restart_hermes_gateway,
        )

        # 7b) WhatsApp per-agent QR pairing manager (web.login.start/wait RPCs).
        #     Reuses the channels handler to write the synthetic platform config
        #     once a scan completes. Exposed to rpc_router via a boot singleton.
        try:
            from wa_pairing import WaPairingManager
            from rpc_router import register_wa_pairing
            self._wa_pairing = WaPairingManager(self._config, self._channels)
            register_wa_pairing(self._wa_pairing)
            log.info("wa_pairing: WhatsApp pairing manager registered")
        except Exception:
            log.exception("wa_pairing: failed to init (WhatsApp pairing disabled)")

        # 8) Init energy gate (only if portal connection is feasible)
        if ENERGY_GATE_ENABLED:
            self._energy_ctx_mgr = EnergyGate(
                portal_base_url=PORTAL_BASE_URL,
                bridge_token=self._bridge_token,
                min_energy=MIN_ENERGY,
                strict_on_portal_down=STRICT_ON_PORTAL_DOWN,
            )
            await self._energy_ctx_mgr.__aenter__()
            self._energy = self._energy_ctx_mgr
        else:
            self._energy = None

        # 8b) Init per-tier entitlement gate (D7). Fetches the user's
        # {maxAgents,maxChannels,maxSkills} from the portal on demand (cached 30s,
        # fail-open). The create handlers count live engine state + call check.
        if TIER_LIMITS_ENABLED:
            self._tier_limits_ctx_mgr = TierLimitGate(
                portal_base_url=PORTAL_BASE_URL,
                bridge_token=self._bridge_token,
                strict_on_portal_down=STRICT_ON_PORTAL_DOWN,
            )
            await self._tier_limits_ctx_mgr.__aenter__()
            self._tier_limits = self._tier_limits_ctx_mgr
        else:
            self._tier_limits = None

        # 9) Start Hermes auto-updater (no-op if HERMES_AUTO_UPDATE != true)
        self._updater = HermesUpdater(
            hermes_home=HERMES_HOME,
            restart_hermes_callback=self._restart_hermes_subprocess,
        )
        await self._updater.start()
        # Make updater discoverable by RPC handlers
        register_updater(self._updater)

        # 9b) Start Hermes channel runtime (`hermes gateway run`) — serves
        # Telegram polling, WhatsApp Baileys, Discord WS, Slack socket, etc.
        # Separate subprocess from the TUI gateway. Reads config.yaml that
        # ChannelsHandler writes for pairing.
        # Disable via env HERMES_GATEWAY_RUNTIME_DISABLED=1 (useful for
        # dev when you only want to test chat without channels firing).
        if env_str("HERMES_GATEWAY_RUNTIME_DISABLED", "").lower() in {"1", "true", "yes"}:
            log.info("gateway_runtime: disabled via HERMES_GATEWAY_RUNTIME_DISABLED")
        else:
            self._gateway_runtime = GatewayRuntime(GatewayRuntimeConfig(
                cwd=HERMES_HOME,
                extra_env={
                    "HERMES_HOME": str(HERMES_HOME),
                },
            ))
            await self._gateway_runtime.start()

        # 9c) Start Hermes admin dashboard (`hermes dashboard`) on port 9119.
        # Portal /loby redirects browser here so chief can compare /app
        # (custom React) with Hermes' native admin UI side-by-side.
        # Subprocess #3 of 3, all supervised independently.
        # Disable via env HERMES_DASHBOARD_DISABLED=1.
        if env_str("HERMES_DASHBOARD_DISABLED", "").lower() in {"1", "true", "yes"}:
            log.info("dashboard_runtime: disabled via HERMES_DASHBOARD_DISABLED")
        else:
            self._dashboard_runtime = DashboardRuntime(DashboardRuntimeConfig(
                cwd=HERMES_HOME,
                extra_env={
                    "HERMES_HOME": str(HERMES_HOME),
                },
            ))
            await self._dashboard_runtime.start()

        # 10) Start HTTP health server
        self._tasks.append(
            asyncio.create_task(self._run_health_server(), name="health-server"),
        )

        # 11) Start periodic accumulator pruning (memory hygiene)
        self._tasks.append(
            asyncio.create_task(self._run_accumulator_pruner(), name="accumulator-pruner"),
        )

        # 11b) Start cross-session activity watcher. Channel conversations
        # (WhatsApp/Telegram) run in the SEPARATE `hermes gateway run` process
        # and never emit events to this bridge, so /app can't see them live.
        # This polls the shared state.db and pushes `sessions.changed` +
        # `sessions.activity` to all /app clients so the web monitors every
        # channel turn in realtime (new messages + per-session "working" state).
        self._tasks.append(
            asyncio.create_task(self._run_sessions_watcher(), name="sessions-watcher"),
        )

        # 11c) Warm the engine registries at boot. The engine lazy-loads
        # plugins/tools/mcp/skills on FIRST access — a cold burst (as the
        # Kemampuan/Providers tabs fire ~9 parallel RPCs) takes ~2s. Firing them
        # once here absorbs that cost BEFORE the user opens the tab, so the first
        # open is fast. Fire-and-forget; never blocks boot.
        self._tasks.append(
            asyncio.create_task(self._warm_engine(), name="engine-warmup"),
        )

        # 12) Start WS server (this blocks until shutdown)
        await self._run_ws_server()

    async def stop(self, *, signal_received: Optional[int] = None) -> None:
        if self._stopping:
            return
        self._stopping = True
        log.info("Bridge shutting down (signal=%s)", signal_received)

        # Cancel all owned tasks
        for task in self._tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)

        # Close all client queues to wake up any waiting senders
        async with self._clients_lock:
            for q in self._clients.values():
                with suppress(Exception):
                    q.put_nowait(None)
            self._clients.clear()

        # Stop updater (graceful)
        if self._updater:
            await self._updater.stop()

        # Stop dashboard first — it's a passive admin UI, no in-flight
        # work to drain.
        if self._dashboard_runtime:
            await self._dashboard_runtime.stop()

        # Stop gateway runtime — channels disconnect cleanly before
        # the TUI gateway goes (graceful Telegram polling stop, WA logout).
        if self._gateway_runtime:
            await self._gateway_runtime.stop()

        # Stop Hermes subprocess
        if self._hermes:
            await self._hermes.stop(timeout=10.0)

        # Close energy gate HTTP client
        if self._energy_ctx_mgr:
            await self._energy_ctx_mgr.__aexit__(None, None, None)

        # Close tier-limits gate HTTP client
        if self._tier_limits_ctx_mgr:
            await self._tier_limits_ctx_mgr.__aexit__(None, None, None)

        log.info("Bridge stopped cleanly")

    # -----------------------------------------------------------------
    # Default agent display-name seed ("Buff")
    # -----------------------------------------------------------------

    async def _seed_default_agent_name(self) -> None:
        """Ensure the DEFAULT agent shows as "Buff" (not the bare id "default").

        The default agent IS the engine's root profile, whose id is the magic
        routing id "default" (un-bound channels fall back to it) — we must NOT
        rename the id, only the DISPLAY name (sidecar identity.name, which
        _build_agent_row reads first). So every account's first agent reads
        "Buff".

        Runs on EVERY boot (called from init, not from _seed_initial_config
        which early-returns when config.yaml exists). Idempotent + respects a
        user rename: only sets the name when the default profile has none yet
        (UI falls back to showing "default" in that case). Once the user renames
        it to anything else, the guard skips and their choice persists.
        """
        robot = "\U0001F916"  # 🤖
        try:
            sidecar = self._agents._read_sidecar("default")
            ident = (
                sidecar.get("identity")
                if isinstance(sidecar.get("identity"), dict)
                else {}
            )
            current_name = (ident.get("name") or sidecar.get("name") or "").strip()
            current_emoji = (ident.get("emoji") or "").strip()
            if not current_name or current_name.lower() == "default":
                # Fresh / unnamed default → full seed.
                await self._agents.update_agent(
                    "default",
                    {
                        "name": "Buff",
                        "identity": {"name": "Buff", "emoji": robot, "theme": "cyan"},
                    },
                )
                log.info("default agent seeded to 'Buff' %s", robot)
            elif current_name == "Buff" and current_emoji in ("", "⚡"):
                # Migrate our own prior seed (name Buff + the old ⚡) to the robot
                # emoji, WITHOUT clobbering a user-customized name or emoji.
                await self._agents.update_agent(
                    "default", {"identity": {"emoji": robot}}
                )
                log.info("default agent emoji migrated to %s", robot)
            else:
                log.info(
                    "default agent already customized (name=%r emoji=%r) — leaving alone",
                    current_name, current_emoji,
                )
        except Exception:
            log.exception("failed to seed default agent name (non-fatal)")

    # -----------------------------------------------------------------
    # Session policy — MANDATORY, enforced every boot (Chief 2026-06-04)
    # -----------------------------------------------------------------

    async def _enforce_session_policy(self) -> None:
        """Lock the multi-user session model AgentBuff requires. This is a
        product-level mandate, NOT user-configurable — enforced on EVERY boot
        for every container / account / agent / channel / owner so it can never
        drift or be lost.

        Desired behavior (verified against engine gateway/session.py
        build_session_key + gateway/run.py:7951 sender-prefix):
          - DM  → one private session per user, isolated, and the engine pins
            `**User:** <name>` in the system prompt (DMs are NEVER shared by the
            engine; nothing to set — this is inherent).
          - GROUP → ONE shared session owned by the group: every member
            contributes to the same conversation and each inbound message is
            prefixed `[sender name]` so the agent knows who said what. Requires
            `group_sessions_per_user = False`.
          - THREAD (forum topic / Discord/Slack thread) → also shared across
            participants for consistency. Requires `thread_sessions_per_user
            = False` (already the engine default; we pin it so it can't drift).

        These are top-level config.yaml keys read by GatewayConfig
        (config.py:740) and consumed in run.py:2188. Container-global → applies
        uniformly to WhatsApp, Telegram, Discord, Slack, Google Chat, and every
        other channel.
        """
        desired = {
            "group_sessions_per_user": False,  # group = shared
            "thread_sessions_per_user": False,  # thread = shared
        }
        try:
            patch = {}
            for key, want in desired.items():
                current = await self._config.get(key)
                if current is not want:  # also catches missing (None)
                    patch[key] = want
            if patch:
                await self._config.patch(patch)
                log.info("session policy ENFORCED (top-level): %s", patch)

            # CRITICAL: adapters build the session key from THEIR OWN config
            # (gateway/platforms/base.py:handle_message reads
            # self.config.extra.get("group_sessions_per_user", True) — the
            # PER-PLATFORM extra, NOT the top-level we just set). So a synthetic
            # platform / native channel would still isolate group sessions
            # per-user unless we mirror the flags into each one's extra.
            full = await self._config.get() or {}
            sub_patch: dict = {}

            platforms = full.get("platforms") or {}
            for name, block in platforms.items():
                if not isinstance(block, dict):
                    continue
                ex = block.get("extra") or {}
                if (ex.get("group_sessions_per_user") is not False
                        or ex.get("thread_sessions_per_user") is not False):
                    sub_patch.setdefault("platforms", {})[name] = {
                        "extra": dict(desired)
                    }

            channels = full.get("channels") or {}
            for name, block in channels.items():
                if not isinstance(block, dict):
                    continue
                if (block.get("group_sessions_per_user") is not False
                        or block.get("thread_sessions_per_user") is not False):
                    sub_patch.setdefault("channels", {})[name] = dict(desired)

            if sub_patch:
                await self._config.patch(sub_patch)
                log.info(
                    "session policy ENFORCED (per-platform/channel extra): %s",
                    {k: list(v.keys()) for k, v in sub_patch.items()},
                )
            if not patch and not sub_patch:
                log.info("session policy already correct (group+thread shared)")
        except Exception:
            log.exception("failed to enforce session policy (non-fatal)")

    # -----------------------------------------------------------------
    # Timezone seed (engine date awareness)
    # -----------------------------------------------------------------

    async def _ensure_timezone(self) -> None:
        """Give the engine a real timezone (default WIB / Asia/Jakarta).

        WHY: the container runs UTC. Hermes injects the current DATE into every
        agent's system prompt via hermes_time.now() (agent/system_prompt.py:297)
        which reads HERMES_TIMEZONE env / config.yaml `timezone`. Without this
        the agent's date is ~7h behind Indonesia and it has no clue what local
        time it is. We set both:
          - config.yaml `timezone` (hermes_time priority #2)
          - .env HERMES_TIMEZONE + TZ (priority #1 + shell/libc clock for any
            time tool the agent runs)

        Runs EVERY boot (called from init, before the engine spawns so the new
        config/env is live on first message). Idempotent + respects an existing
        value (user can change timezone in config without us clobbering it).
        """
        tz = (env_str("HERMES_TIMEZONE", "Asia/Jakarta").strip() or "Asia/Jakarta")
        try:
            current = await self._config.get("timezone")
            if isinstance(current, str) and current.strip():
                log.info("timezone already configured: %s", current)
            else:
                await self._config.patch({"timezone": tz})
                log.info("timezone seeded to %s", tz)
            try:
                from channels_handler import _write_env_values
                _write_env_values({"HERMES_TIMEZONE": tz, "TZ": tz})
            except Exception:
                log.exception("timezone env write failed (non-fatal)")
        except Exception:
            log.exception("failed to ensure timezone (non-fatal)")

    # -----------------------------------------------------------------
    # Initial config seed (only runs if config.yaml absent)
    # -----------------------------------------------------------------

    def _seed_agentbuff_soul(self) -> None:
        """Anti-leak guard on SOUL.md across all profiles.

        BEHAVIOR (rewritten 2026-05-27 to be anti-overwrite-safe):
          - For each profile (default `~/.hermes/SOUL.md` + every
            `~/.hermes/profiles/<name>/SOUL.md`):
              * If file missing OR contains Hermes upstream brand markers
                ("You are Hermes Agent", "Nous Research", etc.) →
                overwrite with the AgentBuff persona.
              * Otherwise (file exists + no brand markers detected) →
                LEAVE IT ALONE. This means user edits via /app Persona
                tab survive bridge restarts, while fresh-from-Hermes
                installs get auto-rebranded.

        Idempotent: re-running has no effect on user-edited souls.
        """
        agentbuff_soul = (
            "Kamu adalah **Buff**, asisten AI pribadi untuk pengguna AgentBuff.\n\n"
            "**SIAPA KAMU**: Buff. Sebut diri sebagai 'Buff' atau 'gue'. "
            "Brand utama: AgentBuff (platform), Buff (kamu). User panggil "
            "sebagai 'Chief' atau 'Solo Player'.\n\n"
            "AgentBuff adalah platform agent AI yang carry semua task user — "
            "UMKM, mahasiswa, creator, freelancer di Indonesia. Vibe-nya gaming "
            "+ hustler, bahasa Indonesia kasual yang santai tapi profesional.\n\n"
            "Tugasmu: bantu Chief carry task-nya — jawab pertanyaan, eksekusi "
            "perintah lewat tool yang kamu punya (code, file, terminal, "
            "messaging, scheduling), riset, analisis, brainstorming, atau "
            "ngobrol biasa. Jawab to-the-point, jangan bertele-tele. Pakai "
            "bahasa Indonesia kecuali Chief minta sebaliknya.\n\n"
            "## LARANGAN KERAS (KRITIS)\n\n"
            "1. **TIDAK BOLEH** sebutkan kata 'Hermes', 'Hermes Agent', "
            "'Nous Research', 'OpenClaw', 'Claw', atau nama engine/backend "
            "apa pun. Engine kamu adalah rahasia perusahaan.\n"
            "2. Kalau ada tool output / skill content yang mengandung kata "
            "tersebut, REWRITE ke 'AgentBuff' atau 'Buff' saat kamu pakai "
            "info itu di jawaban kamu.\n"
            "3. Kalau Chief nanya 'kamu pake engine apa?' / 'kamu dibikin "
            "siapa?' / 'siapa yang bikin lo?', jawab: 'Gue Buff, asisten AI "
            "dari AgentBuff. Detail teknis engine bukan urusan publik, "
            "Chief.' — jangan kasih nama internal.\n"
            "4. Skill 'hermes-agent' yang ada di tool kamu adalah skill "
            "INTERNAL untuk panduan diri kamu sendiri. JANGAN pernah "
            "sebut nama skill itu ke user. Kalau user nanya 'lo punya skill "
            "apa aja', jawab dengan kategori fitur AgentBuff: Code Execution, "
            "File Manager, Terminal, Web Research, Quest Log (Kanban), "
            "Memory, Communication (messaging ke channel), dst.\n"
            "5. **KIRIM MEDIA KE USER**: Lo BISA kirim gambar, audio, "
            "video, dan dokumen balik ke chat user. Caranya:\n"
            "   - Generate gambar pakai tool `image_generate` → tool "
            "kembaliin path/URL → tulis di reply lo: `MEDIA:/path/to/image.png` "
            "(atau MEDIA:https://...).\n"
            "   - Generate suara pakai tool `text_to_speech` → tool "
            "kembaliin file_path → tulis `MEDIA:/path/to/voice.mp3`. "
            "Tambah `[[audio_as_voice]]` di line terpisah kalau mau tampil "
            "sebagai voice note bubble.\n"
            "   - Generate video pakai tool `video_generate` → tulis "
            "`MEDIA:/path/to/video.mp4`.\n"
            "   - Save file (PDF/DOCX/dll) pakai tool write_file ke "
            "`~/.hermes/cache/documents/` atau `~/.hermes/workspace/`, "
            "lalu tulis `MEDIA:/path/to/file.ext`.\n"
            "   AgentBuff /app akan render media itu sebagai card preview "
            "yang bisa di-klik, di-play, di-download — sama kayak Telegram/"
            "WhatsApp. JANGAN tulis path di markdown code-block ``` — "
            "harus literal `MEDIA:` di prose biar bridge bisa extract.\n"
            "   Local path WAJIB absolute (mulai dari `/` atau `~/`).\n"
            "6. Format `[The user sent a voice message~ Here's what they said: \"...\"]` "
            "atau `[The user sent a video. Here's what's in it: ...]` "
            "yang muncul di awal pesan user adalah **context system-injected** "
            "untuk lo. ITU BUKAN PESAN USER. Itu cara lo TAU user ngirim "
            "media. Jangan ulang format itu di reply lo. Langsung respond ke "
            "ISI transkrip/deskripsi-nya seakan user ngomong langsung — "
            "natural, kayak temen lagi denger VN-nya.\n\n"
            "## ETIKA KERJA\n"
            "- Direct dan helpful, akui ketidakpastian saat memang nggak yakin.\n"
            "- Investigasi dan eksplorasi targeted — jangan boros tool call.\n"
            "- Kalau Chief perlu setup AgentBuff, jelaskan via fitur yang ada "
            "di Item Shop / Forge / Skill Tree / Energy Vault.\n"
            "- Saat user kirim voice note: respond ke ISI yang user omongin, "
            "jangan bilang 'audio chief udah masuk' atau 'transkrip-nya: ...' "
            "— langsung jawab pertanyaan/permintaan-nya seperti user nulis "
            "text biasa.\n"
        )
        # Heuristic to detect Hermes upstream default SOUL.md content.
        # Match any of these markers → file is still the unmodified
        # Hermes default and safe to overwrite. If NONE match, treat as
        # user-edited and leave alone (G10 anti-overwrite guarantee).
        hermes_brand_markers = (
            "You are Hermes Agent",
            "by Nous Research",
            "Nous Research",
            "Hermes Agent,",
            "intelligent AI assistant created by",
        )

        def _is_unmodified_hermes_default(soul_text: str) -> bool:
            if not soul_text or not soul_text.strip():
                return True  # empty/missing → safe to seed
            for marker in hermes_brand_markers:
                if marker in soul_text:
                    return True
            return False

        def _maybe_seed_soul(soul_path: Path, label: str) -> None:
            try:
                existing = soul_path.read_text(encoding="utf-8") if soul_path.exists() else ""
            except Exception:
                existing = ""
            if not _is_unmodified_hermes_default(existing):
                # User-edited persona — don't reseed. But DO repair a stale media
                # path an EARLIER image baked in: `~/.agentbuff/cache|workspace`
                # never existed in the volume (HOME is .hermes), so the agent
                # followed it and wrote/returned dead-path media -> broken
                # resend. Surgical path swap only; persona text untouched.
                if ".agentbuff/cache" in existing or ".agentbuff/workspace" in existing:
                    repaired = existing.replace(
                        ".agentbuff/cache", ".hermes/cache"
                    ).replace(".agentbuff/workspace", ".hermes/workspace")
                    try:
                        soul_path.write_text(repaired, encoding="utf-8")
                        log.info(
                            "SOUL.md media-path repaired (.agentbuff -> .hermes) (%s)",
                            label,
                        )
                    except Exception:
                        log.exception("failed to repair SOUL.md at %s (non-fatal)", label)
                else:
                    log.debug("SOUL.md at %s is user-edited — leaving alone", label)
                return
            try:
                soul_path.parent.mkdir(parents=True, exist_ok=True)
                soul_path.write_text(agentbuff_soul, encoding="utf-8")
                log.info("SOUL.md re-seeded with AgentBuff persona (%s)", label)
            except Exception:
                log.exception("failed to write SOUL.md at %s (non-fatal)", label)

        # 1. Default profile root
        _maybe_seed_soul(HERMES_HOME / "SOUL.md", "default")

        # 2. Every named profile under profiles/<name>/SOUL.md
        # (REAL Hermes path, replaces the dead 2026-05-26 agents/ overlay
        # iteration that referenced a path that no longer exists.)
        profiles_root = HERMES_HOME / "profiles"
        if profiles_root.is_dir():
            for profile_dir in profiles_root.iterdir():
                if not profile_dir.is_dir():
                    continue
                _maybe_seed_soul(profile_dir / "SOUL.md", f"profile:{profile_dir.name}")

    async def _install_multimodal_plugin(self) -> None:
        """Install the AgentBuff multimodal plugin into the user's Hermes volume.

        The plugin (`docker/hermes-bridge/hermes_plugin_files/`) extends
        Hermes' `tools.transcription_tools.transcribe_audio` with a universal
        STT provider chain ported from OpenClaw — Gemini / Deepgram / Groq /
        Mistral / xAI + active-chat-model fallback. Effect: voice notes work
        across every channel (Telegram, WhatsApp, Discord, Slack) and the
        /app web UI with whatever provider key the user has, no
        faster-whisper install required.

        Why this lives in the volume (NOT baked into the pip wheel):
          - `hermes-agent` is installed via pip and overwritten on
            `pip install --upgrade hermes-agent`. A patch shipped inside the
            package would be wiped on every Hermes upgrade.
          - User plugins under `$HERMES_HOME/plugins/<name>/` are scanned by
            `hermes_cli/plugins.py::discover_plugins` (line 840) at every
            Hermes boot. They survive package upgrades because they live in
            the user's data directory, not the Python site-packages tree.

        Flow:
          1. Source files (`plugin.yaml`, `__init__.py`) are baked into the
             container image at `/app/bridge/hermes_plugin_files/` (via the
             Dockerfile's `COPY docker/hermes-bridge/ /app/bridge/` step).
          2. On every boot we copy them to
             `$HERMES_HOME/plugins/agentbuff-multimodal/` — overwriting any
             previous version so a bridge image rebuild propagates plugin
             updates to existing users (the source-of-truth is the image).
          3. We merge `"agentbuff-multimodal"` into
             `config.yaml::plugins.enabled` (preserving any other entries
             the user has explicitly enabled).

        Idempotent — safe to run on every boot. Defensive — any failure is
        logged but does not abort bridge startup (audio transcription
        falls back to Hermes' built-in chain, just without our extensions).
        """
        try:
            source_dir = Path(__file__).resolve().parent / "hermes_plugin_files"
            if not source_dir.is_dir():
                log.warning(
                    "multimodal plugin: source dir missing (%s) — "
                    "extended STT chain not installed",
                    source_dir,
                )
                return

            target_dir = HERMES_HOME / "plugins" / "agentbuff-multimodal"
            target_dir.mkdir(parents=True, exist_ok=True)

            # Copy every file from source_dir → target_dir. We do this every
            # boot so a fresh container image (rebuilt with a newer plugin
            # version) wins over whatever the volume has from a previous
            # image. Trade-off: chief cannot hand-edit the user-volume copy
            # and expect it to survive a restart — that's the price of
            # "image is source of truth". Acceptable for a SaaS deployment.
            import shutil as _shutil
            copied_files: list[str] = []
            for entry in source_dir.iterdir():
                if not entry.is_file():
                    continue
                dst = target_dir / entry.name
                _shutil.copy2(entry, dst)
                copied_files.append(entry.name)
            log.info(
                "multimodal plugin: copied %d file(s) to %s (%s)",
                len(copied_files),
                target_dir,
                ", ".join(sorted(copied_files)) if copied_files else "EMPTY",
            )

            # Merge plugin name into config.yaml::plugins.enabled. RFC 7396
            # treats lists as REPLACE (no element-merge), so a naïve
            # `patch({"plugins": {"enabled": ["agentbuff-multimodal"]}})`
            # would wipe out any other plugins the user enabled. Instead:
            # read current → append-if-missing → write merged list.
            assert self._config is not None
            current_plugins = await self._config.get("plugins")
            if isinstance(current_plugins, dict):
                current_enabled = current_plugins.get("enabled")
            else:
                current_enabled = None

            if isinstance(current_enabled, list):
                merged = list(current_enabled)
            else:
                merged = []
            if "agentbuff-multimodal" not in merged:
                merged.append("agentbuff-multimodal")
                await self._config.patch(
                    {"plugins": {"enabled": merged}},
                )
                log.info(
                    "multimodal plugin: enabled in config.yaml::plugins.enabled "
                    "(list now: %s)",
                    merged,
                )
            else:
                log.debug(
                    "multimodal plugin: already enabled in config.yaml::plugins.enabled"
                )

        except Exception:
            # Plugin install is best-effort. A failure here means audio
            # transcription falls back to Hermes' built-in chain (still
            # works for users with `stt.provider` configured or
            # faster-whisper installed). Don't let it abort bridge boot.
            log.exception(
                "multimodal plugin: install failed (non-fatal) — extended STT "
                "chain not active for this container"
            )

    async def _install_multichannel_plugin(self) -> None:
        """Install the AgentBuff multi-channel plugin into the user's Hermes volume.

        The plugin (`docker/hermes-bridge/hermes_multichannel_plugin/`) extends
        Hermes 0.14 channel adapter system to support N concurrent accounts
        per channel type (telegram_multi, discord_multi, slack_multi,
        whatsapp_multi, signal_multi, email_multi, matrix_multi, etc.) in a
        SINGLE Python process. Mirror pattern dari SpeadAI/OpenClaw's
        1-process-N-accounts architecture, proven via agentbuff-multimodal
        v3.0.0 production.

        Why this lives in the volume (NOT baked into the pip wheel):
          - `hermes-agent` is installed via pip and overwritten on
            `pip install --upgrade hermes-agent`. A patch shipped inside the
            package would be wiped on every Hermes upgrade.
          - User plugins under `$HERMES_HOME/plugins/<name>/` are scanned by
            `hermes_cli/plugins.py::discover_plugins` (line 840) at every
            Hermes boot. They survive package upgrades because they live in
            the user's data directory, not the Python site-packages tree.

        Flow:
          1. Source tree (`docker/hermes-bridge/hermes_multichannel_plugin/`)
             is baked into the container image at
             `/app/bridge/hermes_multichannel_plugin/` (via the Dockerfile's
             `COPY docker/hermes-bridge/ /app/bridge/` step which already
             recursively copies subdirectories).
          2. On every boot we copy the tree to
             `$HERMES_HOME/plugins/agentbuff-multichannel/` — overwriting any
             previous version so a bridge image rebuild propagates plugin
             updates to existing users (image = source of truth).
          3. We merge `"agentbuff-multichannel"` into
             `config.yaml::plugins.enabled` (preserving any other entries
             the user has explicitly enabled).

        Idempotent — safe to run on every boot. Defensive — any failure is
        logged but does not abort bridge startup. Per-channel adapters land
        in Fase 2-7; this method just gets the skeleton installed so the
        plugin loads cleanly + the foundation is reachable for future fases.
        """
        try:
            source_dir = Path(__file__).resolve().parent / "hermes_multichannel_plugin"
            if not source_dir.is_dir():
                log.warning(
                    "multichannel plugin: source dir missing (%s) — "
                    "per-agen multi-channel routing not active",
                    source_dir,
                )
                return

            target_dir = HERMES_HOME / "plugins" / "agentbuff-multichannel"
            target_dir.mkdir(parents=True, exist_ok=True)

            # Recursive copy — plugin has subpackages (routing/, platforms/).
            # We do this every boot so a fresh image (rebuilt with newer
            # plugin code) wins over whatever the volume has from a previous
            # image. Trade-off: chief cannot hand-edit the user-volume copy
            # and expect it to survive a restart — image = source of truth.
            import shutil as _shutil
            import filecmp as _filecmp
            copied_files: list[str] = []
            skipped_perm: list[str] = []
            for src_entry in source_dir.rglob("*"):
                if not src_entry.is_file():
                    continue
                # Skip __pycache__ + .pyc files that may have crept in
                if "__pycache__" in src_entry.parts:
                    continue
                if src_entry.suffix == ".pyc":
                    continue
                rel = src_entry.relative_to(source_dir)
                dst = target_dir / rel
                dst.parent.mkdir(parents=True, exist_ok=True)
                # Content-aware copy (perm-safe). The volume's existing copy is
                # often a read-only, root-owned file from a previous image bake
                # (-r--r--r-- root). When the image content is UNCHANGED (the
                # common boot) we skip entirely → no write → no PermissionError
                # traceback (the old code blindly copy2'd → open(dst,'wb') →
                # Errno 13). When content DID change (newer image) we try to
                # make the dst + its dir writable, unlink, then copy; if the
                # filesystem still refuses (dir not writable by the non-root
                # runtime user), we log once at debug and keep the existing
                # file rather than aborting the whole plugin install.
                try:
                    if dst.is_file() and _filecmp.cmp(
                        str(src_entry), str(dst), shallow=False
                    ):
                        continue  # already up to date
                    if dst.exists():
                        try:
                            os.chmod(dst.parent, 0o755)
                        except OSError:
                            pass
                        try:
                            os.chmod(dst, 0o644)
                        except OSError:
                            pass
                        try:
                            dst.unlink()
                        except OSError:
                            pass
                    _shutil.copy2(src_entry, dst)
                    try:
                        os.chmod(dst, 0o644)
                    except OSError:
                        pass
                    copied_files.append(str(rel))
                except PermissionError:
                    skipped_perm.append(str(rel))
                except OSError as _e:
                    skipped_perm.append(f"{rel} ({_e.__class__.__name__})")
            if skipped_perm:
                log.info(
                    "multichannel plugin: %d file(s) copied, %d kept "
                    "(existing read-only volume copy, content unchanged or "
                    "dir not writable): %s",
                    len(copied_files), len(skipped_perm),
                    ", ".join(skipped_perm[:5]),
                )
            else:
                log.info(
                    "multichannel plugin: copied %d file(s) to %s",
                    len(copied_files), target_dir,
                )

            # Merge plugin name into config.yaml::plugins.enabled. Same
            # list-replace concern as multimodal: read current → append-if-
            # missing → write merged list to preserve other enabled plugins.
            assert self._config is not None
            current_plugins = await self._config.get("plugins")
            if isinstance(current_plugins, dict):
                current_enabled = current_plugins.get("enabled")
            else:
                current_enabled = None
            if isinstance(current_enabled, list):
                merged = list(current_enabled)
            else:
                merged = []
            if "agentbuff-multichannel" not in merged:
                merged.append("agentbuff-multichannel")
                await self._config.patch({"plugins": {"enabled": merged}})
                log.info(
                    "multichannel plugin: enabled in config.yaml::plugins.enabled "
                    "(list now: %s)", merged,
                )
            else:
                log.debug(
                    "multichannel plugin: already enabled in config.yaml::plugins.enabled"
                )

        except Exception:
            # Best-effort install. Per-channel multi-account fallback: native
            # Hermes single-account paths still work for the default profile.
            # Don't let plugin install failure abort bridge boot.
            log.exception(
                "multichannel plugin: install failed (non-fatal) — per-agen "
                "multi-channel routing not active for this container"
            )

    async def _seed_initial_config(self) -> None:
        """Seed `~/.hermes/config.yaml` + `~/.hermes/.env` with defaults.

        Hermes splits configuration across two files:
          - config.yaml: behavior knobs (model selection, agent limits)
          - .env:        secrets (API keys, channel tokens)

        Provider detection (`_has_any_provider_configured` in
        hermes_cli/main.py:285) ONLY reads env vars. Even if
        config.yaml.model.api_key is set, the dashboard refuses to
        bootstrap an agent without GEMINI_API_KEY (or OPENAI_API_KEY,
        OPENROUTER_API_KEY, ANTHROPIC_API_KEY, ...) in .env.

        Similarly, model selection uses `model.default` — the
        `model.primary` field is a portal-side convention from the
        OpenClaw era and not what Hermes reads.

        This function is idempotent: we always write both files but
        only the .env write through Hermes' atomic save mechanism
        (preserving existing channel tokens). config.yaml gets the
        full seed only when missing; existing files stay untouched.
        """
        # 1) Read env-injected defaults from the bridge's own env
        # Strip OpenClaw-style "<provider>/<model>" prefix if present.
        # Hermes' provider system routes by provider name (gemini, anthropic,
        # openai, ...) and passes the bare model name to the API endpoint.
        # `google/gemini-3-flash-preview` → Gemini API returns HTTP 404
        # because there's no model called `google/...`. Bare names work.
        raw_model = env_str("HERMES_DEFAULT_MODEL", "gemini-2.5-flash")
        default_model = raw_model.split("/", 1)[-1] if "/" in raw_model else raw_model
        api_key = env_str("HERMES_DEFAULT_API_KEY", "")
        gemini_key = env_str("HERMES_DEFAULT_GEMINI_KEY", "")
        if not api_key and gemini_key:
            api_key = gemini_key

        # BYOK gate (Chief 2026-06-16: "jangan apa apa semua gemini, ikutin
        # provider yang dipake masing masing user auto sesuaikan"). Only pin a
        # model/provider when an operator key is ACTUALLY seeded (dev path with
        # HERMES_SEED_DEFAULT_KEY=true). A pure-BYOK container (empty .env) must
        # NOT be born pinned to gemini-with-no-key — leave the model blank so the
        # provider the user actually connects becomes the model+provider, set by
        # applyOnboardingToContainer's config.patch after onboarding. Without this
        # gate every fresh container is born `model.provider=gemini` even for a
        # codex/deepseek/anthropic user.
        if not api_key:
            default_model = ""

        # 2) Seed .env with GEMINI_API_KEY so Hermes' provider-check
        #    function recognises us as configured. `_write_env_values`
        #    from channels_handler preserves any pre-existing keys
        #    (channel tokens, fallback provider keys).
        if api_key:
            try:
                from channels_handler import _write_env_values
                _write_env_values({"GEMINI_API_KEY": api_key})
                log.info(".env seeded with GEMINI_API_KEY")
            except Exception:
                log.exception(".env seed failed (non-fatal)")

        # 3) Seed config.yaml only when missing — otherwise leave it
        config_path = HERMES_HOME / "config.yaml"
        if config_path.exists():
            log.info("config.yaml exists; not seeding (env file refreshed only)")
            # 3a) One-shot migration of the TTS provider for existing users.
            # Older containers were seeded with `tts.provider: gtts` which
            # now returns HTTP 403 because Google rate-limits the unofficial
            # gTTS endpoint from server IPs. Switch them to Gemini TTS
            # (re-uses the GEMINI_API_KEY already seeded) — same provider
            # the new seed in step 4 uses. Idempotent: only patches when
            # the current provider is explicitly "gtts" (or empty, which
            # means Edge TTS — also broken since Microsoft auth change
            # 2026-04). Anything else (user-chosen openai, elevenlabs,
            # piper, ...) is preserved.
            try:
                current = await self._config.get("tts") or {}
                if not isinstance(current, dict):
                    current = {}
                cur_provider = (current.get("provider") or "").strip().lower()
                # Only migrate to gemini TTS when a gemini key is actually seeded —
                # never force a non-gemini BYOK user onto gemini (Chief 2026-06-16).
                if api_key and cur_provider in ("gtts", "", "edge"):
                    await self._config.patch({
                        "tts": {
                            "provider": "gemini",
                            "gemini": {
                                "voice": (current.get("gemini") or {}).get("voice") or "Kore",
                            },
                        },
                    })
                    log.info(
                        "tts provider migrated from %r to 'gemini'",
                        cur_provider or "(unset)",
                    )
            except Exception:
                log.exception("tts migration patch failed (non-fatal)")
            return

        # Derive provider from the model name's first dash-segment when
        # the OpenClaw-style "<provider>/<model>" prefix was stripped above.
        # E.g. "gemini-3-flash-preview" → provider "gemini". For models that
        # don't match the convention (e.g. "claude-3-5-sonnet") we still
        # want a sensible default — fall back to the prefix the model
        # starts with. The dashboard's /api/model/info reads model.provider
        # to display "Provider: Google" in the picker without a manual
        # set; without it, the field renders as "(UNKNOWN)".
        provider_id = ""
        first_seg = (default_model or "").split("-", 1)[0].lower()
        if first_seg in ("gemini", "google"):
            provider_id = "gemini"
        elif first_seg == "claude":
            provider_id = "anthropic"
        elif first_seg in ("gpt", "o1", "o3"):
            provider_id = "openai"
        elif first_seg == "deepseek":
            provider_id = "deepseek"
        elif first_seg == "kimi":
            provider_id = "kimi"
        elif first_seg == "qwen":
            provider_id = "qwen"
        elif first_seg == "grok":
            provider_id = "xai"
        # If still unknown, leave empty — Hermes will infer at runtime.

        seed = {
            # Model seeded ONLY when an operator key is present (dev path). A
            # pure-BYOK container starts with NO pinned model/provider so it's
            # never born forced to gemini-with-no-key; applyOnboardingToContainer
            # sets the user's real model+provider post-onboarding. (Chief 2026-06-16
            # "jangan apa apa semua gemini".)
            "model": {
                # `default` is the field Hermes reads. `primary` kept for
                # back-compat with portal-side callers (e.g. /app engine cards).
                **(
                    {"default": default_model, "primary": default_model}
                    if default_model
                    else {}
                ),
                # `provider` populates the dashboard Models tab picker label.
                **({"provider": provider_id} if provider_id else {}),
            },
            # NOTE (2026-06-03, Chief: "samakan PERSIS vanilla"): vanilla's
            # first-run config.yaml has NO `agent` block and NO `memory` block —
            # the engine uses its built-in defaults (max_iterations default +
            # built-in memory always-on). We previously seeded both, which made
            # our config diverge from vanilla. Removed to match exactly. Built-in
            # memory stays active regardless (engine default). `channels`/
            # `bindings` are kept (empty) because the multichannel plugin scans
            # them; `tts` is kept because the multimodal plugin needs it — those
            # two are the ONLY sanctioned deviations (our 2 plugins).
            "channels": {},
            "bindings": [],
            # TTS — use Hermes' built-in Gemini TTS (re-uses the same
            # GEMINI_API_KEY already seeded into .env above). Gemini's
            # official generateContent endpoint with responseModalities=
            # ["AUDIO"] returns 24kHz mono PCM which Hermes wraps as WAV.
            # We pick this over edge-tts (Microsoft auth broke 2026-04) and
            # gtts (Google rate-limits server IPs with 403). The
            # `agentbuff-multimodal` plugin's `tts_gtts` patch stays
            # installed but only triggers when provider == "gtts"; with
            # provider == "gemini" the original Hermes dispatch runs
            # unchanged via _generate_gemini_tts(). Voice "Kore" is the
            # documented default; output format is .wav by default which
            # all modern browsers play natively (no ffmpeg required).
            # TTS provider follows key availability — NOT a hard gemini default
            # (Chief 2026-06-16). With a gemini key seeded (dev) → gemini TTS. For
            # a pure-BYOK container (no key) leave it unpinned; applyOnboardingTo-
            # Container sets TTS to the user's connected provider (gemini/openai)
            # post-onboarding, and chat-only providers (codex/deepseek) simply have
            # no TTS rather than a broken gemini-no-key pin.
            "tts": (
                {"provider": "gemini", "gemini": {"voice": "Kore"}}
                if api_key
                else {}
            ),
            # Display defaults aligned with stock Hermes' first-run values so
            # every new container's effective config matches the vanilla
            # baseline (Chief 2026-06-03: every new account must start identical).
            "display": {
                "show_cost": True,
                "show_reasoning": "all",
                "tool_progress": True,
            },
        }

        await self._config.replace(seed)
        log.info("config.yaml seeded with defaults (model=%s)", default_model)

        # NOTE: the default agent's display name ("Buff") is seeded by
        # _seed_default_agent_name(), called UNCONDITIONALLY from init — NOT
        # here, because this function early-returns when config.yaml already
        # exists, which would skip the rename for every pre-existing container.

    # -----------------------------------------------------------------
    # Hermes event handler → broadcast to all connected clients
    # -----------------------------------------------------------------

    async def _on_hermes_event(self, hermes_msg: dict) -> None:
        """Translate Hermes notification and broadcast to all WS clients."""
        # Opt-in raw-event trace — useful for diagnosing translator gaps.
        # Set `BRIDGE_TRACE_EVENTS=1` in the container env (via portal env
        # propagation in src/lib/hermes/docker.ts) to enable.
        if os.environ.get("BRIDGE_TRACE_EVENTS") == "1":
            log.info("[trace] raw hermes_msg=%s", json.dumps(hermes_msg)[:600])
        try:
            portal_event = translate(hermes_msg, self._accumulator)
        except Exception:
            log.exception("event_translator crashed (msg=%r)", hermes_msg)
            return

        if portal_event is None:
            return

        # Broadcast
        async with self._clients_lock:
            client_queues = list(self._clients.items())

        for client_id, queue in client_queues:
            try:
                # Use put_nowait so a slow client can't block other clients
                queue.put_nowait(portal_event)
            except asyncio.QueueFull:
                # Client too slow — drop the event for this client
                log.warning(
                    "event_broadcast: queue full for client=%s, dropping event",
                    client_id,
                )

    async def _broadcast_event(self, portal_event: dict) -> None:
        """Public broadcast hook used by RPC handlers (messages.edit/delete,
        reactions.set) to push live update events to all connected WS
        clients. Same mechanism as Hermes-relayed translation broadcast
        but invoked directly from a handler instead of via translator."""
        async with self._clients_lock:
            client_queues = list(self._clients.items())
        for client_id, queue in client_queues:
            try:
                queue.put_nowait(portal_event)
            except asyncio.QueueFull:
                log.warning(
                    "_broadcast_event: queue full for client=%s, dropping event",
                    client_id,
                )

    # -----------------------------------------------------------------
    # Cross-session activity watcher (realtime channel monitoring)
    # -----------------------------------------------------------------

    @staticmethod
    def _scan_sessions_activity(db_path: str) -> dict:
        """Return {session_id: (max_ts, last_role, msg_count)} for every
        session in the shared state.db. Read-only; defensive (returns {} on
        any error). session_id here is the raw db id — matches the
        `sessionId` field sessions.list emits, so /app can map it to a row."""
        import sqlite3

        out: dict = {}
        try:
            conn = sqlite3.connect(db_path, timeout=5.0)
            try:
                cur = conn.cursor()
                cur.execute(
                    """
                    SELECT session_id, MAX(timestamp) AS mts, COUNT(*) AS cnt
                    FROM messages
                    WHERE role != 'session_meta'
                    GROUP BY session_id
                    """
                )
                agg = {r[0]: (r[1], r[2]) for r in cur.fetchall()}
                cur.execute(
                    """
                    SELECT m.session_id, m.role
                    FROM messages m
                    JOIN (
                        SELECT session_id, MAX(timestamp) AS mx
                        FROM messages WHERE role != 'session_meta'
                        GROUP BY session_id
                    ) t ON m.session_id = t.session_id AND m.timestamp = t.mx
                    """
                )
                roles: dict = {}
                for sid, role in cur.fetchall():
                    roles.setdefault(sid, role)  # first (any) role at max ts
                for sid, (mts, cnt) in agg.items():
                    out[sid] = (float(mts or 0), roles.get(sid, ""), int(cnt or 0))
            finally:
                conn.close()
        except Exception:
            log.debug("sessions watcher: db scan failed", exc_info=True)
        return out

    @staticmethod
    def _read_working_agents(now: float) -> list:
        """Agents currently mid-turn on a CHANNEL, from the plugin's active-turn
        marker (.agentbuff_active_turns.json). The engine persists a turn's
        user+assistant messages atomically at turn END, so the DB can never show
        an in-flight channel turn — this marker is the only signal. An agent
        counts as working if its last turn-start is newer than the last
        reply-sent AND within the safety TTL. Read-only; [] on any error."""
        import json as _json

        try:
            path = HERMES_HOME / ".agentbuff_active_turns.json"
            data = _json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                return []
            agents = data.get("agents") or {}
            try:
                last_reply = float(data.get("last_reply_ts") or 0.0)
            except (TypeError, ValueError):
                last_reply = 0.0
            out: set = set()
            for aid, ts in (agents.items() if isinstance(agents, dict) else []):
                try:
                    started = float(ts)
                except (TypeError, ValueError):
                    continue
                if started > last_reply and (now - started) < 180.0:
                    out.add(str(aid))
            return sorted(out)
        except Exception:
            return []

    async def _run_sessions_watcher(self) -> None:
        """Poll the shared state.db and push realtime activity to /app clients.

        Two signals:
          - `sessions.changed` → /app calls refreshSessions() so the sidebar
            reflects new channel messages (preview / time / reorder) live.
          - `sessions.activity` → carries `workingSids` (sessions whose latest
            message is a pending user/tool turn within the working window, i.e.
            the agent is mid-reply) + `changedSids` so /app can show a per-row
            "working" indicator and live-refresh an open channel thread.

        Defensive: never raises out of the loop; skips work when no clients are
        connected. Channel runs live in a separate process, so this db tail is
        the only way /app sees them without a manual refresh."""
        import time as _time

        db_path = str(HERMES_HOME / "state.db")
        poke_path = str(HERMES_HOME / ".agentbuff_activity_poke")
        STEP = 0.2          # heartbeat — how often we check the poke file
        ACTIVE_INTERVAL = 0.6  # scan cadence while a turn is in flight
        IDLE_INTERVAL = 2.0    # scan cadence when nothing is happening
        WORKING_WINDOW = 180.0  # bounds "working" so it can't stick forever
        prev: dict = {}
        prev_working: set = set()
        prev_working_agents: set = set()
        primed = False
        last_poke = -1.0
        last_change_ts = 0.0
        waited = 0.0

        while not self._stopping:
            try:
                await asyncio.sleep(STEP)
                waited += STEP

                # Poke detection — the channel plugin (separate process) touches
                # this file the instant a message arrives / a reply goes out, so
                # we scan immediately instead of waiting for the poll interval.
                poked = False
                try:
                    m = os.path.getmtime(poke_path)
                    if m != last_poke:
                        if last_poke >= 0:
                            poked = True
                        last_poke = m
                except OSError:
                    pass

                now = _time.time()
                active = (
                    bool(prev_working)
                    or bool(prev_working_agents)
                    or (now - last_change_ts) < 5.0
                )
                interval = ACTIVE_INTERVAL if active else IDLE_INTERVAL
                if not poked and waited < interval:
                    continue
                waited = 0.0

                async with self._clients_lock:
                    has_clients = bool(self._clients)
                if not has_clients:
                    # Reset baseline so the first tick after a client connects
                    # doesn't replay the whole history as "changed".
                    prev = {}
                    prev_working = set()
                    primed = False
                    continue

                rows = await asyncio.to_thread(self._scan_sessions_activity, db_path)
                if not rows:
                    continue

                working = {
                    sid
                    for sid, (mts, role, _cnt) in rows.items()
                    if role in ("user", "tool") and (now - mts) < WORKING_WINDOW
                }
                changed_sids = [sid for sid, cur in rows.items() if prev.get(sid) != cur]
                # Channel turns never look "in progress" in the DB (engine
                # persists user+assistant atomically at turn end), so the plugin
                # writes an active-turn marker the instant a channel message
                # arrives. Read it for the agents currently mid-turn off-web.
                working_agents = set(self._read_working_agents(now))

                if not primed:
                    # First populated tick: establish baseline silently (don't
                    # treat the entire existing history as fresh activity), but
                    # do surface any in-flight working sessions immediately.
                    prev = rows
                    prev_working = working
                    prev_working_agents = working_agents
                    primed = True
                    if working or working_agents:
                        last_change_ts = now
                        await self._broadcast_event({
                            "type": "event",
                            "event": "sessions.activity",
                            "payload": {
                                "workingSids": sorted(working),
                                "workingAgentIds": sorted(working_agents),
                                "changedSids": [],
                            },
                        })
                    continue

                msgs_changed = bool(changed_sids)
                working_changed = working != prev_working
                agents_changed = working_agents != prev_working_agents
                if msgs_changed or working_changed or agents_changed:
                    last_change_ts = now
                prev = rows
                prev_working = working
                prev_working_agents = working_agents

                if msgs_changed:
                    # Sidebar refresh (previews / time / order). Existing handler.
                    await self._broadcast_event({
                        "type": "event", "event": "sessions.changed", "payload": {},
                    })
                if msgs_changed or working_changed or agents_changed:
                    await self._broadcast_event({
                        "type": "event",
                        "event": "sessions.activity",
                        "payload": {
                            "workingSids": sorted(working),
                            "workingAgentIds": sorted(working_agents),
                            "changedSids": changed_sids,
                        },
                    })
            except asyncio.CancelledError:
                break
            except Exception:
                log.debug("sessions watcher: tick failed", exc_info=True)

    async def _warm_engine(self) -> None:
        """Pre-load engine registries + provider pool at boot so the FIRST open
        of the capability-heavy tabs (Kemampuan/Providers) is fast.

        The engine lazy-loads plugins/tools/mcp/skills registries on first
        access; the first parallel burst those tabs fire costs ~2s. We fire the
        same set once here (after giving the upstream engine connection a moment
        to come up) so that cost is paid before any user click. Best-effort:
        every call is swallowed; warm-up never affects boot or serving."""
        try:
            from rpc_router import DispatchContext, METHOD_HANDLERS
            from auth import AuthContext

            warm_auth = AuthContext(
                client_id="agentbuff-warmup",
                role="operator",
                scopes=frozenset({
                    "operator.admin", "operator.read", "operator.write",
                    "operator.approvals", "operator.pairing",
                }),
                instance_id="warmup",
                user_id=None,
            )
            ctx = DispatchContext(
                hermes=self._hermes,
                config=self._config,
                agents=self._agents,
                channels=self._channels,
                energy=self._energy,
                tier_limits=self._tier_limits,
                auth=warm_auth,
                bridge_app=self,
            )

            # The tui_gateway (engine) boot scans the skill set and isn't ready
            # to serve RPCs for ~10-40s after the bridge health goes green —
            # warming too early just errors out without priming anything. Poll a
            # cheap RPC until it answers, THEN fire the full warm burst.
            probe = METHOD_HANDLERS.get("agents.list")
            ready = False
            for _ in range(60):  # up to ~90s
                if self._stopping:
                    return
                await asyncio.sleep(1.5)
                if probe is None:
                    break
                try:
                    await asyncio.wait_for(probe({}, ctx), timeout=10.0)
                    ready = True
                    break
                except Exception:
                    continue
            if not ready:
                log.info("engine warm-up: engine not ready in time — skipped")
                return

            methods = [
                "skills.status", "tools.catalog", "plugins.list", "mcp.list",
                "mcp.presets", "env.list", "models.authStatus", "channels.status",
                "agents.list", "sessions.list", "providers.pool.list",
                "providers.catalog", "config.get",
            ]

            async def _warm_one(method: str) -> None:
                handler = METHOD_HANDLERS.get(method)
                if handler is None:
                    return
                try:
                    await asyncio.wait_for(handler({}, ctx), timeout=15.0)
                except Exception:
                    pass  # missing params / not-supported — engine still warmed

            await asyncio.gather(*[_warm_one(m) for m in methods])
            log.info("engine warm-up complete (%d methods primed)", len(methods))
        except asyncio.CancelledError:
            pass
        except Exception:
            log.debug("engine warm-up failed (non-fatal)", exc_info=True)

    # -----------------------------------------------------------------
    # WebSocket server
    # -----------------------------------------------------------------

    async def _run_ws_server(self) -> None:
        """Bind WS server and accept connections until shutdown."""
        log.info("WS server starting on %s:%d", BRIDGE_HOST, BRIDGE_PORT)

        async with websockets.serve(
            self._handle_connection,
            BRIDGE_HOST,
            BRIDGE_PORT,
            max_size=MAX_WS_MESSAGE_SIZE,
            ping_interval=WS_PING_INTERVAL,
            ping_timeout=WS_PING_TIMEOUT,
            compression=None,  # avoid permessage-deflate per OpenClaw practice
        ):
            log.info("WS server accepting connections")
            # Block forever — until cancelled
            try:
                await asyncio.Future()
            except asyncio.CancelledError:
                log.info("WS server cancelled")

    async def _handle_connection(self, ws: WebSocketServerProtocol) -> None:
        """Per-connection handler. Auth → register → dispatch loop."""
        client_id = await self._allocate_client_id()
        log.info("client %s connected from %s", client_id, ws.remote_address)

        auth_ctx = None
        outbound_queue: asyncio.Queue = asyncio.Queue(maxsize=512)

        try:
            # Wait for the first frame (auth)
            try:
                first_frame_raw = await asyncio.wait_for(ws.recv(), timeout=10.0)
            except asyncio.TimeoutError:
                await _close_safely(ws, 4002, "auth timeout")
                return
            except ConnectionClosed:
                return

            try:
                first_frame = json.loads(first_frame_raw)
            except (json.JSONDecodeError, TypeError):
                await _send_error_response(ws, "unknown", "INVALID_REQUEST", "first frame must be valid JSON")
                await _close_safely(ws, 4002, "invalid JSON")
                return

            try:
                auth_ctx = validate_connect_frame(first_frame, self._bridge_token)
            except AuthError as e:
                # Send error response then close
                await _send_error_response(
                    ws,
                    first_frame.get("id") if isinstance(first_frame, dict) else "unknown",
                    e.code,
                    e.message,
                )
                await _close_safely(ws, 4001, e.code)
                return

            # Register client for event broadcast
            async with self._clients_lock:
                self._clients[client_id] = outbound_queue

            # Reply to connect frame with synthetic snapshot
            connect_id = first_frame["id"]
            await _send_response(ws, connect_id, ok=True, payload={
                "snapshot": {
                    "uptimeMs": int(time.monotonic() * 1000),
                    "authMode": "bridge-token",
                    "runtimeVersion": "agentbuff-bridge/1.0",
                },
                "policy": {"tickIntervalMs": 5000},
            })

            # Emit proxy.ready event so portal's GatewayProvider can bootstrap
            await _send_event(ws, "proxy.ready", {
                "user": auth_ctx.user_id,
                "instance": auth_ctx.instance_id,
                "snapshot": {
                    "uptimeMs": int(time.monotonic() * 1000),
                    "authMode": "bridge-token",
                    "runtimeVersion": "agentbuff-bridge/1.0",
                },
                "policy": {"tickIntervalMs": 5000},
            })

            # Spawn outbound writer (broadcasts events from queue)
            writer_task = asyncio.create_task(
                self._outbound_writer(ws, outbound_queue),
                name=f"client-writer-{client_id}",
            )

            # Inbound dispatch loop
            try:
                await self._dispatch_loop(ws, auth_ctx)
            finally:
                writer_task.cancel()
                with suppress(asyncio.CancelledError, Exception):
                    await writer_task

        except ConnectionClosed:
            pass
        except Exception:
            log.exception("client %s: handler crashed", client_id)
        finally:
            # Cleanup
            async with self._clients_lock:
                self._clients.pop(client_id, None)
            log.info("client %s disconnected", client_id)

    async def _dispatch_loop(
        self,
        ws: WebSocketServerProtocol,
        auth_ctx,
    ) -> None:
        """Read frames from client, dispatch RPC, send responses."""
        ctx = DispatchContext(
            hermes=self._hermes,
            config=self._config,
            agents=self._agents,
            channels=self._channels,
            energy=self._energy,
            tier_limits=self._tier_limits,
            auth=auth_ctx,
            bridge_app=self,
        )

        async for raw in ws:
            if self._stopping:
                break

            try:
                frame = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                # We can't reply because we don't know the frame id
                log.warning("dispatch: discarding non-JSON frame")
                continue

            if not isinstance(frame, dict):
                continue
            ftype = frame.get("type")
            if ftype != "req":
                # Portal sends only "req" frames; events/responses
                # are bridge-originated, not client-originated. Ignore.
                continue

            frame_id = frame.get("id") or "unknown"
            method = frame.get("method") or ""
            params = frame.get("params") or {}
            if not isinstance(params, dict):
                params = {}

            # Reject re-connect attempts (client should reconnect WS instead)
            if method == "connect":
                await _send_response(ws, frame_id, ok=False, error={
                    "code": "FORBIDDEN",
                    "message": "connect can only be sent as the first frame",
                })
                continue

            # Dispatch — run handler concurrently so slow methods don't block
            # other requests from same client
            asyncio.create_task(
                self._dispatch_one(ws, frame_id, method, params, ctx),
                name=f"rpc:{method}",
            )

    async def _dispatch_one(
        self,
        ws: WebSocketServerProtocol,
        frame_id: str,
        method: str,
        params: dict,
        ctx: DispatchContext,
    ) -> None:
        """Run a single RPC handler and reply with result/error."""
        try:
            result = await dispatch(method, params, ctx)
            await _send_response(ws, frame_id, ok=True, payload=result)
        except RpcError as e:
            await _send_response(ws, frame_id, ok=False, error={
                "code": e.code,
                "message": e.message,
            })
        except Exception as e:
            log.exception("dispatch_one: unhandled exception for method=%s", method)
            await _send_response(ws, frame_id, ok=False, error={
                "code": "INTERNAL_ERROR",
                "message": f"{type(e).__name__}: {e}",
            })

    async def _outbound_writer(
        self,
        ws: WebSocketServerProtocol,
        queue: asyncio.Queue,
    ) -> None:
        """Drain outbound queue and send events to client."""
        try:
            while True:
                event = await queue.get()
                if event is None:  # shutdown signal
                    return
                try:
                    await ws.send(json.dumps(event, separators=(",", ":")))
                except ConnectionClosed:
                    return
        except asyncio.CancelledError:
            return
        except Exception:
            log.exception("outbound_writer crashed")

    async def _allocate_client_id(self) -> str:
        async with self._clients_lock:
            cid = f"c{self._next_client_id:05d}"
            self._next_client_id += 1
        return cid

    # -----------------------------------------------------------------
    # Hermes messaging gateway management
    # -----------------------------------------------------------------

    async def _restart_hermes_subprocess(self) -> None:
        """Restart the Hermes TUI Gateway subprocess (used by updater).

        Bridge stays alive throughout. All in-flight RPCs get failed
        cleanly because hermes_client clears pending Futures when the
        subprocess exits, then the supervisor respawns it automatically.
        """
        if not self._hermes:
            log.warning("_restart_hermes_subprocess: no Hermes client yet")
            return

        log.info("Restarting Hermes subprocess (updater triggered)")

        # Trigger a clean stop + the supervisor in hermes_client will respawn
        # automatically because we don't set _stopping on the client.
        if self._hermes._proc and self._hermes._proc.returncode is None:
            try:
                self._hermes._proc.terminate()
                # Wait briefly; the supervisor task will respawn it
                await asyncio.wait_for(
                    self._hermes._proc.wait(), timeout=10.0,
                )
            except (asyncio.TimeoutError, ProcessLookupError):
                pass

        # Give supervisor a moment to respawn
        for _ in range(10):
            await asyncio.sleep(1.0)
            if self._hermes.is_alive:
                log.info("Hermes subprocess respawned successfully")
                return

        log.warning("Hermes subprocess did not respawn within 10s")

    async def _restart_hermes_gateway(self) -> None:
        """Restart the channel runtime so it picks up config.yaml changes.

        Called by channels_handler after config mutations (pair/logout/
        upsertBinding/deleteBinding). The supervised `hermes gateway run`
        subprocess reads config.yaml at boot — it doesn't watch for live
        changes — so we have to kill + respawn it to apply new tokens.

        The supervisor in GatewayRuntime catches the exit and respawns
        with exponential backoff (~2s initial). Net effect: ~2-3s of
        downtime on existing channels, but all newly-paired channels
        come up immediately after.

        If the gateway runtime isn't running (HERMES_GATEWAY_RUNTIME_DISABLED
        in dev), this is a no-op + we log a warning so it's obvious why
        pairing doesn't activate.
        """
        if self._gateway_runtime is None or not self._gateway_runtime.is_alive:
            log.warning(
                "channels mutation requested gateway restart, but gateway "
                "runtime is not running. New tokens won't be picked up until "
                "the gateway runtime starts.",
            )
            return

        log.info("restarting channel runtime to pick up config.yaml changes")
        try:
            await self._gateway_runtime.restart()
        except Exception:
            log.exception("gateway_runtime restart failed")

    # -----------------------------------------------------------------
    # Periodic maintenance
    # -----------------------------------------------------------------

    async def _run_accumulator_pruner(self) -> None:
        """Drop stale per-session text accumulators every 5 minutes."""
        try:
            while True:
                await asyncio.sleep(300.0)
                pruned = self._accumulator.prune_stale()
                if pruned:
                    log.info("accumulator_pruner: dropped %d stale sessions", pruned)
        except asyncio.CancelledError:
            return

    # -----------------------------------------------------------------
    # Health HTTP endpoint
    # -----------------------------------------------------------------

    async def _run_health_server(self) -> None:
        """HTTP server on BRIDGE_HEALTH_PORT. Two routes:
          - `GET /` or `/health` → JSON health envelope (Docker healthcheck).
          - `GET /media/<token>/<filename>[?download=1]` → serve a
            registered media file (bot-generated image/audio/video/doc).
            Token is a one-time opaque capability registered via
            `media_serve.register_media(path)` by the event translator
            when extracting MEDIA: tags from agent responses.
        """
        from urllib.parse import urlparse, parse_qs
        from media_serve import (
            resolve_token,
            resolve_durable,
            stats as media_stats,
        )

        async def _media_404(writer, msg: bytes):
            writer.write(
                b"HTTP/1.1 404 Not Found\r\n"
                b"Content-Type: text/plain\r\n"
                + f"Content-Length: {len(msg)}\r\n".encode()
                + b"Access-Control-Allow-Origin: *\r\n"
                b"Connection: close\r\n\r\n"
                + msg
            )
            await writer.drain()

        async def _stream_entry(entry: dict, filename: str, download: bool, writer):
            """Stream a resolved media entry (token OR durable) to the client."""
            # Filename in URL is decorative — re-derive from entry for safety.
            real_path = entry["path"]
            real_name = entry["filename"]
            mime = entry["mime"]
            size = entry["size"]
            # Use the URL-supplied filename only for the Content-Disposition
            # suggestion (lets bridge clients override download name) —
            # falls back to real_name. Sanitize: ASCII only, strip path
            # separators, cap length.
            safe_dl_name = "".join(
                c for c in (filename or real_name)
                if c.isalnum() or c in "._- "
            )[:120] or real_name
            disposition = (
                f'attachment; filename="{safe_dl_name}"'
                if download
                else f'inline; filename="{safe_dl_name}"'
            )
            try:
                with open(real_path, "rb") as f:
                    headers = (
                        b"HTTP/1.1 200 OK\r\n"
                        + f"Content-Type: {mime}\r\n".encode()
                        + f"Content-Length: {size}\r\n".encode()
                        + f"Content-Disposition: {disposition}\r\n".encode()
                        + b"Access-Control-Allow-Origin: *\r\n"
                        + b"Cache-Control: private, max-age=3600\r\n"
                        + b"Connection: close\r\n\r\n"
                    )
                    writer.write(headers)
                    # Stream in chunks so large files don't blow memory.
                    while True:
                        chunk = f.read(64 * 1024)
                        if not chunk:
                            break
                        writer.write(chunk)
                        await writer.drain()
            except FileNotFoundError:
                body = b"file not found on disk"
                writer.write(
                    b"HTTP/1.1 410 Gone\r\n"
                    b"Content-Type: text/plain\r\n"
                    + f"Content-Length: {len(body)}\r\n".encode()
                    + b"Connection: close\r\n\r\n"
                    + body
                )
                await writer.drain()
            except Exception:
                log.exception("media stream failed for %s", real_name)
                # Connection may already be half-written — just close.

        async def serve_media(token: str, filename: str, download: bool, writer):
            entry = resolve_token(token)
            if entry is None:
                await _media_404(writer, b"media token not found or expired")
                return
            await _stream_entry(entry, filename, download, writer)

        async def serve_durable(store_name: str, dl_name: str, download: bool, writer):
            entry = resolve_durable(store_name)
            if entry is None:
                await _media_404(writer, b"media not found")
                return
            # The durable filename is a content hash; prefer the URL's
            # decorative name (the original filename) for the download name.
            await _stream_entry(entry, dl_name or entry["filename"], download, writer)

        async def handle(reader, writer):
            try:
                request_line = await asyncio.wait_for(reader.readline(), timeout=5.0)
                # Parse request line: "GET /path?query HTTP/1.1"
                parts = request_line.decode("latin-1", "replace").strip().split(" ", 2)
                method = parts[0] if len(parts) > 0 else ""
                raw_path = parts[1] if len(parts) > 1 else "/"
                # Drain headers (we don't read any so far — could add origin check later).
                while True:
                    line = await asyncio.wait_for(reader.readline(), timeout=2.0)
                    if line in (b"\r\n", b"\n", b""):
                        break

                # OPTIONS preflight (CORS) — accept everything from any origin.
                if method == "OPTIONS":
                    writer.write(
                        b"HTTP/1.1 204 No Content\r\n"
                        b"Access-Control-Allow-Origin: *\r\n"
                        b"Access-Control-Allow-Methods: GET, OPTIONS\r\n"
                        b"Access-Control-Allow-Headers: *\r\n"
                        b"Access-Control-Max-Age: 3600\r\n"
                        b"Connection: close\r\n\r\n"
                    )
                    await writer.drain()
                    return

                parsed = urlparse(raw_path)
                path = parsed.path
                qs = parse_qs(parsed.query or "")

                # /media/<token>/<filename> — bot media delivery
                if path.startswith("/media/"):
                    from urllib.parse import unquote
                    rest = path[len("/media/"):]
                    download = qs.get("download", ["0"])[0] in ("1", "true", "yes")
                    # Durable store: /media/d/<hash><ext>/<displayname> — a stable,
                    # tokenless URL that survives the 24h cache TTL + restart.
                    if rest.startswith("d/"):
                        sub = rest[2:]
                        sep2 = sub.find("/")
                        store_name = sub if sep2 < 0 else sub[:sep2]
                        dl_name = unquote(sub[sep2 + 1:]) if sep2 >= 0 else ""
                        await serve_durable(store_name, dl_name, download, writer)
                        return
                    sep = rest.find("/")
                    if sep <= 0:
                        body = b"bad media url"
                        writer.write(
                            b"HTTP/1.1 400 Bad Request\r\n"
                            b"Content-Type: text/plain\r\n"
                            + f"Content-Length: {len(body)}\r\n".encode()
                            + b"Connection: close\r\n\r\n"
                            + body
                        )
                        await writer.drain()
                        return
                    token = rest[:sep]
                    filename = rest[sep + 1:]
                    await serve_media(token, filename, download, writer)
                    return

                # /health or / — JSON health envelope (Docker healthcheck + portal status poll).
                hermes_alive = self._hermes is not None and self._hermes.is_alive
                gateway_alive = (
                    self._gateway_runtime is not None and self._gateway_runtime.is_alive
                )
                dashboard_alive = (
                    self._dashboard_runtime is not None and self._dashboard_runtime.is_alive
                )
                clients_count = len(self._clients)
                status = 200 if hermes_alive else 503

                body = json.dumps({
                    "ok": hermes_alive,
                    "hermesAlive": hermes_alive,
                    "gatewayRuntimeAlive": gateway_alive,
                    "gatewayRuntimeRestarts": (
                        self._gateway_runtime.restarts if self._gateway_runtime else 0
                    ),
                    "dashboardAlive": dashboard_alive,
                    "dashboardRestarts": (
                        self._dashboard_runtime.restarts if self._dashboard_runtime else 0
                    ),
                    "clients": clients_count,
                    "bridgePort": BRIDGE_PORT,
                    "media": media_stats(),
                }).encode("utf-8")

                response = (
                    f"HTTP/1.1 {status} {'OK' if status == 200 else 'Service Unavailable'}\r\n"
                    f"Content-Type: application/json\r\n"
                    f"Content-Length: {len(body)}\r\n"
                    f"Access-Control-Allow-Origin: *\r\n"
                    f"Connection: close\r\n"
                    f"\r\n"
                ).encode("utf-8") + body

                writer.write(response)
                await writer.drain()
            except (asyncio.TimeoutError, ConnectionError):
                pass
            except Exception:
                log.exception("health_server: handler crashed")
            finally:
                with suppress(Exception):
                    writer.close()
                    await writer.wait_closed()

        try:
            server = await asyncio.start_server(handle, BRIDGE_HOST, BRIDGE_HEALTH_PORT)
            log.info(
                "health server listening on %s:%d",
                BRIDGE_HOST, BRIDGE_HEALTH_PORT,
            )
            async with server:
                await server.serve_forever()
        except asyncio.CancelledError:
            log.info("health server cancelled")
        except Exception:
            log.exception("health_server: server crashed")


# ---------------------------------------------------------------------
# WS frame helpers
# ---------------------------------------------------------------------


def _brand_scrub_error(text):
    """Hard brand-scrub a RAISED error message before it leaves the bridge.

    Raised RpcError messages (e.g. f"failed to read session: {exc}") go through
    the error path's _scrub_display_deep, which is a NO-OP for engine brand, so
    exception strings carrying 'hermes'/'hermes_cli'/internal paths would leak
    to the client. Error messages are NOT user prose, so a hard scrub is safe
    here (chat content travels the payload success path, untouched)."""
    if not isinstance(text, str) or not text:
        return text
    try:
        from hermes_multichannel_plugin.outbound_brand import scrub_outbound
        return scrub_outbound(text)
    except Exception:
        import re as _re
        out = text
        for pat, rep in (
            (r"hermes-agent", "Buff"),
            (r"Hermes[- ]?Agent", "Buff"),
            (r"Hermes", "Buff"),
            (r"HERMES", "BUFF"),
            (r"hermes", "buff"),
            (r"OpenClaw", "AgentBuff"),
        ):
            out = _re.sub(pat, rep, out)
        return out


async def _send_response(
    ws: WebSocketServerProtocol,
    frame_id: str,
    *,
    ok: bool,
    payload=None,
    error=None,
) -> None:
    frame = {"type": "res", "id": frame_id, "ok": ok}
    # Brand-leak chokepoint on the JSON-RPC response boundary.
    # success path: dispatch() (rpc_router) already brand-scrubs `result`
    # PROSE-AWARE (user/assistant chat + session titles verbatim, tool/system
    # surfaces scrubbed). We must NOT re-scrub the payload here — a blind
    # display-scrub would corrupt the very prose dispatch carefully preserved.
    # error path: RpcError.message (and the synthesized INTERNAL_ERROR
    # `f"{type(e).__name__}: {e}"` string) are NOT scrubbed upstream and carry
    # no user prose — launder them display-safe (MEDIA:/URL protected) here.
    try:
        from event_translator import _scrub_display_deep
        if ok and payload is not None:
            frame["payload"] = payload
        elif not ok:
            err = _scrub_display_deep(error or {"code": "UNKNOWN", "message": "no error detail"})
            # _scrub_display is a no-op for engine brand — hard-scrub the error
            # message so raised exception strings never leak "hermes"/paths.
            if isinstance(err, dict) and isinstance(err.get("message"), str):
                err["message"] = _brand_scrub_error(err["message"])
            frame["error"] = err
    except Exception:
        # Scrub import failure: fall back to raw values rather than dropping the response.
        if ok and payload is not None:
            frame["payload"] = payload
        elif not ok:
            frame["error"] = error or {"code": "UNKNOWN", "message": "no error detail"}
    try:
        await ws.send(json.dumps(frame, separators=(",", ":")))
    except ConnectionClosed:
        pass


async def _send_event(
    ws: WebSocketServerProtocol,
    event: str,
    payload=None,
) -> None:
    frame = {"type": "event", "event": event}
    if payload is not None:
        # Chokepoint scrub on bridge-originated events (proxy.ready, custom
        # payloads) so they share the same brand-leak protection as
        # Hermes-relayed events. These are bridge status frames (no user prose),
        # so a display-safe scrub (MEDIA:/URL protected) is correct. Chat events
        # do NOT pass through here — they go translate()->queue->ws.send direct.
        try:
            from event_translator import _scrub_display_deep
            frame["payload"] = _scrub_display_deep(payload)
        except Exception:
            frame["payload"] = payload
    try:
        await ws.send(json.dumps(frame, separators=(",", ":")))
    except ConnectionClosed:
        pass


async def _send_error_response(
    ws: WebSocketServerProtocol,
    frame_id: str,
    code: str,
    message: str,
) -> None:
    await _send_response(ws, frame_id, ok=False, error={"code": code, "message": message})


async def _close_safely(
    ws: WebSocketServerProtocol,
    code: int,
    reason: str,
) -> None:
    """Close WS with a reason that fits within the 123-byte cap (G7)."""
    try:
        # G7: reason capped at 123 bytes; truncate to 120 to be safe
        await ws.close(code, reason[:120])
    except Exception:
        pass


# ---------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------


async def _amain() -> None:
    bridge = Bridge()

    # Install signal handlers for graceful shutdown
    loop = asyncio.get_running_loop()
    stop_event = asyncio.Event()

    def _on_signal(sig: int) -> None:
        log.info("signal %d received, initiating shutdown", sig)
        stop_event.set()

    for sig_name in ("SIGINT", "SIGTERM"):
        sig = getattr(signal, sig_name, None)
        if sig is None:
            continue
        try:
            loop.add_signal_handler(sig, _on_signal, sig)
        except NotImplementedError:
            # Windows: add_signal_handler not supported for asyncio
            signal.signal(sig, lambda s, f: stop_event.set())

    # Run bridge in a task so we can race against the stop_event
    bridge_task = asyncio.create_task(bridge.start(), name="bridge-main")
    stop_task = asyncio.create_task(stop_event.wait(), name="stop-watcher")

    try:
        done, pending = await asyncio.wait(
            {bridge_task, stop_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if bridge_task in done:
            # Bridge exited on its own — surface the result/exception
            try:
                bridge_task.result()
            except Exception:
                log.exception("bridge.start() raised")
                raise
        else:
            # Stop requested
            bridge_task.cancel()
            with suppress(asyncio.CancelledError, Exception):
                await bridge_task
    finally:
        await bridge.stop()


def main() -> int:
    try:
        asyncio.run(_amain())
        return 0
    except KeyboardInterrupt:
        return 0
    except Exception:
        log.exception("bridge main crashed")
        return 1


if __name__ == "__main__":
    sys.exit(main())
