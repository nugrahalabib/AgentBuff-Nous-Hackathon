#!/bin/bash
# =============================================================================
# AgentBuff Hermes Container — entrypoint
# =============================================================================
#
# Order of operations:
#   1. Validate required env vars (fail-fast if missing)
#   2. Pre-create HERMES_HOME structure with correct permissions
#   3. Process seed/ folder if present (initial config from portal)
#   4. Launch bridge (which spawns Hermes TUI subprocess + listens on WS)
#
# Restart policy:
#   - tini is PID 1 (entrypoint sets that)
#   - Bridge supervises its Hermes subprocess (auto-respawn on crash)
#   - If bridge itself crashes, container exits → portal triggers
#     `docker restart` via provisioning retry loop in docker.ts
#
# Env vars used (matched to docker/Dockerfile.hermes defaults):
#   BRIDGE_TOKEN       — REQUIRED. Auth token for portal connection.
#   BRIDGE_PORT        — default 18789
#   BRIDGE_HEALTH_PORT — default 18790
#   HERMES_HOME        — default /home/hermes/.hermes
#   PORTAL_BASE_URL    — default http://host.docker.internal:617
#   ENERGY_GATE_ENABLED — default true ("1" / "true" / "yes")
#   HERMES_DEFAULT_MODEL — default google/gemini-2.5-flash
#   HERMES_DEFAULT_API_KEY — provider API key (also accepts HERMES_DEFAULT_GEMINI_KEY)
#   LOG_LEVEL          — default INFO
# =============================================================================

set -euo pipefail

log() {
    printf '%s [entrypoint] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"
}

fail() {
    log "FATAL: $*" >&2
    exit 1
}

# -----------------------------------------------------------------------------
# 1) Env validation
# -----------------------------------------------------------------------------

if [ -z "${BRIDGE_TOKEN:-}" ]; then
    fail "BRIDGE_TOKEN env var is required but missing/empty. \
Provisioning bug? Check src/lib/hermes/docker.ts token generation."
fi

if [ "${#BRIDGE_TOKEN}" -lt 16 ]; then
    fail "BRIDGE_TOKEN is too short (${#BRIDGE_TOKEN} chars). Need >=16 (>=32 recommended)."
fi

HERMES_HOME="${HERMES_HOME:-/home/hermes/.hermes}"

# -----------------------------------------------------------------------------
# 2) Filesystem prep
# -----------------------------------------------------------------------------

log "ensuring HERMES_HOME directory tree at ${HERMES_HOME}"
# L2 (2026-05-30): do NOT pre-create "${HERMES_HOME}/agents" — it's the legacy
# multi-agent overlay that agents_handler._migrate_legacy_overlay() rmtree's at
# every bridge init (the two were fighting). Named agents live under
# profiles/<id>/ now.
mkdir -p \
    "${HERMES_HOME}" \
    "${HERMES_HOME}/skills" \
    "${HERMES_HOME}/cron" \
    "${HERMES_HOME}/memory" \
    "${HERMES_HOME}/seed"

# -----------------------------------------------------------------------------
# 3) Seed processing — apply portal-supplied initial config
# -----------------------------------------------------------------------------
#
# The portal can place YAML files inside ${HERMES_HOME}/seed/ before
# starting the container. Common seed files:
#
#   seed/channels.yaml         → merge into config.yaml's `channels:` namespace
#   seed/bindings.yaml         → merge into config.yaml's `bindings:` namespace
#   seed/agents/<id>/profile.yaml → copy to agents/<id>/profile.yaml
#   seed/agents/<id>/SOUL.md   → copy to agents/<id>/SOUL.md
#
# The bridge itself processes seed/ on boot (see agentbuff_bridge.py
# _seed_initial_config) so this script doesn't need to handle it manually;
# we just ensure the directory exists.

# -----------------------------------------------------------------------------
# 4) Sanity check Hermes installation
# -----------------------------------------------------------------------------

if ! python -c "import hermes_state" 2>/dev/null; then
    fail "hermes-agent package is not importable. Image build is broken."
fi

# tui_gateway.entry inserts HERMES_PYTHON_SRC_ROOT at the front of sys.path
# so transitive imports (tools.mcp_tool, hermes_cli.config) resolve against
# the installed package set instead of CWD. hermes_cli.main sets this when
# spawning the TUI; we mirror that here so the bridge subprocess matches.
if [ -z "${HERMES_PYTHON_SRC_ROOT:-}" ]; then
    HERMES_PYTHON_SRC_ROOT=$(python -c "import hermes_cli, os; print(os.path.dirname(os.path.dirname(hermes_cli.__file__)))" 2>/dev/null || echo "/usr/local/lib/python3.11/site-packages")
