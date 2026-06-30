"""wa_pairing.py — per-agent WhatsApp QR pairing for AgentBuff.

WhatsApp needs a Node Baileys bridge per session that emits a QR. The Hermes
pip wheel ships NO bridge.js, so AgentBuff bakes its own at
/app/bridge/whatsapp-bridge/bridge.js (extended to return the raw QR string via
/health). This module drives pairing via two RPCs the /app UI already calls:

  web.login.start({channel:"whatsapp", agentId|accountId, force?}):
    - per-account session_path + port (matches adapter_whatsapp.py derivation)
    - already paired (creds.json) → {alreadyPaired, connected}
    - else start the Node bridge (HTTP mode) + poll /health for the QR →
      render SVG data URL → {qrDataUrl}
  web.login.wait({channel:"whatsapp", agentId|accountId}):
    - poll /health until status=="connected" (scan succeeded, creds saved)
    - stop the pairing bridge, then channels.pair("whatsapp", account_id, agent_id)
      → writes platforms.whatsapp__<acct> + enables plugin + restarts gateway →
      the per-agent WA adapter connects with the saved creds.

Per-account WA = one Node+Baileys subprocess (~100-200 MB each).
"""

from __future__ import annotations

import asyncio
import base64
import io
import json as _json
import logging
import os
import re
import signal
import subprocess
import time
import urllib.request
from pathlib import Path
from typing import Optional

log = logging.getLogger("bridge.wa_pairing")

_WA_BRIDGE_SCRIPT = os.environ.get(
    "WA_BRIDGE_SCRIPT", "/app/bridge/whatsapp-bridge/bridge.js"
)
_WA_PORT_BASE = 34000
_WA_PORT_SPAN = 1000

# account_id slug — mirror channels_handler._ACCOUNT_ID_RE
_ACCOUNT_ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,38}[a-z0-9]$|^[a-z0-9]$")

# Reuse the engine's port-kill helper if importable (best-effort).
try:
    from gateway.platforms.whatsapp import _kill_port_process as _kill_port  # type: ignore
except Exception:  # pragma: no cover
    def _kill_port(port: int) -> None:  # type: ignore
        return None


def _hermes_home() -> Path:
    h = os.environ.get("HERMES_HOME")
    return Path(h) if h else (Path.home() / ".hermes")


def _derive_port(account_id: str) -> int:
    """Stable per-account port — MUST match adapter_whatsapp._derive_port."""
    h = 0
    for ch in account_id:
        h = (h * 31 + ord(ch)) & 0xFFFFFFFF
    return _WA_PORT_BASE + (h % _WA_PORT_SPAN)


def _session_path(account_id: str) -> Path:
    return _hermes_home() / "wa-sessions" / account_id


def _qr_to_data_url(qr_string: str) -> str:
    """Render a raw Baileys QR string to an SVG data URL (no Pillow needed)."""
    import qrcode
    import qrcode.image.svg

    img = qrcode.make(
        qr_string, image_factory=qrcode.image.svg.SvgImage, box_size=10, border=2
    )
    buf = io.BytesIO()
    img.save(buf)
    svg = buf.getvalue().decode("utf-8")
    return "data:image/svg+xml;base64," + base64.b64encode(
        svg.encode("utf-8")
    ).decode("ascii")


def _http_get_json(port: int, path: str, timeout: float = 3.0) -> Optional[dict]:
    try:
        with urllib.request.urlopen(
            f"http://127.0.0.1:{port}{path}", timeout=timeout
        ) as r:
            return _json.loads(r.read().decode("utf-8"))
    except Exception:
        return None


class WaPairingError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


