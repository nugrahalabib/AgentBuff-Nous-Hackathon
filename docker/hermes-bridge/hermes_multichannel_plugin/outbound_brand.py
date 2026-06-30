"""outbound_brand.py — scrub the engine brand (Hermes / Nous Research /
OpenClaw) from EVERY outbound channel message, at the final
``adapter.send(chat_id, content, ...)`` boundary, across all platforms.

Why here (vs the bridge / transform hooks):
  - The web /app path goes through the bridge's event_translator — handled
    separately. CHANNELS (Telegram/WA/Discord/Slack/…) are rendered + sent by
    the engine's gateway directly via each platform adapter's ``send`` method.
    base.py:1848 ``send`` is abstract; every platform OVERRIDES it. So we wrap
    each platform's own ``send`` — the single, final choke point before bytes
    leave for the channel. This catches EVERYTHING the bot emits on a channel:
    agent prose, tool-progress cards ("💻 terminal: …"), tool results, command
    labels, paths shown in prose — all in one place.
  - It is OUTBOUND only → it never touches the user's inbound message.
  - It is CHANNEL only → the web /app verbatim experience is unaffected.

Path safety (CRITICAL): ``MEDIA:`` tags + http(s) URLs are PROTECTED (left
verbatim) so channel media delivery (the adapter extracts MEDIA: paths, uploads
the file) is never broken. Other brand mentions — including bare filesystem
paths shown as prose like ``/home/hermes/config.yaml`` — ARE scrubbed
cosmetically (display only; the real path the engine executes is untouched
because we only rewrite the text being SENT, not anything functional).

Fail-open: any error in the scrub falls back to the original content, and a
patch that can't be applied is skipped with a log line — a brand-scrub bug must
never break message delivery.
"""

from __future__ import annotations

import importlib
import inspect
import logging
import re
from typing import Callable

log = logging.getLogger("agentbuff.multichannel.brand")

# Replacement order matters — multi-word / hyphenated phrases FIRST so they win
# before the bare-"hermes" pass fragments them. Case-preserving: the three
# trailing passes (Hermes / hermes / HERMES) keep the surrounding casing so a
# path like /home/hermes/.hermes reads /home/agentbuff/.agentbuff (not
# /home/AgentBuff/...). Goal: ANY hermes-flavoured token, anywhere in any
# sentence, however long, is rewritten — except functional MEDIA:/URL spans
# (protected below) which the channel needs intact to deliver media / links.
_BRAND_SUBS: list[tuple] = [
    (re.compile(r"Hermes[\s_-]?Agent", re.IGNORECASE), "Buff"),
    (re.compile(r"Nous[\s_-]?Research", re.IGNORECASE), "AgentBuff"),
    (re.compile(r"OpenClaw", re.IGNORECASE), "AgentBuff"),
    (re.compile(r"Teknium", re.IGNORECASE), "AgentBuff"),
    # Standalone "hermes" in any casing — case-preserving passes.
    (re.compile(r"Hermes"), "AgentBuff"),
    (re.compile(r"hermes"), "agentbuff"),
    (re.compile(r"HERMES"), "AGENTBUFF"),
    # Mixed/odd casing fallthrough (HeRmEs, hErMeS …) — last so the
    # case-preserving passes handle the common forms first.
    (re.compile(r"[Hh][Ee][Rr][Mm][Ee][Ss]"), "AgentBuff"),
]

# Spans left verbatim — functional identifiers the channel needs intact.
# MEDIA: tag = media delivery. We do NOT protect bare http(s) URLs: a bare-URL
# guard would shield brand tokens INSIDE a link (e.g.
# hermes-agent.nousresearch.com) from the scrubber. Media on channels travels
# via *_path/*_url kwargs that are excluded from text scrubbing by key, so
# delivery is unaffected.
_PROTECT_PATTERNS: list = [
    re.compile(r"MEDIA:\S+"),
    re.compile(r"\[\[audio_as_voice\]\]"),
]