fi
export HERMES_PYTHON_SRC_ROOT

# Display Hermes version for log audit trail
HERMES_VER=$(python -c "from importlib.metadata import version; print(version('hermes-agent'))" 2>/dev/null || echo "unknown")
log "starting AgentBuff Hermes Bridge"
log "  hermes-agent version: ${HERMES_VER}"
log "  HERMES_HOME:          ${HERMES_HOME}"
log "  BRIDGE_PORT:          ${BRIDGE_PORT:-18789}"
log "  BRIDGE_HEALTH_PORT:   ${BRIDGE_HEALTH_PORT:-18790}"
log "  PORTAL_BASE_URL:      ${PORTAL_BASE_URL:-http://host.docker.internal:617}"
log "  ENERGY_GATE_ENABLED:  ${ENERGY_GATE_ENABLED:-true}"
log "  LOG_LEVEL:            ${LOG_LEVEL:-INFO}"
log "  BRIDGE_TOKEN length:  ${#BRIDGE_TOKEN}"
log "  HERMES_PYTHON_SRC_ROOT: ${HERMES_PYTHON_SRC_ROOT}"

# -----------------------------------------------------------------------------
# 5) Exec bridge (replaces shell, becomes child of tini)
# -----------------------------------------------------------------------------

cd /home/hermes

# Sync the bundled ENGINE skill packs to the INSTALLED engine version.
#  - First boot: seed core (lean) packs into ~/.hermes/skills (marker-gated).
#  - Engine version CHANGED on an existing volume (e.g. 0.15.2 -> 0.16.0):
#    re-seed to ADD skills the new engine introduced, then reconcile to DROP
#    engine skills the new version removed/demoted + re-capture the reset
#    baseline. USER-authored + MARKETPLACE skills are NEVER touched (identified
#    via .agentbuff_builtin_baseline.json — anything not in it is user-origin).
# All steps non-fatal: a sync failure must never block the bridge from starting.
ENGINE_VER="$(python -c 'import importlib.metadata as m; print(m.version("hermes-agent"))' 2>/dev/null || echo unknown)"
VER_MARKER="${HERMES_HOME}/.agentbuff_engine_version"
PREV_VER="$(cat "$VER_MARKER" 2>/dev/null || true)"
# Bundled-pack content hash (baked by Dockerfile.hermes). Re-sync when the
# image's skill pack CHANGED even at the SAME engine version — otherwise an
# existing volume freezes at its provision-vintage skill set (it only ever
# reconciled on an engine-version bump, so two accounts on the same engine but
# different image builds permanently diverged).
PACK_HASH="$(cat /opt/hermes-bundled-skills/.pack-hash 2>/dev/null || echo unknown)"
PACK_MARKER="${HERMES_HOME}/.agentbuff_pack_hash"
PREV_PACK="$(cat "$PACK_MARKER" 2>/dev/null || true)"
SKILL_RESYNC=""
if [ -n "$PREV_VER" ] && [ "$PREV_VER" != "$ENGINE_VER" ]; then
    log "engine bump detected ($PREV_VER -> $ENGINE_VER) — re-syncing ENGINE skills (add new + drop removed; user/marketplace preserved)"
    rm -f "${HERMES_HOME}/skills/.agentbuff_seeded_v1"  # let the seed add the new engine packs
    SKILL_RESYNC=1
elif [ -n "$PREV_PACK" ] && [ "$PREV_PACK" != "$PACK_HASH" ]; then
    log "bundled-pack change detected (same engine $ENGINE_VER, hash $PREV_PACK -> $PACK_HASH) — re-syncing ENGINE skills (user/marketplace preserved)"
    rm -f "${HERMES_HOME}/skills/.agentbuff_seeded_v1"
    SKILL_RESYNC=1
else
    log "seeding bundled skills (first boot only; engine=$ENGINE_VER)"
fi
python -u /app/bridge/seed_bundled_skills.py || log "skill seed skipped (non-fatal)"
if [ -n "$SKILL_RESYNC" ]; then
    python -u /app/bridge/reconcile_engine_skills.py || log "skill reconcile skipped (non-fatal)"
fi
echo "$ENGINE_VER" > "$VER_MARKER" 2>/dev/null || true
echo "$PACK_HASH" > "$PACK_MARKER" 2>/dev/null || true

exec python -u /app/bridge/agentbuff_bridge.py
