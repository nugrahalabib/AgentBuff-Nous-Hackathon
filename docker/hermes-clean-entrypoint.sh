#!/usr/bin/env bash
# Vanilla Hermes — serve the NATIVE dashboard for browser viewing. No AgentBuff
# bridge/plugins. Minimal: optionally seed a provider key so chat is usable,
# otherwise everything is stock Hermes default.
set -euo pipefail

log() { echo "[clean-entrypoint] $*"; }

HERMES_HOME="${HERMES_HOME:-/home/hermes/.hermes}"
mkdir -p "$HERMES_HOME"

# Seed a provider key into ~/.hermes/.env so vanilla chat actually works.
# (Hermes reads provider keys from env / .env — this is stock behaviour.)
if [ -n "${HERMES_DEFAULT_GEMINI_KEY:-}" ]; then
  if ! grep -q "^GEMINI_API_KEY=" "$HERMES_HOME/.env" 2>/dev/null; then
    echo "GEMINI_API_KEY=${HERMES_DEFAULT_GEMINI_KEY}" >> "$HERMES_HOME/.env"
    log "seeded GEMINI_API_KEY into .env"
  fi
fi

HERMES_VER=$(python -c "from importlib.metadata import version; print(version('hermes-agent'))" 2>/dev/null || echo "unknown")
log "VANILLA Hermes ${HERMES_VER} — stock Hermes (no AgentBuff bridge/plugins/rebrand)"

# If a Telegram (or other) platform is configured, run the native messaging
# gateway in the background so the bot polls + the agent replies. Single
# instance per container (entrypoint owns it; a container restart = one clean
# poller, no orphan conflicts).
if grep -qiE "^TELEGRAM_BOT_TOKEN=|^DISCORD_BOT_TOKEN=|^SLACK_" "$HERMES_HOME/.env" 2>/dev/null \
   || python -c "import yaml,os,sys; d=yaml.safe_load(open(os.path.expanduser('~/.hermes/config.yaml'))) or {}; sys.exit(0 if (d.get('platforms')) else 1)" 2>/dev/null; then
  log "messaging platform configured — starting native gateway (channels) in background"
  ( hermes gateway run --replace > /tmp/gateway.log 2>&1 & )
fi

log "starting native dashboard on 0.0.0.0:9119"
# Native dashboard. --insecure eases local viewing; --no-open skips trying to
# launch a browser inside the container; --skip-build uses the shipped web bundle.
exec hermes dashboard --host 0.0.0.0 --port 9119 --insecure --no-open --skip-build