# Fallback list of platforms whose adapters define their own ``send`` (used
# only if dynamic discovery fails). Prefer `_iter_platform_modules()` which
# enumerates EVERY gateway.platforms.* module so a newly-installed native
# adapter (qqbot / weixin / yuanbao / googlechat / …) can't slip through
# unwrapped and leak the brand. A hardcoded list is a brand-leak footgun:
# every platform NOT in it sends raw engine-brand bytes on its channel.
_PLATFORM_MODULES = [
    "telegram", "whatsapp", "discord", "slack", "signal", "matrix",
    "email", "sms", "webhook", "wecom", "feishu", "dingtalk",
    "bluebubbles", "homeassistant", "api_server", "msgraph_webhook",
]


def _iter_platform_modules() -> list[str]:
    """All importable ``gateway.platforms.*`` submodule names, discovered
    dynamically. Falls back to the static `_PLATFORM_MODULES` if the package
    can't be introspected. Scanning extra (non-adapter) modules is harmless —
    the wrap step filters to ``BasePlatformAdapter`` subclasses."""
    try:
        import pkgutil
        import gateway.platforms as _gp  # type: ignore
        names = sorted({m.name for m in pkgutil.iter_modules(_gp.__path__)})
        # Union with the static list so a platform that lives outside the
        # package path (rare) is still covered.
        return sorted(set(names) | set(_PLATFORM_MODULES))
    except Exception:
        log.debug("platform module discovery failed — using static list", exc_info=True)
        return list(_PLATFORM_MODULES)


_PATCH_SENTINEL = "_agentbuff_brand_wrapped"


def scrub_outbound(text: str) -> str:
    """Path/MEDIA-protected brand scrub for outbound channel text."""
    if not text or not isinstance(text, str):
        return text
    # Collect protected spans.
    spans: list[tuple[int, int]] = []
    for pat in _PROTECT_PATTERNS:
        for m in pat.finditer(text):
            spans.append((m.start(), m.end()))
    if not spans:
        for pattern, repl in _BRAND_SUBS:
            text = pattern.sub(repl, text)
        return text
    spans.sort()
    merged: list[tuple[int, int]] = []
    for s, e in spans:
        if merged and s <= merged[-1][1]:
            merged[-1] = (merged[-1][0], max(merged[-1][1], e))
        else:
            merged.append((s, e))
    out: list[str] = []
    last = 0
    for s, e in merged:
        gap = text[last:s]
        for pattern, repl in _BRAND_SUBS:
            gap = pattern.sub(repl, gap)
        out.append(gap)
        out.append(text[s:e])  # protected span verbatim
        last = e
    tail = text[last:]
    for pattern, repl in _BRAND_SUBS:
        tail = pattern.sub(repl, tail)
    out.append(tail)
    return "".join(out)


# Auxiliary outbound methods (beyond plain send) that carry user-visible TEXT
# as a keyword argument. Native adapters OVERRIDE these to do real platform API
# calls (e.g. WhatsApp media captions go straight to the Baileys bridge,
# bypassing send()), so the brand would leak in captions / edited messages /
# clarify prompts unless we scrub the text kwarg here too. We touch ONLY the
# display-text kwargs below — never *_path / *_url / chat_id / message_id — so
# media delivery (which reads the real path) is never broken.
_AUX_TEXT_METHODS = (
    "edit_message", "send_voice", "send_video", "send_document",
    "send_image", "send_image_file", "send_animation", "send_draft",
    "send_clarify", "send_private_notice", "send_or_update_status",
    "send_update_prompt", "send_exec_approval", "send_slash_confirm",
    "send_model_picker",
)
# Param names whose VALUE is always user-visible prose (safe to brand-scrub).
# Deliberately EXCLUDES audio_path/image_path/video_path/file_path/image_url/
# animation_url/chat_id/message_id/draft_id/status_key/session_key — those are
# functional identifiers/paths. `prompt` is here for send_update_prompt's
# user-facing question text.
_TEXT_KWARGS = (
    "content", "caption", "text", "question", "body", "summary", "message",
    "prompt",
)


