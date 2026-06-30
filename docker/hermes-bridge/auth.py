"""
auth.py — Bridge token authentication.

Validates the `connect` frame from portal/browser clients. Same security
model as OpenClaw's gateway token:
  - Token is a ≥32-byte random secret per container
  - Stored in Postgres `user_container.bridgeToken` column
  - Injected into container via env var `BRIDGE_TOKEN` at provision time
  - Browser never sees it; only the portal's ws-proxy adds it to the
    `connect` frame before forwarding to bridge

The bridge ONLY trusts the env-injected token. Anything else is rejected.

Why this matters:
  - If bridge accepts wrong token = ANY user could chat as any other user
  - If bridge accepts wrong client.id = scope escalation possible
  - Constant-time comparison prevents timing-attack token brute-force

OpenClaw G1 gotcha equivalence:
  - dangerouslyDisableDeviceAuth + magic client.id + Origin header
  - In Hermes bridge: bridgeToken + magic client.id (agentbuff-portal)
  - Origin not enforced here because bridge runs in container-local
    namespace (portal already validated the user before opening WS)
"""

from __future__ import annotations

import hmac
import logging
import os
from dataclasses import dataclass
from typing import Optional


log = logging.getLogger("bridge.auth")


# Magic string prefixes/exact-matches the bridge accepts in the connect frame.
# Bridge security is the TOKEN — clientId is a defense-in-depth tag for logs +
# audit trail, not the security boundary itself. Permissive set allows the
# portal's various subsystems (chat WS, skill installer, usage poller, channel
# services, admin scripts) to self-identify distinctly in logs while sharing
# the same token check.
#
# Accept: any clientId starting with "agentbuff-" (portal's natural namespace).
# (OpenClaw-era back-compat id "openclaw-control-ui" REMOVED 2026-06-03 — every
#  active caller uses the agentbuff- namespace: ws-proxy BRIDGE_MAGIC_CLIENT_ID
#  ="agentbuff-portal", gateway-client, usage poller, channel/skill services,
#  admin scripts. No code sent the old id — verified by grep — dead code purged.)
ACCEPTED_CLIENT_ID_PREFIX = "agentbuff-"
ACCEPTED_CLIENT_ID_EXACT: frozenset = frozenset()

# Valid roles. Anything else rejected.
VALID_ROLES = {"operator", "admin"}

# Required scope set for operator role. Subset of OpenClaw's scope model.
OPERATOR_SCOPES = frozenset({
    "operator.admin",
    "operator.read",
    "operator.write",
    "operator.approvals",
    "operator.pairing",
})


@dataclass(frozen=True)
class AuthContext:
    """Validated identity of a connected client. Immutable."""

    client_id: str          # "agentbuff-portal"
    role: str               # "operator"
    scopes: frozenset[str]  # what this connection can do
    instance_id: str        # portal-side instance identifier (for logs)
    user_id: Optional[str]  # portal-resolved user ID if available


