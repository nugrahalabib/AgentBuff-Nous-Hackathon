"""
tier_limits.py — Per-tier entitlement gate for the AgentBuff bridge (D7).

This is the AUTHORITATIVE enforcement layer for "how many agents / channels /
skills can this user have on their tier". It mirrors energy_gate.py exactly:

  - The bridge sees an `agents.create` / `channels.pair` request from the portal.
  - It fetches the user's limits from the portal's /api/users/me/limits endpoint
    (authed by the same bridge token used for WS auth — the portal resolves the
    user from it), caching the result briefly.
  - The calling handler counts the user's CURRENT agents/channels (live engine
    state) and calls `check_count(...)`. If the count is at or over the per-tier
    cap, the gate raises `LimitError`, which the dispatch layer turns into a
    `{type:"res", ok:false, error:{code,message}}` frame — without forwarding to
    the engine.

Why the bridge and not the portal WS proxy: the proxy forwards frames raw; a
gate placed only there is bypassable by a direct loopback WS connection. The
engine handler is the single chokepoint every create path passes through.

Limit semantics:
  - A limit of -1 (or any negative) means UNLIMITED — never blocks.
  - Media caps are NOT enforced here (they are injected as env vars and applied
    in attachment_preprocessor.py); this gate only carries entitlement counts.

Fail-open: if the portal is unreachable we DO NOT block creates (entitlement is
about hosting cost, and our own outage shouldn't stop a paying user). Set
strict_on_portal_down=True to fail closed.
"""

from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Optional

import httpx


log = logging.getLogger("bridge.tier_limits")

# How long to trust a fetched limits payload (seconds). Creates are rare, so a
# 30s window is plenty; a tier change reflects within 30s on the next create.
CACHE_TTL_S = 30.0
FETCH_TIMEOUT_S = 3.0

# Maps the logical entity name to the limits-payload field + the error code the
# /app error classifier maps to an "upgrade" prompt.
_FIELD_BY_KIND = {
    "agents": ("maxAgents", "AGENT_LIMIT_EXCEEDED"),
    "channels": ("maxChannels", "CHANNEL_LIMIT_EXCEEDED"),
    "skills": ("maxSkills", "SKILL_LIMIT_EXCEEDED"),
}

# Generous fail-open payload when the portal can't be reached — unlimited so a
# portal outage never blocks a create.
_UNLIMITED = {"maxAgents": -1, "maxChannels": -1, "maxSkills": -1}


@dataclass
class _CachedLimits:
    limits: dict
    fetched_at: float


class LimitError(Exception):
    """Per-tier entitlement check denied the request."""

    def __init__(
        self,
        code: str,
        message: str,
        *,
        limit: Optional[int] = None,
        current: Optional[int] = None,
    ) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.limit = limit
        self.current = current


