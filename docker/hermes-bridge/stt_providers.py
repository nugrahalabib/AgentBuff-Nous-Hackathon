"""
stt_providers.py — Universal STT provider registry for the AgentBuff bridge.

This is a self-contained port of OpenClaw's media-understanding STT pipeline
(`Reff/.archive-openclaw-2026-05-21/src/media-understanding/`), purpose-built
to survive Hermes upgrades. Hermes' own `tools.transcription_tools` is
intentionally NOT imported — that path changes between Hermes versions and
would silently break our STT chain on a future bump. The bridge owns its
STT registry end-to-end so the user's voice notes keep working no matter
what Hermes does upstream.

Architecture mirrors OpenClaw's pattern (verified at
`media-understanding/bundled-defaults.ts` + `resolve.ts:134`):

  1. **Active-chat-model fallback** — read the user's currently-active
     chat provider from `~/.hermes/config.yaml::model.default` and try
     transcribing with THAT provider first. Why: AgentBuff users already
     pay for whatever LLM is configured (Gemini / Claude / OpenAI / etc.),
     so re-using its API key for STT means "voice works out of the box."

  2. **Auto-priority chain** — when active model can't help (no key /
     provider not in registry / capability mismatch), walk a priority-
     sorted list of providers that have credentials present:
        openai (10) → groq (20) → deepgram (30) → gemini/google (40)
        → mistral (50) → xai (60) → anthropic (70)
     Lower number = tried first. Matches the priorities OpenClaw shipped.

  3. **Provider implementations**:
       - **OpenAI-compatible audio** (POST /audio/transcriptions, multipart)
         covers openai, groq, mistral, xai, and any custom endpoint that
         implements the same shape. One function, four registrations.
       - **Gemini native** (POST generativelanguage.googleapis.com/...
         generateContent with inline_data audio) — Google's multimodal
         endpoint; transcribes verbatim with a deterministic prompt.
       - **Deepgram** (POST /v1/listen, raw audio bytes) — different
         request/response shape than OpenAI compat.
       - **Anthropic native** — Claude's Messages API does NOT yet
         accept inline audio (as of 2026-05); we register the provider
         entry but its `transcribe` is a stub that returns "Claude does
         not support audio input" so the chain skips it cleanly.

  4. **No new dependencies** — uses `httpx` (already in
     `requirements.txt`) for all HTTP traffic. Reads `~/.hermes/.env`
     directly (simple `key=value` lines) so we don't depend on
     `hermes_cli.config.get_env_value`.

  5. **Failure handling** — each provider returns `(text, error)`:
       - `(text, None)` on success.
       - `(None, "no_api_key")` if the provider's key env vars are unset.
         Caller treats this as "skip this provider, try next" — not a
         fatal failure.
       - `(None, "<message>")` on any other failure (HTTP error, parse
         error, network blip). Caller logs + tries next provider.
       - `("", None)` for silent audio (transcribed but no words spoken).
         Caller can surface a "you sent a silent VN" note.
"""

from __future__ import annotations

import base64
import io
import json
import logging
import os
import re
from pathlib import Path
from typing import Callable, Optional

import httpx

log = logging.getLogger("bridge.stt_providers")

# Default per-provider STT models. Mirrors OpenClaw's
# `BUNDLED_MEDIA_PROVIDER_DEFAULTS[…].defaultModels.audio` table.
DEFAULT_MODELS = {
    "openai": "gpt-4o-transcribe",
    "groq": "whisper-large-v3-turbo",
    "gemini": "gemini-2.5-flash",
    "google": "gemini-2.5-flash",  # alias
    "deepgram": "nova-3",
    "mistral": "voxtral-mini-latest",
    "xai": "grok-3-stt",
    "anthropic": None,  # no audio support — placeholder
}

# Priority for the auto-fallback chain (lower = tried first). Mirrors
# OpenClaw's `autoPriority.audio` field. Tied priorities resolve by
# alphabetical provider id (matches OpenClaw's
# `bundled-defaults.ts:96-101`).
AUTO_PRIORITY = {
    "openai": 10,
    "groq": 20,
    "deepgram": 30,
    "gemini": 40,
    "google": 40,
    "mistral": 50,
    "xai": 60,
    "anthropic": 70,
}

