"""adapter_email.py — per-account synthetic Email adapter.

The native Hermes EmailAdapter reads its credentials from ENV
(EMAIL_ADDRESS / EMAIL_PASSWORD / EMAIL_IMAP_HOST / EMAIL_SMTP_HOST / ...), so
the generic native-wrap (which only injects config.extra) can't make it
per-account. This bespoke subclass calls super().__init__ (which seeds env
defaults) and then OVERRIDES the cred attributes from THIS account's
config.extra block, and sets self.platform to the synthetic name so N email
accounts coexist in one process — each polling its OWN mailbox over IMAP and
routed to its OWN agent via extra.agent_id.

Outbound only: IMAP (receive) + SMTP (send) are connections the container makes
OUT to the mail server. NO public webhook ingress required — works on a
loopback-only container, unlike LINE/SMS/Meta (which need a public URL).

Field names in config.extra (written by the bridge SYNTHETIC_CRED_MAP):
    email_address, email_password, imap_host, imap_port, smtp_host, smtp_port
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from .account_config import (
    parse_synthetic_name,
    read_account_extra,
    resolve_agent_id,
)

logger = logging.getLogger("agentbuff.multichannel.email")


def check_requirements() -> tuple[bool, str]:
    """Email uses only the Python stdlib (imaplib/smtplib) + the native adapter."""
    try:
        import imaplib  # noqa: F401
        import smtplib  # noqa: F401
        from gateway.platforms.email import EmailAdapter  # noqa: F401

        return True, ""
    except Exception as e:  # noqa: BLE001
        return False, f"email adapter unavailable: {e}"


def validate_config(extra: dict) -> Optional[str]:
    """Return an error string if the per-account email config is incomplete."""
    extra = extra or {}

    def _has(*keys: str) -> bool:
        return any(
            isinstance(extra.get(k), str) and extra.get(k, "").strip() for k in keys
        )

    missing = []
    if not _has("email_address", "address"):
        missing.append("email_address")
    if not _has("email_password", "password"):
        missing.append("email_password")
    if not _has("imap_host"):
        missing.append("imap_host")
    if not _has("smtp_host"):
        missing.append("smtp_host")
    if missing:
        return f"email: missing {', '.join(missing)}"
    return None


def _make_email_account_adapter():
    """Build the per-account Email adapter class. Raises if the native module is
    missing (caller guards with try/except → channel simply doesn't register)."""
    from gateway.config import Platform
    from gateway.platforms.email import EmailAdapter

    class EmailAccountAdapter(EmailAdapter):  # type: ignore[valid-type, misc]
        base_label = "Email"

        def __init__(self, config: Any):
            extra = read_account_extra(config)
            synthetic = extra.get("synthetic_name") or extra.get("platform_name")
            identity = parse_synthetic_name(synthetic) if synthetic else None
            if identity is None:
                raise ValueError(
                    f"email account adapter: invalid/missing synthetic name "
                    f"{synthetic!r} (extra keys: {list(extra.keys())})"
                )

            # Native __init__ seeds creds from ENV. We override per-account below.
            super().__init__(config)

            def _g(*keys: str) -> Optional[str]:
                for k in keys:
                    v = extra.get(k)
                    if isinstance(v, str) and v.strip():
                        return v.strip()
                return None

            self._address = _g("email_address", "address") or self._address
            self._password = _g("email_password", "password") or self._password
            self._imap_host = _g("imap_host") or self._imap_host
            self._smtp_host = _g("smtp_host") or self._smtp_host
            ip = _g("imap_port")
            if ip and ip.isdigit():
                self._imap_port = int(ip)
            sp = _g("smtp_port")
            if sp and sp.isdigit():
                self._smtp_port = int(sp)

            try:
                self.platform = Platform(synthetic)
            except Exception:  # noqa: BLE001
                logger.warning("email: could not set synthetic platform %s", synthetic)

            self.identity = identity
            self.account_extra = extra
            self.agent_id = resolve_agent_id(config, fallback="default")
            logger.info(
                "email account adapter: %s → agent=%s (%s@%s)",
                synthetic, self.agent_id, self._address, self._imap_host,
            )

    return EmailAccountAdapter


# Public symbol used by __init__._register_builtin_channels (lazy-built so a
# missing native module doesn't crash plugin import).
try:
    EmailAccountAdapter = _make_email_account_adapter()
except Exception as _e:  # noqa: BLE001
    EmailAccountAdapter = None  # type: ignore[assignment]
    logger.warning("email adapter class unavailable at import: %s", _e)
