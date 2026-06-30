"""
plugin-tts-gtts.py — gTTS provider extension for Hermes' text_to_speech tool.

Lives in `$HERMES_HOME/plugins/agentbuff-multimodal/tts_gtts.py` after the
bridge entrypoint copies it from `/app/bridge/plugin-tts-gtts.py` into
the plugin folder on container startup. The plugin's __init__.py calls
`install_gtts_patch()` from this module during its `_install_patches()`.

Why we ship this OUTSIDE the main __init__.py:
- Keeps the gTTS provider concern self-contained — easy to remove if
  Microsoft edge-tts upstream fixes its 403 handshake bug.
- Mirrors the per-capability layout used by `stt_providers.py` (audio)
  + `media_providers.py` (image/video/document) in the bridge sibling
  package. Plugin authors expect 1 file per capability.

What it does:
- Monkey-patches `tools.tts_tool.text_to_speech_tool` to intercept calls
  when `tts.provider: gtts` is configured. The original tool's if/elif
  dispatch chain doesn't know about gtts (it's a `BUILTIN_TTS_PROVIDERS`
  frozenset and can't be mutated), so we wrap the function:
    1. Load tts_config
    2. Read provider name via `_get_provider(tts_config)`
    3. If provider == "gtts": run our gTTS pipeline, return JSON result
       matching the original function's success shape
    4. Otherwise: delegate to original function

Why gTTS specifically:
- FREE, no API key, no auth — survives behind any firewall
- Supports Indonesian (id-ID) — chief's primary language
- Lightweight (~50KB Python package)
- Reliable (Google Translate public endpoint, no proprietary auth like
  Microsoft's TrustedClientToken that broke edge-tts 6.1.19)

Provider chain (matches Hermes' built-in pattern):
- Tier 10 (PRIMARY): gtts — config.yaml `tts.provider: gtts` selects this
- Tier 99 (FALLBACK): edge — kept for `tts.provider: edge` users IF
  Microsoft fixes their auth. Plugin doesn't intercept other providers.

Return format (matches original `text_to_speech_tool`):
  Success:  {"success": True, "file_path": "...", "media_tag": "MEDIA:..."}
  Failure:  {"success": False, "error": "..."}

The bridge bot_media_extractor (post-Bug-2 fix) picks up the MEDIA: tag
either as local path or URL, registers with media_serve, and emits an
attachment dict to /app — chief gets a playable AudioCard.
"""

from __future__ import annotations

import datetime
import json
import logging
import os
import sys
from pathlib import Path
from typing import Any, Callable, Optional

logger = logging.getLogger("agentbuff-multimodal.tts_gtts")

_PATCHED_SENTINEL = "_agentbuff_gtts_patched"


def _have_gtts() -> bool:
    """Check if gTTS Python package is importable."""
    try:
        import gtts  # noqa: F401
        return True
    except ImportError:
        return False


def _default_output_dir() -> Path:
    """Resolve where to write TTS output. Mirrors tts_tool's logic."""
    home = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    out_dir = Path(home).expanduser() / "cache" / "audio"
    out_dir.mkdir(parents=True, exist_ok=True)
    return out_dir


def _resolve_lang(tts_config: dict) -> str:
    """Pick language code from `tts.gtts.lang` config, default id (Indonesian)."""
    gtts_cfg = tts_config.get("gtts", {}) if isinstance(tts_config, dict) else {}
    if isinstance(gtts_cfg, dict):
        lang = gtts_cfg.get("lang")
        if isinstance(lang, str) and lang.strip():
            return lang.strip()
    return "id"


def _resolve_slow(tts_config: dict) -> bool:
    """Pick slow flag from `tts.gtts.slow`. Default False (normal speed)."""
    gtts_cfg = tts_config.get("gtts", {}) if isinstance(tts_config, dict) else {}
    if isinstance(gtts_cfg, dict):
        slow = gtts_cfg.get("slow")
        if isinstance(slow, bool):
            return slow
    return False


def _resolve_tld(tts_config: dict) -> str:
    """Top-level domain for Google Translate endpoint.

    Different TLDs yield slightly different voices (US English from .com,
    UK English from .co.uk, etc). For Indonesian we use `co.id` for
    nearest accent. Configurable via `tts.gtts.tld`."""
    gtts_cfg = tts_config.get("gtts", {}) if isinstance(tts_config, dict) else {}
    if isinstance(gtts_cfg, dict):
        tld = gtts_cfg.get("tld")
        if isinstance(tld, str) and tld.strip():
            return tld.strip()
    return "co.id"