# Provider-specific HTTP defaults — mostly OpenAI-compatible base URLs.
PROVIDER_BASE_URLS = {
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "mistral": "https://api.mistral.ai/v1",
    "xai": "https://api.x.ai/v1",
    "deepgram": "https://api.deepgram.com/v1",
    "gemini": "https://generativelanguage.googleapis.com/v1beta",
    "google": "https://generativelanguage.googleapis.com/v1beta",
    "anthropic": "https://api.anthropic.com/v1",
}

# Where each provider's API key can be read from. Listed in priority
# order — first non-empty env var wins. The values lowercased here match
# what `hermes_cli/config.py:1786-1820` documents.
PROVIDER_KEY_ENV_VARS = {
    "openai": ("OPENAI_API_KEY",),
    "groq": ("GROQ_API_KEY",),
    "deepgram": ("DEEPGRAM_API_KEY",),
    "gemini": ("GEMINI_API_KEY", "GOOGLE_API_KEY", "HERMES_DEFAULT_GEMINI_KEY"),
    "google": ("GOOGLE_API_KEY", "GEMINI_API_KEY", "HERMES_DEFAULT_GEMINI_KEY"),
    "mistral": ("MISTRAL_API_KEY",),
    "xai": ("XAI_API_KEY", "GROK_API_KEY"),
    "anthropic": ("ANTHROPIC_API_KEY",),
}

# Gemini accepts a specific set of audio MIME types — map our incoming
# variants to what Gemini's API expects. See
# https://ai.google.dev/gemini-api/docs/audio.
_GEMINI_AUDIO_MIME_MAP = {
    "audio/mp3": "audio/mp3",
    "audio/mpeg": "audio/mp3",
    "audio/ogg": "audio/ogg",
    "audio/opus": "audio/ogg",
    "audio/oga": "audio/ogg",
    "audio/wav": "audio/wav",
    "audio/x-wav": "audio/wav",
    "audio/wave": "audio/wav",
    "audio/x-m4a": "audio/aac",
    "audio/mp4": "audio/aac",
    "audio/aac": "audio/aac",
    "audio/webm": "audio/webm",
    "audio/flac": "audio/flac",
}

# OpenAI-compatible endpoints accept these audio MIME types directly.
# Used as the multipart file's content-type. Unmapped MIMEs are forwarded
# as-is; if the provider rejects them, the (None, error) path kicks in.
_OPENAI_AUDIO_FILENAMES = {
    "audio/mp3": "audio.mp3",
    "audio/mpeg": "audio.mp3",
    "audio/ogg": "audio.ogg",
    "audio/opus": "audio.ogg",
    "audio/wav": "audio.wav",
    "audio/x-wav": "audio.wav",
    "audio/wave": "audio.wav",
    "audio/x-m4a": "audio.m4a",  # OpenAI rejects .aac; .m4a wraps AAC
    "audio/mp4": "audio.m4a",
    "audio/aac": "audio.m4a",
    "audio/webm": "audio.webm",
    "audio/flac": "audio.flac",
}


# ──────────────────────────────────────────────────────────────────────
# Env var resolution — self-contained, no Hermes imports
# ──────────────────────────────────────────────────────────────────────


def _load_dot_env_file() -> dict[str, str]:
    """Read `~/.hermes/.env` (key=value lines) into a dict. Cached after
    first call — the bridge is long-running and the .env rarely changes
    mid-run; on changes the user typically restarts the gateway anyway.

    Format is the same one `hermes_cli/config.py::load_env` parses —
    simple `KEY=VALUE` lines, optional quotes, `#` comments. We DON'T
    import the Hermes parser (Hermes-update-resilience), so we re-do
    a minimal version here. Quotes ('...' / "...") are stripped if they
    bracket the entire value, matching dotenv conventions.
    """
    cached = getattr(_load_dot_env_file, "_cache", None)
    if cached is not None:
        return cached  # type: ignore[return-value]

    out: dict[str, str] = {}
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    env_path = Path(home) / ".env"
    try:
        if env_path.is_file():
            for raw in env_path.read_text(encoding="utf-8", errors="replace").splitlines():
                line = raw.strip()
                if not line or line.startswith("#"):
                    continue
                if "=" not in line:
                    continue
                key, _, value = line.partition("=")
                key = key.strip()
                if not key:
                    continue
                value = value.strip()
                # Strip a leading `export ` if present (bash convention).
                if key.startswith("export "):
                    key = key[len("export "):].strip()
                # Strip matching outer quotes.
                if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
                    value = value[1:-1]
                out[key] = value
    except Exception as exc:
        log.warning("failed to read %s: %s", env_path, exc)

    setattr(_load_dot_env_file, "_cache", out)
    return out