class AuthError(Exception):
    """Raised when auth validation fails. Caller should close WS."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def get_bridge_token() -> str:
    """Read bridge token from env at startup. Fail-fast if missing.

    Returns the token. Caller stores once at boot, doesn't re-read.
    """
    token = os.environ.get("BRIDGE_TOKEN", "").strip()
    if not token:
        raise RuntimeError(
            "BRIDGE_TOKEN env var is required but empty/missing. "
            "Bridge cannot authenticate any client without it."
        )
    if len(token) < 16:
        # Fail loud — short tokens are brute-forceable
        raise RuntimeError(
            f"BRIDGE_TOKEN is too short ({len(token)} chars). "
            "Need ≥16 characters (≥32 recommended). "
            "Provisioning bug? Check src/lib/hermes/docker.ts token generation."
        )
    return token


def validate_connect_frame(
    frame: dict,
    expected_token: str,
) -> AuthContext:
    """Validate `connect` frame from portal client.

    Args:
        frame: parsed JSON frame from WS client
        expected_token: token read at bridge startup (do not re-read here)

    Returns:
        AuthContext on success

    Raises:
        AuthError on any validation failure. Caller MUST close WS with
        close code 4001 (Unauthorized).
    """
    # 1) Frame shape must be a "req" with method "connect"
    if not isinstance(frame, dict):
        raise AuthError("INVALID_REQUEST", "first frame must be a JSON object")
    if frame.get("type") != "req":
        raise AuthError("INVALID_REQUEST", "first frame type must be 'req'")
    if frame.get("method") != "connect":
        raise AuthError("INVALID_REQUEST", "first frame method must be 'connect'")
    frame_id = frame.get("id")
    if not isinstance(frame_id, str) or not frame_id:
        raise AuthError("INVALID_REQUEST", "connect frame must include string 'id'")

    params = frame.get("params") or {}
    if not isinstance(params, dict):
        raise AuthError("INVALID_REQUEST", "connect.params must be an object")

    # 2) Token validation (constant-time compare to defeat timing attacks)
    auth = params.get("auth") or {}
    if not isinstance(auth, dict):
        raise AuthError("INVALID_AUTH", "connect.params.auth must be an object")
    presented_token = auth.get("token")
    if not isinstance(presented_token, str) or not presented_token:
        raise AuthError("INVALID_AUTH", "connect.params.auth.token is required")
    if not hmac.compare_digest(presented_token, expected_token):
        # Don't echo tokens or token-length in error — defense in depth
        log.warning("auth: token mismatch (instance=%s)", _safe_instance(params))
        raise AuthError("UNAUTHORIZED", "invalid bridge token")

    # 3) Client identity — permissive prefix + back-compat exact set
    client = params.get("client") or {}
    if not isinstance(client, dict):
        raise AuthError("INVALID_REQUEST", "connect.params.client must be an object")
    client_id = client.get("id")
    if not isinstance(client_id, str) or not client_id:
        raise AuthError(
            "INVALID_REQUEST",
            "connect.params.client.id is required and must be a non-empty string",
        )
    accepted = (
        client_id.startswith(ACCEPTED_CLIENT_ID_PREFIX)
        or client_id in ACCEPTED_CLIENT_ID_EXACT
    )
    if not accepted:
        log.warning("auth: client.id rejected (got=%r)", client_id)
        raise AuthError(
            "FORBIDDEN",
            f"client.id must start with {ACCEPTED_CLIENT_ID_PREFIX!r} "
            f"or be one of {sorted(ACCEPTED_CLIENT_ID_EXACT)}",
        )

    # 4) Role validation
    role = params.get("role")
    if role not in VALID_ROLES:
        raise AuthError(
            "INVALID_REQUEST",
            f"role must be one of {sorted(VALID_ROLES)}; got {role!r}",
        )

    # 5) Scope check (operator role requires the full operator scope set)
    scopes_raw = params.get("scopes") or []
    if not isinstance(scopes_raw, list):
        raise AuthError("INVALID_REQUEST", "scopes must be an array")
    requested_scopes = frozenset(s for s in scopes_raw if isinstance(s, str))

    if role == "operator":
        # Portal MUST request the full operator scope set. If not, reject —
        # we don't downgrade silently (OpenClaw did this, gave attackers
        # a stealth path; we make it explicit).
        missing = OPERATOR_SCOPES - requested_scopes
        if missing:
            raise AuthError(
                "INVALID_REQUEST",
                f"operator role requires scopes {sorted(OPERATOR_SCOPES)}; "
                f"missing: {sorted(missing)}",
            )
        granted_scopes = OPERATOR_SCOPES
    else:
        granted_scopes = requested_scopes  # admin role: pass through

    # 6) Instance ID — informational; used in log lines + audit trail
    instance_id = client.get("instanceId") or "unknown"
    if not isinstance(instance_id, str):
        instance_id = "unknown"

    # 7) Optional user_id (portal can include for audit logging)
    user_id = params.get("userId")
    if user_id is not None and not isinstance(user_id, str):
        user_id = None

    log.info(
        "auth: accepted client=%s role=%s instance=%s user=%s",
        client_id, role, instance_id, user_id or "-",
    )

    return AuthContext(
        client_id=client_id,
        role=role,
        scopes=granted_scopes,
        instance_id=instance_id,
        user_id=user_id,
    )


def _safe_instance(params: dict) -> str:
    """Extract instance_id safely for logging (no exception on malformed)."""
    try:
        client = params.get("client") or {}
        return str(client.get("instanceId") or "unknown")
    except Exception:
        return "unknown"
