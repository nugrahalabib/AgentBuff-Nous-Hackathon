"""
bootstrap_tui_gateway.py — wrapper that forces Hermes plugin discovery
BEFORE running `tui_gateway.entry`.

Why this exists:
  tui_gateway is Hermes' chat-agent runtime — where `text_to_speech_tool`
  + all other Hermes tools actually execute. By default, tui_gateway
  loads plugins LAZILY (`tui_gateway/server.py:924` only calls
  `discover_plugins()` when there's an unresolved toolset name), but
  the agentbuff-multimodal plugin is `kind: standalone` (no toolset to
  register) so the lazy path never fires.

  Result: our gTTS monkey-patch (`tts_gtts.install_gtts_patch()`) — and
  the STT/vision patches — only get applied in the dashboard runtime
  process (which DOES eager-discover plugins), NOT in tui_gateway. So
  the agent's `text_to_speech_tool` call hits the unpatched ORIGINAL
  which falls through to the broken edge-tts path → 403.

Solution:
  Spawn tui_gateway via this wrapper instead of `python -m tui_gateway.entry`.
  We call `discover_plugins()` eagerly first, which loads the
  agentbuff-multimodal plugin AND triggers `_install_patches()` →
  patches land in THIS Python process → subsequent
  `runpy.run_module("tui_gateway.entry")` runs in the same interpreter
  with all patches active.

Idempotent + defensive:
  - discover_plugins is a no-op on re-invocation
  - any import error during discover is caught and logged but doesn't
    abort tui_gateway boot (we'd rather have a working chat without
    enhanced multimodal than no chat at all)
"""

from __future__ import annotations

import logging
import sys

logger = logging.getLogger("bootstrap_tui_gateway")
# Ensure visibility even when Hermes hasn't yet configured root logger.
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

try:
    from hermes_cli.plugins import discover_plugins
    logger.info("bootstrap_tui_gateway: triggering eager discover_plugins() before tui_gateway boot")
    discover_plugins()
    logger.info("bootstrap_tui_gateway: discover_plugins() complete — patches active")
except Exception as exc:  # noqa: BLE001
    logger.exception(
        "bootstrap_tui_gateway: discover_plugins() crashed (%s) — "
        "tui_gateway will run WITHOUT multimodal patches; STT/vision/TTS "
        "fall back to Hermes built-ins",
        exc,
    )

# Per-session agent persona for /app chat (AgentBuff). Import tui_gateway.server
# (registers @method handlers + defines _make_agent at module level), then wrap
# session.create + _make_agent so each /app session runs as its BOUND agent's
# pure persona + model — per-session, ZERO global-config write. Must run BEFORE
# runpy hands off to entry (entry imports the SAME cached server module, so our
# wraps are already in place when the dispatch loop starts). Defensive: failure
# leaves the default global path intact.
try:
    import tui_gateway.server  # noqa: F401 — ensure module loaded + @method registered
    from agentbuff_persona_patch import install_persona_patch
    if install_persona_patch():
        logger.info("bootstrap_tui_gateway: per-session agent persona patch installed")
    else:
        logger.warning("bootstrap_tui_gateway: persona patch not applied (see warnings)")
except Exception as exc:  # noqa: BLE001
    logger.exception(
        "bootstrap_tui_gateway: persona patch crashed (%s) — /app chat will use "
        "the default agent for every session (no per-session persona)", exc,
    )

# Hand off to the real tui_gateway entry point. runpy.run_module preserves
# the `if __name__ == "__main__"` semantics so tui_gateway runs exactly as
# it would have via `python -m tui_gateway.entry`.
import runpy
sys.argv[0] = "tui_gateway.entry"  # cosmetic: matches expected process name
runpy.run_module("tui_gateway.entry", run_name="__main__", alter_sys=True)