def invalidate_env_cache() -> None:
    """Drop the .env cache. Bridge can call this on `config.patch` or
    similar events that rewrite the file."""
    if hasattr(_load_dot_env_file, "_cache"):
        delattr(_load_dot_env_file, "_cache")


def _resolve_env_value(*var_names: str) -> Optional[str]:
    """Resolve the first non-empty value among the env vars, then fall
    back to the same names in `~/.hermes/.env`. Mirrors what Hermes'
    own `hermes_cli.config.get_env_value` does but doesn't import it."""
    for name in var_names:
        v = os.environ.get(name)
        if v and v.strip():
            return v.strip()
    dot_env = _load_dot_env_file()
    for name in var_names:
        v = dot_env.get(name)
        if v and v.strip():
            return v.strip()
    return None


def get_provider_api_key(provider_id: str) -> Optional[str]:
    """Return the API key for a provider, or None if unconfigured."""
    pid = provider_id.lower().strip()
    var_names = PROVIDER_KEY_ENV_VARS.get(pid)
    if not var_names:
        return None
    return _resolve_env_value(*var_names)


# ──────────────────────────────────────────────────────────────────────
# Active-chat-model resolution
# ──────────────────────────────────────────────────────────────────────


_ACTIVE_PROVIDER_ALIASES = {
    # config.yaml `model.default` is "provider/model"; the prefix maps to
    # our provider id. We normalize known aliases so e.g. "google" and
    # "gemini" both route through the Gemini path.
    "google": "google",
    "gemini": "gemini",
    "openai": "openai",
    "anthropic": "anthropic",
    "claude": "anthropic",
    "groq": "groq",
    "deepgram": "deepgram",
    "mistral": "mistral",
    "xai": "xai",
    "grok": "xai",
    # Aggregator gateways that wrap many model providers — pick a
    # reasonable STT target rather than punting. Their API keys typically
    # work against OpenAI-compatible /audio/transcriptions paths.
    "openrouter": "openai",
    "kilocode": "openai",
    "ai-gateway": "openai",
}


def get_active_chat_provider() -> Optional[str]:
    """Read `~/.hermes/config.yaml::model.default` and extract the
    provider prefix (e.g. `"anthropic/claude-opus-4.6"` → `"anthropic"`).

    Returns the normalized provider id (lowercased, aliased through
    `_ACTIVE_PROVIDER_ALIASES`) or None on any failure / no prefix.
    """
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    cfg_path = Path(home) / "config.yaml"
    if not cfg_path.is_file():
        return None
    try:
        text = cfg_path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return None

    # Minimal YAML scan — we don't want to depend on PyYAML being
    # available (it IS in requirements.txt, but the parser handles
    # weirdly-formatted user-edited configs and we want to be tolerant
    # of any layout). Look for `model:` block, then `default:` or
    # `model:` field within it.
    match = re.search(
        r"^model\s*:\s*\n((?:\s+.+\n?)+)",
        text,
        flags=re.MULTILINE,
    )
    if not match:
        # Inline form: `model: foo/bar`
        inline = re.search(r"^model\s*:\s*['\"]?([^'\"\n#]+)['\"]?", text, flags=re.MULTILINE)
        if not inline:
            return None
        candidate = inline.group(1).strip()
    else:
        block = match.group(1)
        sub = re.search(
            r"^\s+(?:default|model)\s*:\s*['\"]?([^'\"\n#]+)['\"]?",
            block,
            flags=re.MULTILINE,
        )
        if not sub:
            return None
        candidate = sub.group(1).strip()

    if "/" not in candidate:
        return None
    prefix = candidate.split("/", 1)[0].strip().lower()
    return _ACTIVE_PROVIDER_ALIASES.get(prefix)


# ──────────────────────────────────────────────────────────────────────
# Provider implementations
# ──────────────────────────────────────────────────────────────────────


def _http_timeout(read_seconds: float = 60.0) -> httpx.Timeout:
    return httpx.Timeout(
        connect=10.0,
        read=read_seconds,
        write=read_seconds,
        pool=10.0,
    )


