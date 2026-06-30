#!/bin/bash
# =============================================================================
# build-hermes-image.sh — build the per-user Hermes container image
# =============================================================================
#
# Usage:
#   ./scripts/build-hermes-image.sh                        # standard build
#   ./scripts/build-hermes-image.sh --no-cache             # full rebuild
#   ./scripts/build-hermes-image.sh --hermes 0.14.1        # pin specific Hermes version
#   ./scripts/build-hermes-image.sh --tag hermes-agent:dev # custom tag
#
# Pre-flight checks built-in:
#   - Docker daemon reachable
#   - Build context (docker/hermes-bridge/) exists
#   - Dockerfile present
#
# Output:
#   Local image: hermes-agent:local
#   Tag also pinned to: hermes-agent:v0.14.0  (or version specified)
# =============================================================================

set -euo pipefail

# Resolve to LandingPage root (script lives in scripts/)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Defaults
# Keep in lock-step with docker/Dockerfile.hermes `ARG HERMES_VERSION` (and its
# `ARG HERMES_GIT_REF` CalVer pin, currently v2026.6.5). This default is passed
# as --build-arg and OVERRIDES the Dockerfile ARG, so a stale value here silently
# downgrades the engine (it shipped 0.14.0 here long after the image moved to
# 0.16.0). Bump this whenever the Dockerfile version is bumped.
HERMES_VERSION="0.17.0"
# HACKATHON-ISOLATED tag — must NOT be the prod `hermes-agent:local` so building
# from this copy never overwrites the production engine image.
TAG="hermes-agent-hack:local"
DOCKERFILE="docker/Dockerfile.hermes"
BUILD_ARGS=()

# -----------------------------------------------------------------------------
# CLI arg parsing
# -----------------------------------------------------------------------------

while [ $# -gt 0 ]; do
    case "$1" in
        --no-cache)
            BUILD_ARGS+=("--no-cache")
            shift
            ;;
        --hermes)
            HERMES_VERSION="$2"
            shift 2
            ;;
        --tag)
            TAG="$2"
            shift 2
            ;;
        --pull)
            BUILD_ARGS+=("--pull")
            shift
            ;;
        -h|--help)
            grep '^#' "$0" | head -25 | sed 's/^# \?//'
            exit 0
            ;;
        *)
            echo "Unknown argument: $1" >&2
            echo "Use --help for usage." >&2
            exit 64
            ;;
    esac
done

# -----------------------------------------------------------------------------
# Pre-flight
# -----------------------------------------------------------------------------

cd "${REPO_ROOT}"

echo "=== AgentBuff Hermes Image Builder ==="
echo "  repo root:      ${REPO_ROOT}"
echo "  Dockerfile:     ${DOCKERFILE}"
echo "  Hermes version: ${HERMES_VERSION}"
echo "  Image tag:      ${TAG}"
echo "  Extra args:     ${BUILD_ARGS[*]:-(none)}"
echo

# Check Docker daemon
if ! docker info >/dev/null 2>&1; then
    echo "FATAL: Docker daemon is not reachable." >&2
    echo "  - Is Docker Desktop running?" >&2
    echo "  - Is the docker CLI in PATH?" >&2
    exit 1
fi

# Check Dockerfile exists
if [ ! -f "${DOCKERFILE}" ]; then
    echo "FATAL: ${DOCKERFILE} not found." >&2
    exit 1
fi

# Check bridge source exists
if [ ! -d "docker/hermes-bridge" ]; then
    echo "FATAL: docker/hermes-bridge/ folder not found." >&2
    echo "       Did you run from LandingPage/ root?" >&2
    exit 1
fi

# Sanity check: bridge has main entry file
if [ ! -f "docker/hermes-bridge/agentbuff_bridge.py" ]; then
    echo "FATAL: docker/hermes-bridge/agentbuff_bridge.py missing." >&2
    exit 1
fi

# -----------------------------------------------------------------------------
# Build
# -----------------------------------------------------------------------------

echo "Starting docker build..."
echo

# shellcheck disable=SC2068
docker build \
    "${BUILD_ARGS[@]}" \
    --build-arg "HERMES_VERSION=${HERMES_VERSION}" \
    -t "${TAG}" \
    -t "hermes-agent-hack:v${HERMES_VERSION}" \
    -f "${DOCKERFILE}" \
    .

# -----------------------------------------------------------------------------
# Report
# -----------------------------------------------------------------------------

echo
echo "=== Build complete ==="
docker images "${TAG%:*}" --format 'table {{.Repository}}\t{{.Tag}}\t{{.Size}}\t{{.CreatedAt}}'
echo
echo "Next steps:"
echo "  1. Verify image runs:"
echo "       docker run --rm -e BRIDGE_TOKEN=test-token-12345678 ${TAG} --help"
echo
echo "  2. Run end-to-end test against bridge:"
echo "       pnpm tsx --env-file=.env.local scripts/test-hermes-bridge.ts"
echo
echo "  3. Provision a test user container:"
echo "       pnpm tsx --env-file=.env.local scripts/provision-hermes-test-container.ts"