class WaPairingManager:
    """Owns the short-lived per-account Node bridge used during QR pairing."""

    def __init__(self, config_handler, channels_handler) -> None:
        self._config = config_handler
        self._channels = channels_handler
        self._procs: dict[str, subprocess.Popen] = {}

    def _resolve_account(
        self, account_id: Optional[str], agent_id: Optional[str]
    ) -> str:
        acct = account_id or agent_id or "default"
        acct = str(acct).strip().lower()
        if acct in ("", "default"):
            # The default agent's WhatsApp is the native single-account
            # channels.whatsapp path, not a synthetic per-agent platform.
            raise WaPairingError(
                "INVALID_REQUEST",
                "WhatsApp per-agen butuh agen bernama (bukan agen default)",
            )
        if not _ACCOUNT_ID_RE.match(acct):
            raise WaPairingError("INVALID_REQUEST", f"account_id tidak valid: {acct}")
        return acct

    async def start(
        self,
        *,
        account_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        force: bool = False,
    ) -> dict:
        acct = self._resolve_account(account_id, agent_id)
        sp = _session_path(acct)
        sp.mkdir(parents=True, exist_ok=True)
        port = _derive_port(acct)
        creds = sp / "creds.json"

        if creds.exists() and not force:
            return {"alreadyPaired": True, "connected": True, "accountId": acct}
        if force and creds.exists():
            try:
                creds.unlink()
            except OSError:
                pass

        # Clean any prior pairing bridge for this account + free the port.
        self._stop(acct)
        await asyncio.to_thread(_kill_port, port)

        log_path = sp.parent / f"pair-{acct}.log"
        log_fh = open(log_path, "a", encoding="utf-8")
        env = {**os.environ, "WHATSAPP_REPLY_PREFIX": "", "WHATSAPP_MODE": "bot"}
        try:
            proc = subprocess.Popen(
                [
                    "node", _WA_BRIDGE_SCRIPT,
                    "--port", str(port),
                    "--session", str(sp),
                    "--mode", "bot",
                ],
                stdout=log_fh, stderr=log_fh,
                start_new_session=True,
                env=env,
            )
        except FileNotFoundError:
            raise WaPairingError("NODE_MISSING", "Node.js tidak tersedia di container")
        self._procs[acct] = proc
        log.info("wa_pairing[%s]: bridge started pid=%s port=%s", acct, proc.pid, port)

        deadline = time.monotonic() + 45
        while time.monotonic() < deadline:
            await asyncio.sleep(1.5)
            if proc.poll() is not None:
                raise WaPairingError(
                    "BRIDGE_DIED",
                    f"WhatsApp bridge berhenti (cek {log_path})",
                )
            data = await asyncio.to_thread(_http_get_json, port, "/health")
            if not data:
                continue
            if data.get("status") == "connected":
                return {"connected": True, "accountId": acct}
            qr = data.get("qr")
            if qr:
                return {"qrDataUrl": _qr_to_data_url(qr), "accountId": acct}

        self._stop(acct)
        raise WaPairingError("QR_TIMEOUT", "QR WhatsApp tidak muncul (timeout)")

    async def wait(
        self,
        *,
        account_id: Optional[str] = None,
        agent_id: Optional[str] = None,
        timeout: float = 150,
        allow_from: Optional[list] = None,
    ) -> dict:
        acct = self._resolve_account(account_id, agent_id)
        agent = str(agent_id or acct).strip().lower()
        port = _derive_port(acct)

        deadline = time.monotonic() + timeout
        connected = False
        while time.monotonic() < deadline:
            await asyncio.sleep(2)
            data = await asyncio.to_thread(_http_get_json, port, "/health")
            if data and data.get("status") == "connected":
                connected = True
                break
            proc = self._procs.get(acct)
            if proc is not None and proc.poll() is not None:
                break  # bridge died before scan

        if not connected:
            return {
                "connected": False,
                "message": "WhatsApp belum di-scan atau timeout. Coba generate QR lagi.",
            }

        # Creds saved. Let Baileys flush, stop the pairing bridge so the gateway
        # adapter can own its own bridge on the same port, then write the
        # synthetic platform config + restart the gateway.
        await asyncio.sleep(2)
        self._stop(acct)
        await asyncio.to_thread(_kill_port, port)
        # The runtime WA bridge reads WHATSAPP_MODE + WHATSAPP_ALLOWED_USERS from
        # env. Default "self-chat" ignores everyone → force bot mode. The
        # allowlist is the access gate: caller passes the numbers the user chose
        # (or ["*"] for an open bot). We NO LONGER hardcode "*" — a WA bot is
        # only world-open if the user explicitly picked "Semua orang".
        # NOTE: WHATSAPP_ALLOWED_USERS is container-GLOBAL (the Baileys bridge
        # reads one env for all accounts), so this sets the gate for every WA
        # number in this container.
        try:
            from channels_handler import _write_env_values, _normalize_allow_list
            allow_csv = _normalize_allow_list(
                allow_from if isinstance(allow_from, list) else ["*"]
            )
            _write_env_values(
                {"WHATSAPP_MODE": "bot", "WHATSAPP_ALLOWED_USERS": allow_csv}
            )
        except Exception:
            log.exception("wa_pairing: failed to set WA bot-mode env")
        await self._channels.pair(
            "whatsapp", {}, account_id=acct, agent_id=agent
        )
        log.info("wa_pairing[%s]: paired → agent=%s, synthetic config written", acct, agent)
        return {"connected": True, "accountId": acct, "agentId": agent}

    def _stop(self, account_id: str) -> None:
        proc = self._procs.pop(account_id, None)
        if proc is None or proc.poll() is not None:
            return
        try:
            os.killpg(os.getpgid(proc.pid), signal.SIGTERM)
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass

    def shutdown(self) -> None:
        for acct in list(self._procs.keys()):
            self._stop(acct)