class TierLimitGate:
    """Per-tier entitlement check against the AgentBuff portal API."""

    def __init__(
        self,
        portal_base_url: str,
        bridge_token: str,
        *,
        cache_ttl_s: float = CACHE_TTL_S,
        strict_on_portal_down: bool = False,
    ) -> None:
        self._portal_base_url = portal_base_url.rstrip("/")
        self._bridge_token = bridge_token
        self._cache_ttl = cache_ttl_s
        self._strict_on_portal_down = strict_on_portal_down

        self._cache: Optional[_CachedLimits] = None
        self._in_flight: Optional[asyncio.Future] = None
        self._lock = asyncio.Lock()
        self._http_client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self) -> "TierLimitGate":
        self._http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(FETCH_TIMEOUT_S),
            headers={
                "Authorization": f"Bearer {self._bridge_token}",
                "User-Agent": "agentbuff-hermes-bridge/1.0",
            },
        )
        return self

    async def __aexit__(self, *_) -> None:
        if self._http_client:
            await self._http_client.aclose()
            self._http_client = None

    # -----------------------------------------------------------------
    # Public API
    # -----------------------------------------------------------------

    async def check_count(self, kind: str, current_count: int) -> None:
        """Raise LimitError if `current_count` is at/over the per-tier cap for
        `kind` ("agents" | "channels" | "skills"). A negative cap = unlimited."""
        field, code = _FIELD_BY_KIND.get(kind, (None, None))
        if field is None:
            return  # unknown kind — never block
        limits = await self.get_limits()
        cap = limits.get(field, -1)
        if not isinstance(cap, int) or cap < 0:
            return  # unlimited
        if current_count >= cap:
            human = {"agents": "agen", "channels": "channel", "skills": "skill"}[kind]
            raise LimitError(
                code,
                f"Batas {human} untuk paket ini sudah tercapai "
                f"({current_count}/{cap}). Upgrade untuk menambah lagi.",
                limit=cap,
                current=current_count,
            )

    def invalidate(self) -> None:
        """Clear the cache (e.g. after a successful create) so the next check
        sees the updated count basis. The count itself is read live by the
        handler; this just refreshes the LIMIT side."""
        self._cache = None

    # -----------------------------------------------------------------
    # Internal: fetch limits from portal with cache + stampede prevention
    # -----------------------------------------------------------------

    async def get_limits(self) -> dict:
        now = time.monotonic()
        if self._cache and (now - self._cache.fetched_at) < self._cache_ttl:
            return self._cache.limits

        is_leader = False
        leader_future: asyncio.Future
        async with self._lock:
            now = time.monotonic()
            if self._cache and (now - self._cache.fetched_at) < self._cache_ttl:
                return self._cache.limits
            if self._in_flight and not self._in_flight.done():
                leader_future = self._in_flight
            else:
                self._in_flight = asyncio.get_running_loop().create_future()
                leader_future = self._in_flight
                is_leader = True

        if not is_leader:
            try:
                return await leader_future
            except Exception:
                pass  # leader failed; fetch ourselves below

        try:
            limits = await self._fetch_limits_now()
            self._cache = _CachedLimits(limits=limits, fetched_at=time.monotonic())
            if not leader_future.done():
                leader_future.set_result(limits)
            return limits
        except Exception as e:
            if not leader_future.done():
                leader_future.set_exception(e)
            raise

    async def _fetch_limits_now(self) -> dict:
        if self._http_client is None:
            self._http_client = httpx.AsyncClient(
                timeout=httpx.Timeout(FETCH_TIMEOUT_S),
                headers={
                    "Authorization": f"Bearer {self._bridge_token}",
                    "User-Agent": "agentbuff-hermes-bridge/1.0",
                },
            )

        url = f"{self._portal_base_url}/api/users/me/limits"
        try:
            resp = await self._http_client.get(url)
        except (httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError) as e:
            log.warning(
                "tier_limits: portal API unreachable (%s); strict=%s",
                e, self._strict_on_portal_down,
            )
            if self._strict_on_portal_down:
                raise LimitError("PORTAL_UNREACHABLE", f"Cannot verify limits: {e}") from e
            return dict(_UNLIMITED)  # fail open

        if resp.status_code in (401, 403):
            # Auth problem — fail open (don't block the user on our misconfig).
            log.warning("tier_limits: portal rejected bridge token (status %s)", resp.status_code)
            return dict(_UNLIMITED)

        if resp.status_code != 200:
            log.warning("tier_limits: portal returned status %s for limits lookup", resp.status_code)
            if self._strict_on_portal_down:
                raise LimitError("PORTAL_ERROR", f"Portal limits API returned {resp.status_code}")
            return dict(_UNLIMITED)

        try:
            body = resp.json()
        except ValueError:
            log.warning("tier_limits: portal returned non-JSON body")
            return dict(_UNLIMITED)

        if not isinstance(body, dict):
            return dict(_UNLIMITED)
        # Only keep the entitlement fields; defaults to unlimited if absent.
        return {
            "maxAgents": body.get("maxAgents", -1),
            "maxChannels": body.get("maxChannels", -1),
            "maxSkills": body.get("maxSkills", -1),
        }
