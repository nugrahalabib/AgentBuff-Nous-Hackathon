"""
energy_gate.py — Pre-flight energy balance check for chat-sending RPCs.

This is the GATEKEEPER for AgentBuff's monetization. Without it, a user
with zero energy could still call `chat.send` and burn LLM tokens that
AgentBuff has to pay for. The portal would catch the debit later but
the cost has already been incurred.

OpenClaw G8 equivalence — this lives at the proxy/bridge layer, NOT the
LLM engine layer:
  - Bridge sees `chat.send` request from portal/browser
  - Bridge queries portal's /api/users/me/energy endpoint with bridge token
  - If balance < MIN_ENERGY_TO_PROMPT: reply with error code "ENERGY_EXHAUSTED"
    without forwarding to Hermes
  - Else: forward (LLM call proceeds normally)

Performance:
  - Energy check adds one HTTP roundtrip per chat send
  - We CACHE the balance for a short TTL to avoid hammering portal API
    on rapid-fire sends; cache invalidated on first decrement (TODO: webhook).
  - Cache TTL ≈ 5s — fast enough that a top-up reflects within a few seconds,
    short enough that we don't gate against a stale value that should've been
    debited already.

Edge cases handled:
  - Portal API unreachable (network/down): FAIL CLOSED if env says strict,
    FAIL OPEN if env says graceful. Default: fail open (don't block the
    user because OUR API is down).
  - Energy = exactly 1: allow (≥ MIN_ENERGY_TO_PROMPT default 1).
  - Cache stampede (many concurrent sends): single in-flight check per user,
    coalesced via asyncio.Future.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from dataclasses import dataclass
from typing import Optional

import httpx


log = logging.getLogger("bridge.energy_gate")


# Default minimum balance required to start a chat. 1 = block at zero.
DEFAULT_MIN_ENERGY = 1

# How long to cache a balance check (seconds).
# Longer = less load on portal API.
# Shorter = quicker reaction to top-ups and debits.
CACHE_TTL_S = 5.0

# Portal API timeout for the balance fetch (seconds).
# If we can't reach portal in this time, we apply STRICT vs GRACEFUL policy.
FETCH_TIMEOUT_S = 3.0


@dataclass
class _CachedBalance:
    balance: int
    fetched_at: float


class EnergyError(Exception):
    """Pre-flight check denied the request."""

    def __init__(self, code: str, message: str, balance: Optional[int] = None) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message
        self.balance = balance


class EnergyGate:
    """Pre-flight balance check against AgentBuff portal API."""

    def __init__(
        self,
        portal_base_url: str,
        bridge_token: str,
        *,
        user_id: Optional[str] = None,
        min_energy: int = DEFAULT_MIN_ENERGY,
        cache_ttl_s: float = CACHE_TTL_S,
        strict_on_portal_down: bool = False,
    ) -> None:
        """
        Args:
            portal_base_url: e.g. "http://host.docker.internal:617"
            bridge_token: same token used for WS auth; portal validates
                          and resolves user identity from this
            user_id: optional — portal may infer from token; if known we
                     include it as path param for clarity
            min_energy: minimum balance to allow a chat send (default 1)
            cache_ttl_s: how long to trust a fetched balance (default 5s)
            strict_on_portal_down: if True, refuse chat when portal API
                                    is unreachable. If False (default),
                                    allow chat (fail open).
        """
        self._portal_base_url = portal_base_url.rstrip("/")
        self._bridge_token = bridge_token
        self._user_id = user_id
        self._min_energy = min_energy
        self._cache_ttl = cache_ttl_s
        self._strict_on_portal_down = strict_on_portal_down

        self._cache: Optional[_CachedBalance] = None
        # Coalesce concurrent fetches (cache stampede defense)
        self._in_flight: Optional[asyncio.Future] = None
        self._lock = asyncio.Lock()

        # Reusable HTTP client (connection pooling)
        self._http_client: Optional[httpx.AsyncClient] = None

    async def __aenter__(self) -> "EnergyGate":
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

    async def check(self) -> int:
        """Ensure user has enough energy to make a request.

        Returns the current balance on success.
        Raises EnergyError("ENERGY_EXHAUSTED") if below threshold.
        Raises EnergyError("PORTAL_UNREACHABLE") if portal down AND strict.
        """
        balance = await self._get_balance()

        if balance < self._min_energy:
            raise EnergyError(
                "ENERGY_EXHAUSTED",
                f"Energy balance {balance} is below required {self._min_energy}. "
                "Please top up to continue.",
                balance=balance,
            )
        return balance

    def invalidate(self) -> None:
        """Clear the cache. Call after a debit so next check fetches fresh."""
        self._cache = None

    # -----------------------------------------------------------------
    # Internal: fetch from portal with cache + stampede prevention
    # -----------------------------------------------------------------

    async def _get_balance(self) -> int:
        # Fast path: cache hit
        now = time.monotonic()
        if self._cache and (now - self._cache.fetched_at) < self._cache_ttl:
            return self._cache.balance

        # Slow path: need to fetch. Coalesce concurrent callers so we
        # don't hammer the portal. Two roles:
        #   - leader: the coroutine that creates the in-flight future
        #     and actually performs the HTTP fetch.
        #   - follower: any other coroutine that arrived while a fetch
        #     was already underway; awaits the leader's future instead
        #     of issuing its own request.
        # We decide role under the lock, then drop the lock before
        # awaiting so other callers can pile on as followers.
        is_leader = False
        leader_future: asyncio.Future
        async with self._lock:
            # Re-check cache under lock (someone else may have fetched)
            now = time.monotonic()
            if self._cache and (now - self._cache.fetched_at) < self._cache_ttl:
                return self._cache.balance

            if self._in_flight and not self._in_flight.done():
                # A leader is already fetching — become follower.
                leader_future = self._in_flight
            else:
                # No leader — we are it. Create the future others will
                # piggyback on.
                self._in_flight = asyncio.get_running_loop().create_future()
                leader_future = self._in_flight
                is_leader = True

        if not is_leader:
            try:
                return await leader_future
            except Exception:
                # Leader failed; fall through and fetch ourselves so the
                # caller still gets a balance (or a clean error).
                pass

        # Leader path: do the fetch + publish result to followers.
        try:
            balance = await self._fetch_balance_now()
            self._cache = _CachedBalance(balance=balance, fetched_at=time.monotonic())
            if not leader_future.done():
                leader_future.set_result(balance)
            return balance
        except Exception as e:
            if not leader_future.done():
                leader_future.set_exception(e)
            raise

    async def _fetch_balance_now(self) -> int:
        """Make the actual HTTP call to portal."""
        if self._http_client is None:
            # Lazy init for the case where caller didn't use async context
            self._http_client = httpx.AsyncClient(
                timeout=httpx.Timeout(FETCH_TIMEOUT_S),
                headers={
                    "Authorization": f"Bearer {self._bridge_token}",
                    "User-Agent": "agentbuff-hermes-bridge/1.0",
                },
            )

        # URL — portal exposes GET /api/users/me/energy (authed by bridgeToken
        # which the portal resolves to a user via user_container row lookup)
        url = f"{self._portal_base_url}/api/users/me/energy"

        try:
            resp = await self._http_client.get(url)
        except (httpx.ConnectError, httpx.TimeoutException, httpx.NetworkError) as e:
            log.warning(
                "energy_gate: portal API unreachable (%s); strict=%s",
                e, self._strict_on_portal_down,
            )
            if self._strict_on_portal_down:
                raise EnergyError(
                    "PORTAL_UNREACHABLE",
                    f"Cannot verify energy balance: {e}",
                ) from e
            # Fail open: assume user has plenty of energy. Portal-side
            # usage poller will catch up on debits.
            return max(self._min_energy, 100)

        if resp.status_code == 401 or resp.status_code == 403:
            raise EnergyError(
                "UNAUTHORIZED",
                f"Portal rejected bridge token (status {resp.status_code})",
            )

        if resp.status_code != 200:
            log.warning(
                "energy_gate: portal returned unexpected status %s for energy lookup",
                resp.status_code,
            )
            if self._strict_on_portal_down:
                raise EnergyError(
                    "PORTAL_ERROR",
                    f"Portal energy API returned {resp.status_code}",
                )
            return max(self._min_energy, 100)

        try:
            body = resp.json()
        except ValueError:
            log.warning("energy_gate: portal returned non-JSON body")
            if self._strict_on_portal_down:
                raise EnergyError(
                    "PORTAL_ERROR",
                    "Portal energy API returned non-JSON body",
                )
            return max(self._min_energy, 100)

        # Expected shape: {"balance": int, "maxBalance": int, ...}
        balance = body.get("balance")
        if not isinstance(balance, int):
            log.warning("energy_gate: portal returned invalid balance value %r", balance)
            if self._strict_on_portal_down:
                raise EnergyError(
                    "PORTAL_ERROR",
                    "Portal energy API returned invalid balance value",
                )
            return max(self._min_energy, 100)

        return balance


def env_int(name: str, default: int) -> int:
    """Helper to read env var as int with fallback."""
    val = os.environ.get(name)
    if val is None or val == "":
        return default
    try:
        return int(val)
    except ValueError:
        log.warning("energy_gate: env %s=%r is not an int, using default %d", name, val, default)
        return default


def env_bool(name: str, default: bool) -> bool:
    """Helper to read env var as bool with fallback."""
    val = os.environ.get(name, "").strip().lower()
    if val in ("1", "true", "yes", "on"):
        return True
    if val in ("0", "false", "no", "off"):
        return False
    return default