def _generate_gtts(text: str, output_path: str, tts_config: dict) -> None:
    """Synthesize speech via Google Translate TTS, save as MP3 to output_path.

    Raises RuntimeError on failure (caller wraps for JSON error response).
    """
    from gtts import gTTS  # type: ignore
    from gtts.tts import gTTSError  # type: ignore

    lang = _resolve_lang(tts_config)
    slow = _resolve_slow(tts_config)
    tld = _resolve_tld(tts_config)

    try:
        tts = gTTS(text=text, lang=lang, slow=slow, tld=tld)
        tts.save(output_path)
    except gTTSError as exc:
        # gTTS hits rate limit OR unsupported language → surface clearly
        raise RuntimeError(f"gTTS error: {exc}") from exc
    except Exception as exc:  # noqa: BLE001 — anything else (network etc)
        raise RuntimeError(f"gTTS unexpected failure: {exc}") from exc

    # Verify output file was written + has content (mirrors edge-tts check)
    if not os.path.exists(output_path):
        raise RuntimeError(f"gTTS produced no file at {output_path}")
    size = os.path.getsize(output_path)
    if size == 0:
        raise RuntimeError(f"gTTS produced empty file at {output_path}")
    if size < 1024:
        # Suspiciously small file — log warning but accept (a 1-char text
        # might legitimately produce ~500-byte MP3).
        logger.warning(
            "gTTS output unexpectedly small: %d bytes at %s — may be silent or corrupt",
            size, output_path,
        )


def _make_patched_text_to_speech_tool(original: Callable[..., Any]) -> Callable[..., Any]:
    """Wrap Hermes' `text_to_speech_tool` with gTTS dispatch."""

    def patched(text: str, output_path: Optional[str] = None) -> str:
        if not text or not text.strip():
            # Defer to original — its validation error message is fine
            return original(text, output_path)

        # Load config + check provider
        try:
            from tools.tts_tool import _load_tts_config, _get_provider  # type: ignore
            tts_config = _load_tts_config()
            provider = _get_provider(tts_config)
        except Exception as exc:  # noqa: BLE001
            logger.debug("tts_gtts: cannot read config (%s) — delegating to original", exc)
            return original(text, output_path)

        # Only intercept when provider is "gtts" — every other case
        # delegates to original (preserves all Hermes TTS providers)
        if provider != "gtts":
            return original(text, output_path)

        # gTTS not installed → fail with clear actionable error
        if not _have_gtts():
            return json.dumps({
                "success": False,
                "error": (
                    "gTTS provider selected but 'gtts' package not installed. "
                    "Run: pip install gTTS==2.5.4"
                ),
            }, ensure_ascii=False)

        # Resolve output path (mirrors tts_tool logic)
        if output_path:
            file_path = Path(output_path).expanduser()
        else:
            timestamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
            out_dir = _default_output_dir()
            file_path = out_dir / f"tts_{timestamp}.mp3"

        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_str = str(file_path)

        logger.info("Generating speech with gTTS (lang=%s)...", _resolve_lang(tts_config))
        try:
            _generate_gtts(text, file_str, tts_config)
        except RuntimeError as exc:
            return json.dumps({
                "success": False,
                "error": str(exc),
            }, ensure_ascii=False)

        # Success — return matching format Hermes' tools expect
        return json.dumps({
            "success": True,
            "file_path": file_str,
            "media_tag": f"MEDIA:{file_str}",
            "provider": "gtts",
            "voice": f"gtts-{_resolve_lang(tts_config)}",
        }, ensure_ascii=False)

    setattr(patched, _PATCHED_SENTINEL, True)
    return patched


def install_gtts_patch() -> None:
    """Install the gTTS wrapper around tools.tts_tool.text_to_speech_tool.

    Idempotent: re-runs are no-ops (sentinel check).
    """
    try:
        from tools import tts_tool  # type: ignore
    except ImportError as exc:
        logger.warning(
            "tts_gtts: cannot import tools.tts_tool (%s) — gTTS patch skipped",
            exc,
        )
        return

    original = getattr(tts_tool, "text_to_speech_tool", None)
    if not callable(original):
        logger.warning(
            "tts_gtts: tools.tts_tool has no callable text_to_speech_tool — skipped",
        )
        return

    if getattr(original, _PATCHED_SENTINEL, False):
        logger.debug("tts_gtts: text_to_speech_tool already patched")
        return

    patched = _make_patched_text_to_speech_tool(original)
    setattr(tts_tool, "text_to_speech_tool", patched)

    # Rebind top-level importers — modules that did
    # `from tools.tts_tool import text_to_speech_tool` at the top must
    # see our patched function too.
    rebind_count = 0
    for mod_name, mod in list(sys.modules.items()):
        if mod is None or mod is tts_tool:
            continue
        try:
            if getattr(mod, "text_to_speech_tool", None) is original:
                setattr(mod, "text_to_speech_tool", patched)
                rebind_count += 1
        except Exception:  # noqa: BLE001
            continue

    logger.info(
        "tts_gtts: patched tools.tts_tool.text_to_speech_tool "
        "(rebound %d top-level importer(s)); gtts package available: %s",
        rebind_count, _have_gtts(),
    )