def _transcribe_openai_compatible(
    provider_id: str,
    audio_bytes: bytes,
    mime: str,
    *,
    model: Optional[str] = None,
    base_url_override: Optional[str] = None,
) -> tuple[Optional[str], Optional[str]]:
    """POST multipart to `<base_url>/audio/transcriptions`. Handles OpenAI,
    Groq, Mistral, xAI, and any other provider that ships the same shape.

    Returns (transcript, error). Transcript may be `""` (silent audio
    is valid). `error="no_api_key"` is a sentinel; caller should treat
    that as "skip + try next" rather than "report to user."
    """
    api_key = get_provider_api_key(provider_id)
    if not api_key:
        return (None, "no_api_key")

    base_url = (
        base_url_override
        or os.environ.get(f"{provider_id.upper()}_BASE_URL")
        or PROVIDER_BASE_URLS.get(provider_id)
    )
    if not base_url:
        return (None, f"no base_url configured for {provider_id}")

    resolved_model = model or DEFAULT_MODELS.get(provider_id) or "whisper-1"
    url = f"{base_url.rstrip('/')}/audio/transcriptions"
    canon_mime = (mime or "").lower() or "audio/ogg"
    filename = _OPENAI_AUDIO_FILENAMES.get(canon_mime, "audio.ogg")

    try:
        files = {
            "file": (filename, io.BytesIO(audio_bytes), canon_mime),
        }
        data = {"model": resolved_model}
        with httpx.Client(timeout=_http_timeout()) as client:
            resp = client.post(
                url,
                headers={"Authorization": f"Bearer {api_key}"},
                files=files,
                data=data,
            )
            if resp.status_code != 200:
                err = f"HTTP {resp.status_code}: {resp.text[:200]}"
                log.warning("STT %s failed: %s", provider_id, err)
                return (None, err)
            payload = resp.json()
        # OpenAI / Groq / Mistral / xAI all return { "text": "..." }
        text = (payload.get("text") or "").strip()
        return (text, None)
    except Exception as exc:
        msg = f"{type(exc).__name__}: {exc}"
        log.warning("STT %s exception: %s", provider_id, msg, exc_info=True)
        return (None, msg)


def transcribe_via_openai(
    audio_bytes: bytes, mime: str, **kw
) -> tuple[Optional[str], Optional[str]]:
    return _transcribe_openai_compatible("openai", audio_bytes, mime, **kw)


def transcribe_via_groq(
    audio_bytes: bytes, mime: str, **kw
) -> tuple[Optional[str], Optional[str]]:
    return _transcribe_openai_compatible("groq", audio_bytes, mime, **kw)


def transcribe_via_mistral(
    audio_bytes: bytes, mime: str, **kw
) -> tuple[Optional[str], Optional[str]]:
    return _transcribe_openai_compatible("mistral", audio_bytes, mime, **kw)


def transcribe_via_xai(
    audio_bytes: bytes, mime: str, **kw
) -> tuple[Optional[str], Optional[str]]:
    return _transcribe_openai_compatible("xai", audio_bytes, mime, **kw)


def transcribe_via_gemini(
    audio_bytes: bytes, mime: str, model: Optional[str] = None,
) -> tuple[Optional[str], Optional[str]]:
    """Gemini multimodal-native audio transcription via generateContent."""
    api_key = get_provider_api_key("gemini")
    if not api_key:
        return (None, "no_api_key")

    canon_mime = _GEMINI_AUDIO_MIME_MAP.get((mime or "").lower(), "audio/ogg")
    resolved_model = (
        model
        or os.environ.get("GEMINI_STT_MODEL")
        or DEFAULT_MODELS["gemini"]
    )
    base_url = PROVIDER_BASE_URLS["gemini"]

    try:
        b64 = base64.b64encode(audio_bytes).decode("ascii")
        body = {
            "contents": [
                {
                    "parts": [
                        {
                            "text": (
                                "Transcribe this audio exactly as spoken. "
                                "Output ONLY the verbatim transcript — no "
                                "commentary, no quotation marks, no language "
                                "detection prefix, no timestamps, no speaker "
                                "labels. Concatenate multiple speakers in order. "
                                "Preserve the speaker's original language (do "
                                "NOT translate)."
                            ),
                        },
                        {"inline_data": {"mime_type": canon_mime, "data": b64}},
                    ],
                }
            ],
            "generationConfig": {"temperature": 0.0, "maxOutputTokens": 4096},
        }
        url = f"{base_url}/models/{resolved_model}:generateContent?key={api_key}"
        with httpx.Client(timeout=_http_timeout()) as client:
            resp = client.post(url, json=body)
            if resp.status_code != 200:
                err = f"HTTP {resp.status_code}: {resp.text[:200]}"
                log.warning("STT gemini failed: %s", err)
                return (None, err)
            data = resp.json()
        candidates = data.get("candidates") or []
        if not candidates:
            return (None, "Gemini returned no candidates")
        parts = (candidates[0].get("content") or {}).get("parts") or []
        text = "".join(
            (p.get("text") or "") for p in parts if isinstance(p, dict)
        ).strip()
        return (text, None)
    except Exception as exc:
        msg = f"{type(exc).__name__}: {exc}"
        log.warning("STT gemini exception: %s", msg, exc_info=True)
        return (None, msg)


