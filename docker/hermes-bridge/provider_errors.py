"""provider_errors.py — turn raw LLM-provider failures into clear, layperson
Bahasa Indonesia messages for /app + channels.

WHY THIS EXISTS
  The engine (`gateway/run.py::_gateway_provider_error_reply`) collapses every
  provider failure into ONE of four short English templates and THROWS AWAY the
  raw detail ("I kept the raw provider error out of chat"). Worst of all, a
  *billing/credit-exhausted* failure (Gemini HTTP 429 RESOURCE_EXHAUSTED
  "prepayment credits are depleted") matches the same 429/quota regex as a real
  *rate-limit*, so the user is told "rate-limiting requests, please wait" when
  the real fix is "top up / swap your API key". Confusing for a mass-market,
  non-technical Chief.

HOW
  The bridge already tails the engine's stderr (hermes_client._stderr_logger),
  where the FULL raw error IS present. We capture those raw lines into a short
  ring buffer here, then — when a final chat reply / error event comes through
  the translator — classify using the most recent raw error (preferred) or the
  engine's friendly template as a fallback, and emit a specific Bahasa message
  with a concrete next step. Engine source is NOT modified; this is a
  display-layer remap at the bridge boundary.
"""

from __future__ import annotations

import re
import time
from typing import Optional, Tuple

# ---------------------------------------------------------------------------
# Raw-error ring buffer (fed from hermes_client stderr; read by translator)
# ---------------------------------------------------------------------------

# Markers that make a stderr line worth remembering as a provider failure.
_PROVIDER_ERR_MARKERS = re.compile(
    r"RESOURCE_EXHAUSTED"
    r"|prepayment\s+credits"
    r"|credits?\s+are\s+depleted"
    r"|insufficient\s+(?:credit|balance|funds|quota)"
    r"|\bquota\b"
    r"|\bbilling\b"
    r"|\bHTTP\s*(?:4\d\d|5\d\d)\b"
    r"|\b(?:4\d\d|5\d\d)\b\s*(?:error|status)?"
    r"|invalid[\s_-]?api[\s_-]?key"
    r"|api\s+key\s+not\s+valid"
    r"|incorrect\s+api\s+key"
    r"|permission[\s_-]?denied"
    r"|unauthorized"
    r"|rate[\s_-]?limit"
    r"|overloaded"
    r"|model\s+not\s+found"
    r"|safety|blocked|content\s+policy",
    re.IGNORECASE,
)

_RECENT: list[Tuple[float, str]] = []  # (monotonic_ts, raw_line)
_MAX_KEEP = 20
_MAX_AGE_S = 120.0


def record(line: str) -> None:
    """Remember a raw provider-error stderr line (called per stderr line)."""
    try:
        if not line or not isinstance(line, str):
            return
        if not _PROVIDER_ERR_MARKERS.search(line):
            return
        ts = time.monotonic()
        _RECENT.append((ts, line.strip()[:700]))
        cutoff = ts - _MAX_AGE_S
        while _RECENT and (_RECENT[0][0] < cutoff or len(_RECENT) > _MAX_KEEP):
            _RECENT.pop(0)
    except Exception:
        pass


def recent(within_seconds: float = 90.0) -> Optional[str]:
    """Most recent raw provider error within the window, else None."""
    try:
        if not _RECENT:
            return None
        now = time.monotonic()
        for ts, line in reversed(_RECENT):
            if now - ts <= within_seconds:
                return line
        return None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Classification → layperson Bahasa Indonesia message
# ---------------------------------------------------------------------------

