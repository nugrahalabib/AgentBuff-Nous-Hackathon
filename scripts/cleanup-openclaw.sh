#!/bin/bash
# =============================================================================
# cleanup-openclaw.sh — DESTRUCTIVE: removes OpenClaw artifacts after Hermes
# migration is stable.
# =============================================================================
#
# DO NOT RUN until:
#   1. ALL users migrated to Hermes (no `engineType="openclaw"` rows in
#      user_container — verify with: SELECT COUNT(*) FROM user_container
#      WHERE engine_type = 'openclaw';)
#   2. Hermes flow stable in production for AT LEAST 1 week
#   3. Backup zip from migration start (2026-05-21) verified extractable
#   4. CLAUDE.md updated to reflect Hermes-only state
#   5. Chief gives explicit "decom OpenClaw" command
#
# This script is INTENTIONALLY a skeleton — you must edit and uncomment
# the destructive operations after verifying preconditions above.
# It's checked in so the cleanup path is documented + reviewable, NOT so
# anyone can accidentally run it.
# =============================================================================

set -euo pipefail

cat <<'EOF'
┌──────────────────────────────────────────────────────────────────────────┐
│  cleanup-openclaw.sh — STUB                                              │
│                                                                          │
│  This script is intentionally a no-op. The destructive operations below  │
│  must be uncommented + reviewed individually before running.             │
│                                                                          │
│  Preconditions checklist (verify each manually first):                   │
│    [ ] All OpenClaw user containers migrated to Hermes                   │
│    [ ] No `engineType="openclaw"` rows in user_container                 │
│    [ ] Hermes flow stable for >= 1 week                                  │
│    [ ] Backup zip from migration start verified extractable              │
│    [ ] CLAUDE.md + memory updated to reflect Hermes-only state           │
│    [ ] Chief explicit "decom OpenClaw" command received                  │
└──────────────────────────────────────────────────────────────────────────┘
EOF

# Bail out — this script does nothing until manually edited.
exit 0

# -----------------------------------------------------------------------------
# UNCOMMENT BELOW ONE SECTION AT A TIME, RUN, VERIFY, THEN PROCEED.
# -----------------------------------------------------------------------------

# SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# PARENT_ROOT="$(cd "${REPO_ROOT}/.." && pwd)"
# DATESTAMP="$(date +%Y-%m-%d)"

# # ===== 1. Verify no OpenClaw user containers remain =====
# # Run via: pnpm tsx --env-file=.env.local -e "..."
# # Should output 0

# # ===== 2. Archive Reff/openclaw/ =====
# # mv "${PARENT_ROOT}/Reff/openclaw" "${PARENT_ROOT}/.archive-openclaw-${DATESTAMP}/"

# # ===== 3. Delete src/lib/openclaw/ =====
# # rm -rf "${REPO_ROOT}/src/lib/openclaw"

# # ===== 4. Drop OpenClaw env vars from .env.example =====
# # sed -i '/^OPENCLAW_/d' "${REPO_ROOT}/.env.example"

# # ===== 5. Remove OpenClaw imports from server.ts (manual edit) =====

# # ===== 6. Drop OpenClaw Docker image =====
# # docker rmi openclaw:local 2>/dev/null || true

# # ===== 7. Drop orphaned OpenClaw containers + volumes =====
# # docker ps -aq --filter "name=openclaw-user-" | xargs -r docker rm -f
# # docker volume ls -q --filter "name=openclaw-user-" | xargs -r docker volume rm

# # ===== 8. Drop gateway_token column from user_container (Drizzle migration) =====