def transcribe_via_deepgram(
    audio_bytes: bytes, mime: str, model: Optional[str] = None,
) -> tuple[Optional[str], Optional[str]]:
    """Deepgram has its own request shape — raw audio body, NOT multipart.
    Endpoint: POST /v1/listen?model=nova-3 with Content-Type=audio/<...>.
    Response: { results: { channels: [{ alternatives: [{ transcript }] }] } }
    """
    api_key = get_provider_api_key("deepgram")
    if not api_key:
        return (None, "no_api_key")

    resolved_model = model or DEFAULT_MODELS["deepgram"]
    base_url = PROVIDER_BASE_URLS["deepgram"]
    canon_mime = (mime or "").lower() or "audio/ogg"
    url = f"{base_url}/listen?model={resolved_model}&smart_format=true&punctuate=true"

    try:
        with httpx.Client(timeout=_http_timeout()) as client:
            resp = client.post(
                url,
                headers={
                    "Authorization": f"Token {api_key}",
                    "Content-Type": canon_mime,
                },
                content=audio_bytes,
            )
            if resp.status_code != 200:
                err = f"HTTP {resp.status_code}: {resp.text[:200]}"
                log.warning("STT deepgram failed: %s", err)
                return (None, err)
            data = resp.json()
        # Walk the documented response shape.
        channels = ((data.get("results") or {}).get("channels") or [])
        if not channels:
            return ("", None)  # silent / no speech
        alternatives = channels[0].get("alternatives") or []
        if not alternatives:
            return ("", None)
        text = (alternatives[0].get("transcript") or "").strip()
        return (text, None)
    except Exception as exc:
        msg = f"{type(exc).__name__}: {exc}"
        log.warning("STT deepgram exception: %s", msg, exc_info=True)
        return (None, msg)


def transcribe_via_anthropic(
    audio_bytes: bytes, mime: str, model: Optional[str] = None,
) -> tuple[Optional[str], Optional[str]]:
    """Claude does NOT yet accept inline audio attachments via the
    Messages API (as of 2026-05). Register the provider so the chain
    knows it exists, but report a clear skip so the auto-fallback
    cascade moves on to the next provider rather than treating Claude
    as an STT option that crashes."""
    del audio_bytes, mime, model
    if not get_provider_api_key("anthropic"):
        return (None, "no_api_key")
    # API key IS present, but the capability isn't supported. Distinct
    # error so the caller can route around it.
    return (None, "anthropic does not support inline audio transcription")


# Provider id → transcribe function
PROVIDER_TRANSCRIBE_FNS: dict[
    str, Callable[..., tuple[Optional[str], Optional[str]]]
] = {
    "openai": transcribe_via_openai,
    "groq": transcribe_via_groq,
    "mistral": transcribe_via_mistral,
    "xai": transcribe_via_xai,
    "gemini": transcribe_via_gemini,
    "google": transcribe_via_gemini,  # alias
    "deepgram": transcribe_via_deepgram,
    "anthropic": transcribe_via_anthropic,
}


# ──────────────────────────────────────────────────────────────────────
# Main entry — auto-priority chain with active-model fallback
# ──────────────────────────────────────────────────────────────────────