def _scrub_text_kwargs(kwargs: dict) -> None:
    """In-place brand-scrub of known display-text kwargs (path/URL-safe)."""
    for k in _TEXT_KWARGS:
        v = kwargs.get(k)
        if isinstance(v, str) and v:
            try:
                kwargs[k] = scrub_outbound(v)
            except Exception:
                pass


def _make_aux_wrapped(orig: Callable) -> Callable:
    # Resolve the wrapped method's parameter names ONCE (positional order,
    # `self` first). Used to map POSITIONAL args back to their parameter name
    # so we scrub prose params (content/caption/prompt/…) even when the engine
    # passes them positionally — which it does. Without this, the kwargs-only
    # path missed the tool-progress status card text:
    #   send_or_update_status(chat_id, status_key, content)  ← content positional
    # → the engine brand leaked raw on EVERY tool-progress card on a channel.
    # Path/id params (audio_path/status_key/chat_id/session_key/reply_to/…) are
    # NOT in _TEXT_KWARGS, so they're left verbatim and media/IDs never break.
    try:
        _param_names = list(inspect.signature(orig).parameters)
    except (TypeError, ValueError):
        _param_names = []

    async def aux(self, *args, **kwargs):
        if kwargs:
            _scrub_text_kwargs(kwargs)
        new_args = args
        if args and _param_names:
            # _param_names[0] == "self"; positional `args` align to names[1:].
            scrubbed = list(args)
            for i, val in enumerate(args):
                ni = i + 1  # skip "self"
                if (
                    ni < len(_param_names)
                    and _param_names[ni] in _TEXT_KWARGS
                    and isinstance(val, str)
                    and val
                ):
                    try:
                        scrubbed[i] = scrub_outbound(val)
                    except Exception:
                        pass
            new_args = tuple(scrubbed)
        return await orig(self, *new_args, **kwargs)

    setattr(aux, _PATCH_SENTINEL, True)
    return aux


def install_aux_text_scrub() -> int:
    """Wrap caption/content/text-bearing aux methods on native adapters.

    Only wraps a class's OWN override of an aux method (the ones that do real
    platform API calls and so bypass the send() wrap). Aux methods inherited
    from BasePlatformAdapter route through self.send (already wrapped), so they
    are left alone. Idempotent (sentinel-guarded). Returns count wrapped.
    """
    try:
        from gateway.platforms.base import BasePlatformAdapter  # type: ignore
    except Exception:
        log.warning("aux text scrub: BasePlatformAdapter import failed — skipped")
        return 0

    wrapped = 0
    for name in _iter_platform_modules():
        try:
            mod = importlib.import_module(f"gateway.platforms.{name}")
        except Exception:
            continue
        for attr in dir(mod):
            cls = getattr(mod, attr, None)
            if not isinstance(cls, type):
                continue
            if not issubclass(cls, BasePlatformAdapter) or cls is BasePlatformAdapter:
                continue
            for meth in _AUX_TEXT_METHODS:
                own = cls.__dict__.get(meth)
                if own is None or getattr(own, _PATCH_SENTINEL, False):
                    continue
                try:
                    setattr(cls, meth, _make_aux_wrapped(own))
                    wrapped += 1
                except Exception:
                    log.debug("aux text scrub: could not wrap %s.%s", attr, meth, exc_info=True)
    log.warning("aux text scrub: wrapped %d native aux outbound method(s)", wrapped)
    return wrapped