# Ordered MOST-SPECIFIC first. Each entry: (compiled regex, kind, message).
# Messages are deliberately plain + actionable, point at /app Pengaturan.
_LADDER: list[Tuple[re.Pattern, str, str]] = [
    (
        re.compile(
            r"prepayment\s+credits|credits?\s+are\s+depleted"
            r"|insufficient\s+(?:credit|balance|funds)"
            r"|\bbilling\b|payment\s+required|\b402\b",
            re.IGNORECASE,
        ),
        "billing_depleted",
        "💳 Saldo/kredit API model kamu habis. Isi ulang (top up) billing di "
        "penyedianya, atau ganti API key/model lewat Pengaturan → Penyedia. "
        "Ini bukan rate-limit — nunggu nggak akan menyelesaikan.",
    ),
    (
        re.compile(
            r"daily\s+limit|per\s+day|free[\s_-]?tier"
            r"|quota.*exceed|exceed.*quota|usage\s+limit|RESOURCE_EXHAUSTED",
            re.IGNORECASE,
        ),
        "quota_exhausted",
        "📊 Kuota model habis (kemungkinan batas harian / free-tier). Tunggu "
        "kuota reset, atau ganti API key/model di Pengaturan → Penyedia.",
    ),
    (
        re.compile(
            r"invalid[\s_-]?api[\s_-]?key|api\s+key\s+not\s+valid"
            r"|incorrect\s+api\s+key|authentication\s+failed"
            r"|unauthorized|permission[\s_-]?denied|\b401\b|\b403\b",
            re.IGNORECASE,
        ),
        "auth",
        "🔑 API key model tidak valid atau belum diatur. Periksa / ganti key "
        "di Pengaturan → Penyedia.",
    ),
    (
        re.compile(
            r"rate[\s_-]?limit|too\s+many\s+request|per\s+minute|\bRPM\b"
            r"|requests?\s+per|\b429\b",
            re.IGNORECASE,
        ),
        "rate_limit",
        "🚦 Model lagi kebanyakan permintaan dalam waktu singkat. Tunggu "
        "beberapa detik, lalu coba lagi. Kalau sering kejadian, ganti model "
        "atau key di Pengaturan → Penyedia.",
    ),
    (
        re.compile(
            r"safety|blocked|content\s+policy|prohibited"
            r"|rejected\s+the\s+request|policy",
            re.IGNORECASE,
        ),
        "policy",
        "🛡️ Permintaan ditolak kebijakan keamanan model. Coba ubah kalimatnya, "
        "atau ganti model di Pengaturan → Penyedia.",
    ),
    (
        re.compile(
            r"model\s+not\s+found|no\s+such\s+model|unknown\s+model"
            r"|model.*not\s+available|\b404\b",
            re.IGNORECASE,
        ),
        "model_not_found",
        "🔍 Model yang dipilih tidak tersedia. Pilih model lain di "
        "Pengaturan → Penyedia.",
    ),
    (
        re.compile(
            r"overloaded|\b503\b|\b502\b|\b500\b|service\s+unavailable"
            r"|server\s+error|temporarily\s+unavailable",
            re.IGNORECASE,
        ),
        "overloaded",
        "🛠️ Server model lagi gangguan / overload. Coba lagi sebentar.",
    ),
    (
        re.compile(
            r"timed?\s*out|timeout|connection|network|unreachable|dns",
            re.IGNORECASE,
        ),
        "network",
        "🌐 Koneksi ke model bermasalah / timeout. Cek jaringan lalu coba lagi.",
    ),
]

_GENERIC = (
    "generic",
    "⚠️ Model gagal merespons setelah beberapa percobaan. Coba lagi sebentar, "
    "atau ganti API key/model di Pengaturan → Penyedia.",
)

# Does a short text look like the engine's own provider-error reply (so we
# should remap it)?  Mirrors gateway/run.py templates + envelope shapes.
_ENGINE_ERR_REPLY = re.compile(
    r"the\s+model\s+provider\s+(is\s+rate-limiting|rejected\s+the\s+request|failed\s+after\s+retries)"
    r"|provider\s+authentication\s+failed"
    r"|rate[\s_-]?limited\s+after\s+\d+\s+retries"
    r"|api\s+(?:call\s+)?failed"
    r"|max\s+retries",
    re.IGNORECASE,
)


def classify(text: str) -> Tuple[str, str]:
    """Map a raw/friendly provider-error string → (kind, Bahasa message)."""
    if not text or not isinstance(text, str):
        return _GENERIC
    for pattern, kind, message in _LADDER:
        if pattern.search(text):
            return kind, message
    return _GENERIC


def looks_like_engine_error_reply(text: str) -> bool:
    """True when a short final reply is actually one of the engine's provider
    -error templates (so it should be remapped, not shown as the agent's prose).
    Length-guarded so a long assistant answer that merely mentions an HTTP code
    isn't mistaken for an error envelope."""
    if not text or not isinstance(text, str):
        return False
    body = text.strip()
    if len(body) > 400 or body.count("\n") > 5:
        return False
    return bool(_ENGINE_ERR_REPLY.search(body))


def localize(friendly_text: Optional[str], *, within_seconds: float = 90.0) -> str:
    """Produce a layperson Bahasa message for a provider failure.

    Prefers the most recent RAW stderr error (carries the real cause, e.g.
    credit-depleted vs throttle) and falls back to the engine's friendly
    template text when no raw error is buffered."""
    raw = recent(within_seconds)
    source = raw or (friendly_text or "")
    _, message = classify(source)
    return message