def _build_chain() -> list[str]:
    """Return providers ordered by AUTO_PRIORITY ascending. Deduplicates
    aliases (e.g. gemini/google both map to one Gemini call)."""
    seen: set[str] = set()
    items = []
    for pid, prio in AUTO_PRIORITY.items():
        if pid in seen:
            continue
        # Collapse aliases at their lowest priority position. "google" is
        # an alias for "gemini" — both call transcribe_via_gemini. We
        # keep the first one we encounter, drop the duplicate.
        if pid == "google" and "gemini" in seen:
            continue
        if pid == "gemini" and "google" in seen:
            continue
        seen.add(pid)
        items.append((prio, pid))
    items.sort(key=lambda t: (t[0], t[1]))
    return [pid for _, pid in items]


def transcribe_audio_via_chain(
    audio_bytes: bytes, mime: str,
) -> tuple[Optional[str], Optional[str], list[str]]:
    """Run the full STT cascade — active-model fallback first, then the
    bundled auto-priority chain.

    Returns `(transcript, provider_used, attempts_log)`:
      - `transcript = "..."` → success (could be empty string for silent
        audio, distinct from no-attempts-succeeded which returns None).
      - `transcript = None, provider_used = None` → no provider had a
        usable API key (config issue) OR all providers errored.
      - `attempts_log` is a list of `"<provider>: <result>"` strings the
        caller can include in the agent's context note when nothing
        worked, so the agent can give the user actionable diagnostic
        info.
    """
    attempts: list[str] = []
    tried: set[str] = set()

    # google + gemini call the same transcribe function — collapse them
    # to one logical id when deduplicating the chain. Without this, an
    # "active model = google" call followed by the chain's "gemini"
    # entry would hit the same API twice.
    def _canon(pid: str) -> str:
        return "gemini" if pid == "google" else pid

    def _try(provider_id: str) -> tuple[Optional[str], Optional[str]]:
        canonical = _canon(provider_id)
        if canonical in tried:
            return (None, "already_tried")
        tried.add(canonical)
        fn = PROVIDER_TRANSCRIBE_FNS.get(provider_id)
        if not fn:
            attempts.append(f"{provider_id}: not registered")
            return (None, "not_registered")
        text, err = fn(audio_bytes, mime)
        if text is not None:
            attempts.append(f"{provider_id}: ok ({len(text)} chars)")
        else:
            attempts.append(f"{provider_id}: {err}")
        return (text, err)

    # Tier 0: active chat-model provider. Matches OpenClaw's
    # resolveEntriesWithActiveFallback pattern at resolve.ts:134-172.
    active = get_active_chat_provider()
    if active:
        text, err = _try(active)
        if text is not None:
            log.info(
                "STT via active chat provider %s (%d chars)",
                active, len(text),
            )
            return (text, active, attempts)

    # Tier 1+: bundled auto-priority chain.
    for provider_id in _build_chain():
        text, err = _try(provider_id)
        if text is not None:
            log.info(
                "STT via %s (priority chain, %d chars)",
                provider_id, len(text),
            )
            return (text, provider_id, attempts)

    # Nothing worked. Distinguish "no key configured anywhere" from
    # "keys present but all errored" so the bridge can produce the
    # right user-facing diagnostic.
    no_key_count = sum(1 for a in attempts if "no_api_key" in a)
    if no_key_count == len(attempts):
        return (None, None, attempts)
    return (None, None, attempts)


def list_configured_providers() -> list[str]:
    """Return all providers that have at least one API key set. Useful
    for diagnostics + user-facing 'voice is configured via X' messages."""
    out: list[str] = []
    seen: set[str] = set()
    for pid in AUTO_PRIORITY.keys():
        if pid in seen:
            continue
        # Dedupe gemini/google.
        if pid == "google" and "gemini" in seen:
            continue
        if pid == "gemini" and "google" in seen:
            continue
        if get_provider_api_key(pid):
            out.append(pid)
            seen.add(pid)
    return out


__all__ = [
    "DEFAULT_MODELS",
    "AUTO_PRIORITY",
    "PROVIDER_BASE_URLS",
    "PROVIDER_KEY_ENV_VARS",
    "get_provider_api_key",
    "get_active_chat_provider",
    "transcribe_audio_via_chain",
    "list_configured_providers",
    "invalidate_env_cache",
]