def _make_wrapped_send(orig: Callable) -> Callable:
    async def send(self, chat_id, content, *args, **kwargs):
        if isinstance(content, str):
            # First: if the engine handed the channel one of its coarse
            # provider-error templates ("rate-limiting requests…"), remap it to
            # a clear layperson Bahasa message keyed off the real raw cause
            # (credit vs throttle vs auth). Then brand-scrub as usual.
            try:
                import provider_errors
                if provider_errors.looks_like_engine_error_reply(content):
                    content = provider_errors.localize(content)
            except Exception:
                pass
            try:
                content = scrub_outbound(content)
            except Exception:
                log.debug("outbound brand scrub failed — sending verbatim", exc_info=True)
        # Instant realtime: a reply just went out on a channel. mark_reply_sent
        # records the timestamp so the bridge watcher clears the agent's
        # "working" mark (turn finished → card stops animating) AND pokes so the
        # new assistant turn + cleared state reach /app without the idle poll.
        try:
            from .activity_poke import mark_reply_sent
            mark_reply_sent()
        except Exception:
            pass
        return await orig(self, chat_id, content, *args, **kwargs)

    setattr(send, _PATCH_SENTINEL, True)
    return send


def install_outbound_brand_scrub() -> int:
    """Monkeypatch every platform adapter's ``send`` to scrub the brand.

    Returns the number of adapter classes patched. Idempotent (sentinel-guarded).
    """
    try:
        from gateway.platforms.base import BasePlatformAdapter  # type: ignore
    except Exception:
        log.warning("outbound brand scrub: BasePlatformAdapter import failed — skipped")
        return 0

    patched = 0
    for name in _iter_platform_modules():
        try:
            mod = importlib.import_module(f"gateway.platforms.{name}")
        except Exception:
            continue  # platform/library not installed in this image — fine
        for attr in dir(mod):
            cls = getattr(mod, attr, None)
            if not isinstance(cls, type):
                continue
            if not issubclass(cls, BasePlatformAdapter) or cls is BasePlatformAdapter:
                continue
            # Only wrap a ``send`` THIS class actually defines (its override),
            # and only once.
            own_send = cls.__dict__.get("send")
            if own_send is None or getattr(own_send, _PATCH_SENTINEL, False):
                continue
            try:
                cls.send = _make_wrapped_send(own_send)
                patched += 1
            except Exception:
                log.debug("outbound brand scrub: could not patch %s.send", attr, exc_info=True)
    # WARNING level: the gateway-runtime subprocess filters its root logger at
    # WARNING, so an INFO line here is invisible there — yet THIS is the process
    # that actually sends channel messages, so we want boot-time proof the scrub
    # installed. Security-relevant + once per boot → WARNING is appropriate.
    log.warning("outbound brand scrub: patched %d native platform adapter send() methods", patched)
    return patched


def wrap_adapter_classes(classes) -> int:
    """Wrap ``send()`` on plugin-provided adapter classes.

    ``install_outbound_brand_scrub`` only scans ``gateway.platforms.*`` modules,
    so it MISSES our synthetic per-account adapters (Telegram/Discord/Slack),
    whose ``send`` overrides live in ``hermes_multichannel_plugin.adapter_*``.
    Those adapters pushed ``content`` straight to the channel library with NO
    brand scrub — the primary channel leak. This wraps each such class's own
    ``send`` with the same path/MEDIA-protected scrub.

    Idempotent (sentinel-guarded). Classes that don't define their own ``send``
    (e.g. native-wrap / WhatsApp subclasses that INHERIT the already-wrapped
    native send) are skipped — wrapping them would double-scrub.

    Returns the number of classes newly wrapped.
    """
    patched = 0
    seen: set[int] = set()
    for cls in (classes or []):
        if not isinstance(cls, type) or id(cls) in seen:
            continue
        seen.add(id(cls))
        own_send = cls.__dict__.get("send")
        if own_send is None or getattr(own_send, _PATCH_SENTINEL, False):
            continue
        try:
            cls.send = _make_wrapped_send(own_send)
            patched += 1
            log.warning(
                "outbound brand scrub: wrapped plugin adapter %s.send",
                getattr(cls, "__name__", cls),
            )
        except Exception:
            log.debug(
                "outbound brand scrub: could not wrap %s.send",
                getattr(cls, "__name__", cls),
                exc_info=True,
            )
    log.warning("outbound brand scrub: wrapped %d plugin adapter send() methods", patched)
    return patched
