"""
media_serve.py — token-URL HTTP file serving for bot-generated media.

Pattern lifted from Hermes' LINE adapter
(`HermesAgent/plugins/platforms/line/adapter.py:1223-1304`):
  - Agent's text_to_speech/image_generate/video_generate tools write
    files to `~/.hermes/cache/{audio,images,videos,documents}/`.
  - Agent emits `MEDIA:/abs/path/file.ext` in its response text.
  - Bridge extracts MEDIA paths via `BasePlatformAdapter.extract_media`
    (already implemented in Hermes), then for each path:
      * Validates path is inside an allowed cache root.
      * Registers it under a one-time opaque token in this module's
        in-memory table with a TTL (default 24h).
      * Returns the public URL `http://<bridge-host>:<health-port>/media/<token>/<filename>`.
  - The /app browser fetches that URL with `<img src>` / `<audio src>` /
    `<a download>` / etc — the bridge's HTTP server (the same hand-rolled
    asyncio server used for /health) resolves the token, re-validates the
    path, and streams the file with the right Content-Type +
    Content-Disposition.

Security model:
  - Tokens are 32-byte URL-safe random; effectively unguessable.
  - Each token maps to a SINGLE pre-validated path. Even if a token
    leaks, attacker can only fetch the one shared file (not arbitrary
    fs reads).
  - Allowed roots = `~/.hermes/cache/` subtree + a small whitelist of
    workspace paths the agent writes to (`~/.hermes/agents/*/files/`).
    Anything else is refused at registration time.
  - TTL eviction runs lazily on each lookup — no background sweeper to
    leak memory or hold a lock.
  - Bridge's health port is loopback-only (`127.0.0.1:<port>` published)
    so external network can't reach this. Same trust boundary as the
    rest of bridge IO.

Cross-origin notes:
  - /app on localhost:617 fetches from localhost:18790 → cross-origin.
  - For `<img>`, `<audio>`, `<video>` tag-based loading: cross-origin
    works without CORS preflight. They follow Same-Origin Policy
    relaxations for media elements.
  - For `<a download>`: cross-origin downloads honour the `download`
    attribute IFF the response has `Content-Disposition: attachment`.
    Our handler sets it when `?download=1` query param is present;
    otherwise serves inline so `<img src>` continues to work.
  - We DO add `Access-Control-Allow-Origin: *` so any portal page can
    fetch without preflight. The token already provides auth.
"""

from __future__ import annotations

import hashlib
import logging
import mimetypes
import os
import re
import secrets
import shutil
import time
from pathlib import Path
from typing import Optional
from urllib.parse import quote

log = logging.getLogger("bridge.media_serve")

# Token TTL — Hermes' own `cleanup_image_cache` defaults to 24h, so we
# keep parity. Long-lived chat histories may exceed this; on stale token
# the /app falls back gracefully (broken-image / re-fetch button).
TOKEN_TTL_SECONDS = 24 * 60 * 60

# Per-bridge in-memory table. Bridge process restart wipes it (intentional
# — restart usually means new container, all blob URLs in /app re-issued).
_TOKENS: dict[str, dict] = {}


def _hermes_home() -> Path:
    raw = os.environ.get("HERMES_HOME") or str(Path.home() / ".hermes")
    return Path(raw).resolve()


def _allowed_roots() -> list[Path]:
    """Whitelist of filesystem subtrees we'll serve from. Mirrors what
    Hermes' tools actually write to (cache + agent workspace files)."""
    import glob as _glob

    home = _hermes_home()
    _subtrees = (
        "cache",          # cache/{images,audio,videos,documents}
        "image_cache",    # legacy openclaw-style location
        "audio_cache",
        "video_cache",
        "document_cache",
        "agents",         # ~/.hermes/agents/*/files/
        "workspace",      # general workspace (some tools write here)
    )
    roots = [home / s for s in _subtrees]
    roots.append(Path("/tmp/hermes"))  # tts_tool default for some providers
    roots.append(Path("/tmp"))         # some tools write generated files to /tmp
    # 2026-06-09 (file-delivery PARITY with Telegram): the agent writes
    # TERMINAL-generated files (e.g. `python3 … -> hai.pdf`) to its WORKING DIR
    # — which is HERMES_HOME itself, or the container user home — NOT a cache/
    # subdir. The old subtree-only allowlist refused those exact files, so
    # "buatkan PDF" delivered fine on Telegram (the channel adapter reads ANY
    # path the agent emits via MEDIA:) but produced NOTHING on /app: the agent
    # emitted `MEDIA:/home/hermes/.hermes/hai.pdf`, register_media refused the
    # root path, zero attachments shipped. Allow the working dirs (recursive)
    # so any agent-generated file is deliverable like on a channel. Secrets are
    # blocked by _is_sensitive_file (a denylist the channel adapters DON'T even
    # have — so this is SAFER than Telegram, not looser), and every served file
    # is still gated behind a 32-byte one-time token on a loopback-only port.
    home_parent = home.parent  # /home/hermes (container user home / agent cwd)
    roots.append(home)         # $HERMES_HOME — default-agent terminal cwd
    roots.append(home_parent)  # /home/hermes — covers the alt cwd copy
    # NON-default agents run with HERMES_HOME overridden to profiles/<agent>/;
    # whitelist each profile's subtrees AND its home root (terminal cwd).
    for _prof in _glob.glob(str(home / "profiles" / "*")):
        _pp = Path(_prof)
        roots.append(_pp)
        for s in _subtrees:
            roots.append(_pp / s)
    return [r.resolve() for r in roots if r.exists() or str(r).startswith("/tmp")]


# Secret denylist — refused even when inside an allowed root. Now that we serve
# the agent's working dirs (HERMES_HOME / user home) so terminal-generated files
# deliver, those same dirs ALSO hold secrets (config.yaml, .env, state.db, keys).
# A 32-byte token already gates every fetch, but this is the belt-and-suspenders
# the channel adapters never had: even if the agent (accidentally or maliciously)
# emits MEDIA: pointing at a secret, register_media refuses it. (2026-06-09)
_SENSITIVE_NAMES = {
    "config.yaml", "config.yml", "config.json", "openclaw.json", "agentbuff.json",
    ".npmrc", ".netrc", ".dockercfg", "credentials", "credentials.json",
    "id_rsa", "id_ed25519", "id_ecdsa", "id_dsa",
}
_SENSITIVE_EXTS = {
    ".db", ".sqlite", ".sqlite3", ".key", ".pem", ".pfx", ".p12", ".keystore",
    ".kdbx", ".asc", ".gpg",
}
_SENSITIVE_DIR_PARTS = {".ssh", ".gnupg", ".aws", ".git", ".config"}


def _is_sensitive_file(resolved: Path) -> bool:
    """True for files that must NEVER be served regardless of allowed roots
    (credentials, keys, the engine config + state DB)."""
    name = resolved.name.lower()
    if name in _SENSITIVE_NAMES:
        return True
    if name.startswith(".env"):          # .env, .env.local, .env.production …
        return True
    if name.startswith("state.db"):      # state.db, state.db-wal, state.db-shm
        return True
    if name.endswith(("-wal", "-shm")) and ".db" in name:
        return True
    if resolved.suffix.lower() in _SENSITIVE_EXTS:
        return True
    if {p.lower() for p in resolved.parts} & _SENSITIVE_DIR_PARTS:
        return True
    return False


def _is_path_allowed(path: Path) -> bool:
    """True if `path` resolves inside one of the allowed roots. Catches
    symlink-escape attempts via `resolve()` (follows symlinks then
    compares). Secrets are refused up-front via `_is_sensitive_file`."""
    try:
        resolved = path.resolve()
    except (OSError, RuntimeError):
        return False
    if not resolved.is_file():
        return False
    if _is_sensitive_file(resolved):
        log.warning("register_media: refused sensitive file: %s", resolved.name)
        return False
    for root in _allowed_roots():
        try:
            resolved.relative_to(root)
            return True
        except ValueError:
            continue
    return False


def register_media(path: str | Path) -> Optional[str]:
    """Register a file for HTTP serving. Returns an opaque token or None
    if the path isn't allowed.

    Idempotent for the same path within the TTL window — re-registers
    return a fresh token but old tokens stay valid until they expire.
    Memory is bounded by TTL eviction during `resolve_token`.
    """
    p = Path(path).expanduser()
    if not _is_path_allowed(p):
        log.warning(
            "register_media: refused path outside allowed roots: %s",
            p,
        )
        return None
    token = secrets.token_urlsafe(32)
    resolved = p.resolve()
    mime = mimetypes.guess_type(str(resolved))[0] or "application/octet-stream"
    _TOKENS[token] = {
        "path": str(resolved),
        "mime": mime,
        "filename": resolved.name,
        "expires_at": time.time() + TOKEN_TTL_SECONDS,
        "size": resolved.stat().st_size,
    }
    log.info(
        "register_media: token=%s file=%s mime=%s size=%d",
        token[:8] + "…",  # truncated for log readability
        resolved.name,
        mime,
        resolved.stat().st_size,
    )
    return token


def resolve_token(token: str) -> Optional[dict]:
    """Look up a token. Returns None if missing or expired. Lazy eviction
    of stale entries happens here so we never bother with a sweeper."""
    entry = _TOKENS.get(token)
    if not entry:
        return None
    if time.time() > entry.get("expires_at", 0):
        _TOKENS.pop(token, None)
        return None
    # Re-validate path is still on disk + still allowed (cache rotation
    # could have removed it between register + fetch).
    p = Path(entry["path"])
    if not _is_path_allowed(p):
        _TOKENS.pop(token, None)
        return None
    return entry


def public_url(token: str, filename: str, *, host: str, port: int) -> str:
    """Build the public URL the browser fetches from. Host should be
    `127.0.0.1` (or whatever loopback the bridge published)."""
    # Browser fetches via Docker-host loopback; from inside Docker the
    # bridge listens on 0.0.0.0:<port>.
    return f"http://{host}:{port}/media/{token}/{filename}"


# ---------------------------------------------------------------------------
# DURABLE media store (2026-06-11) — fixes "media hilang setelah 24 jam / restart".
#
# The token path above is INTENTIONALLY ephemeral: files live in the 24h LRU
# cache and tokens live in this process's RAM (wiped on restart). That means a
# chat from >24h ago (or after any container rebuild) shows broken media on both
# /app AND channels — the file is gone and/or the token is dead.
#
# The durable store fixes this for media GOING FORWARD: every served file is
# ALSO copied (content-addressed) into `~/.hermes/media-store/` — which lives in
# the per-user VOLUME, is never TTL-evicted, and survives restarts — and we hand
# the caller a TOKENLESS, stable URL `/media/d/<sha><ext>/<name>`. As long as the
# volume exists, that URL keeps resolving. Old transcripts keep their dead token
# URLs (the files are already gone — unrecoverable), but anything created from
# now on is permanent.
# ---------------------------------------------------------------------------

# Served durable filename = <hex-hash><.ext>. Anchored + bounded so a request
# path can't traverse out of the store dir.
_DURABLE_NAME_RE = re.compile(r"^[0-9a-f]{8,64}(\.[A-Za-z0-9]{1,12})?$")
_SAFE_EXT_RE = re.compile(r"^\.[A-Za-z0-9]{1,12}$")


def _media_store_dir() -> Path:
    d = _hermes_home() / "media-store"
    try:
        d.mkdir(parents=True, exist_ok=True)
        # Sentinel keeps the dir non-empty so the engine's disk-cleanup plugin
        # (which rmdir's empty dirs outside its protected set) can never remove
        # our durable store during a momentary-empty window.
        (d / ".keep").touch(exist_ok=True)
    except OSError:
        log.debug("media-store mkdir failed: %s", d, exc_info=True)
    return d


def durable_url(path: str | Path, *, host: str, port: int) -> Optional[str]:
    """Copy a validated media file into the durable store and return a stable,
    tokenless URL that survives the 24h cache TTL + container restart.

    Returns None if the path isn't an allowed/served media file (same security
    gate as `register_media`) or the copy fails — caller should fall back.
    """
    p = Path(path).expanduser()
    if not _is_path_allowed(p):
        return None
    resolved = p.resolve()
    try:
        h = hashlib.sha256()
        with open(resolved, "rb") as f:
            for chunk in iter(lambda: f.read(1 << 16), b""):
                h.update(chunk)
        digest = h.hexdigest()[:32]
        ext = resolved.suffix.lower()
        if not _SAFE_EXT_RE.match(ext):
            ext = ""
        store_name = f"{digest}{ext}"
        dst = _media_store_dir() / store_name
        # Self-heal: a pre-existing store file is trusted ONLY if its size
        # matches the source. A 0-byte / truncated / partially-written file
        # left at the content-addressed name would otherwise be served forever
        # as HTTP 200 with zero bytes -> a permanent broken-image icon.
        src_size = resolved.stat().st_size
        need_copy = (not dst.exists()) or (dst.stat().st_size != src_size)
        if need_copy:
            # Copy to a temp name then atomically rename so a concurrent fetch
            # never sees a half-written file.
            tmp = dst.with_name(f".{store_name}.{secrets.token_hex(4)}.tmp")
            shutil.copy2(resolved, tmp)
            os.replace(tmp, dst)
        # Never hand back a URL to a file that isn't actually there with bytes.
        if (not dst.is_file()) or dst.stat().st_size == 0:
            log.warning("durable_url: dst missing/empty after copy: %s", dst)
            return None
        # Preserve the human filename as the decorative last URL segment so
        # /app shows the real name + downloads keep it.
        display = quote(resolved.name, safe="")
        return f"http://{host}:{port}/media/d/{store_name}/{display}"
    except Exception:
        log.debug("durable_url failed for %s", path, exc_info=True)
        return None


def resolve_durable(store_name: str) -> Optional[dict]:
    """Resolve a `/media/d/<store_name>` request to a file in the durable store.
    Path-traversal-safe: only bare `<hash><ext>` names that resolve inside the
    store dir are served."""
    if not _DURABLE_NAME_RE.match(store_name):
        return None
    store_dir = _media_store_dir().resolve()
    dst = (store_dir / store_name).resolve()
    try:
        dst.relative_to(store_dir)
    except ValueError:
        return None
    if not dst.is_file():
        return None
    # Read-side defense-in-depth: never stream a 0-byte file as a 200 (the
    # browser would render a broken-image icon). 404 instead so /app re-fetches.
    if dst.stat().st_size == 0:
        return None
    mime = mimetypes.guess_type(str(dst))[0] or "application/octet-stream"
    return {
        "path": str(dst),
        "mime": mime,
        "filename": dst.name,
        "size": dst.stat().st_size,
    }


def public_url_durable(path: str | Path, *, host: str, port: int) -> Optional[str]:
    """Preferred media URL builder: a durable, tokenless URL that never expires.
    Falls back to the legacy ephemeral token URL if the durable copy fails, so
    media is never silently dropped."""
    url = durable_url(path, host=host, port=port)
    if url:
        return url
    token = register_media(path)
    if not token:
        return None
    return public_url(token, Path(path).name, host=host, port=port)


# ── Assistant-text media normalisation (shared: live + history paths) ────────
# The agent emits media references in several shapes the browser CAN'T load:
#   - `MEDIA:/abs/path`  /  `MEDIA:sandbox:/path`  /  `MEDIA:file:///path`
#   - a markdown image the gpt/codex models love:
#       ![alt](sandbox:/home/hermes/.hermes/image_cache/x.jpg)
#       ![alt](file:///home/hermes/.hermes/cache/video/y.mp4)
#       [doc](/home/hermes/.hermes/cache/documents/z.pdf)
# ALL must become the durable HTTP URL or /app shows a broken image / dead link.
# One helper so the live event path (event_translator) and the history path
# (rpc_router.sessions.get) can NEVER diverge again — works for image, video,
# audio, and document alike (any local file under the allowed media roots).
_MEDIA_EXPIRED_NOTE = "_(media tidak tersedia lagi — minta Buff kirim ulang)_"
_LOCAL_MEDIA_TAG_RE = re.compile(
    r"\bMEDIA:(?:sandbox:|file://)?(?P<path>(?:/|~/)[^\s\]]+)",
)
# Markdown image/link whose URL is a bare local/sandbox/file path. The path
# group requires a leading `/` or `~/`, so http(s) URLs never match (idempotent).
_MD_LOCAL_MEDIA_RE = re.compile(
    r"(?P<pre>!?\[[^\]\n]*\]\()(?:sandbox:|file://)?(?P<path>(?:/|~/)[^\s\)]+)(?P<post>\))",
)


def rewrite_local_media_in_text(
    text: str, *, host: str, port: int
) -> tuple[str, int, int]:
    """Rewrite every LOCAL media reference (a `MEDIA:` tag OR a markdown
    image/link with a sandbox:/file://abs path) to a durable HTTP URL.

    Returns ``(new_text, rewrites, drops)``. Idempotent — http(s) URLs are never
    matched, so re-running is a no-op. Dead files (cache rotation / rebuild) are
    replaced with a clean, path-free Bahasa note.
    """
    if not isinstance(text, str) or (
        "MEDIA:" not in text
        and "](sandbox:" not in text
        and "](file://" not in text
        and "](/home/" not in text
        and "](~/" not in text
    ):
        return text, 0, 0

    rewrites = 0
    drops = 0

    def _durable(raw_path: str) -> Optional[str]:
        try:
            p = Path(os.path.expanduser(raw_path))
            if not p.is_file():
                return None
            return public_url_durable(p, host=host, port=port)
        except Exception:  # noqa: BLE001
            return None

    def _media_tag(m: "re.Match") -> str:
        nonlocal rewrites, drops
        url = _durable(m.group("path"))
        if not url:
            drops += 1
            return _MEDIA_EXPIRED_NOTE
        rewrites += 1
        return f"MEDIA:{url}"

    def _md_local(m: "re.Match") -> str:
        nonlocal rewrites, drops
        url = _durable(m.group("path"))
        if not url:
            drops += 1
            return _MEDIA_EXPIRED_NOTE
        rewrites += 1
        return f"{m.group('pre')}{url}{m.group('post')}"

    out = _LOCAL_MEDIA_TAG_RE.sub(_media_tag, text)
    out = _MD_LOCAL_MEDIA_RE.sub(_md_local, out)
    return out, rewrites, drops


# Markdown media whose URL is a LOCAL path (sandbox:/file://abs). Captures the
# optional leading `!`, the label, and the path so we can detect voice-notes by
# label. http(s) refs never match (path group requires a leading `/` or `~/`).
_MD_TO_TAG_RE = re.compile(
    r"(?P<bang>!?)\[(?P<label>[^\]\n]*)\]\((?:sandbox:|file://)?(?P<path>(?:/|~/)[^\s\)]+)\)",
)
_VOICE_LABEL_RE = re.compile(r"voice|suara|audio|rekaman|vn\b", re.IGNORECASE)


def normalize_markdown_media_to_tags(text: str) -> str:
    """Convert markdown media refs whose URL is a LOCAL path — `![alt](sandbox:/
    p.jpg)` (image syntax) AND `[Voice note](sandbox:/p.webm)` (link syntax) —
    into the canonical `MEDIA:<path>` tag form.

    Why: gpt/codex models RESEND a file as markdown, not a `MEDIA:` tag. Left as
    markdown it renders as a broken inline <img> / dead link INSIDE the prose
    bubble. By converting to `MEDIA:<path>` first, the existing battle-tested
    extraction pipeline (live: bot_media_extractor passes; history: bridge
    durable-rewrite -> TS extractor) turns it into a rich AttachmentPart card
    (ImageCard+lightbox / AudioCard player / VideoCard / DocumentCard download)
    rendered OUTSIDE the bubble — same as a real `MEDIA:` tag. One normalisation,
    both paths, zero new card-building code.

    Adds the `[[audio_as_voice]]` companion when the ref looks like a voice note
    (label says voice/suara/audio, or the path lives under an audio cache dir) so
    a `.webm` voice note classifies as audio (not video). Remote http(s) refs are
    left untouched. Idempotent — a `MEDIA:` tag has no `](` so re-running is a
    no-op.
    """
    if not isinstance(text, str) or "](" not in text:
        return text

    def _sub(m: "re.Match") -> str:
        path = m.group("path")
        label = m.group("label") or ""
        is_image_syntax = bool(m.group("bang"))
        # Guard: a PLAIN markdown LINK `[text](/abs/path)` to an extensionless
        # target is almost certainly a route/anchor in prose, NOT a file (e.g.
        # `[buka](/app/settings)`). Converting it would strip the link + its
        # text. Only convert link-form refs whose path has a real file
        # extension. Image-syntax `![..](..)` is always a media embed → convert.
        seg = path.rsplit("/", 1)[-1]
        has_ext = "." in seg and not seg.endswith(".")
        if not is_image_syntax and not has_ext:
            return m.group(0)
        low = path.lower()
        is_voice = bool(_VOICE_LABEL_RE.search(label)) or (
            "/audio_cache/" in low or "/audio/" in low or "/voice" in low
        )
        tag = f"MEDIA:{path}"
        if is_voice:
            tag += " [[audio_as_voice]]"
        return tag

    return _MD_TO_TAG_RE.sub(_sub, text)


def stats() -> dict:
    """Diagnostic: count of live tokens + durable store size. Used by /health."""
    now = time.time()
    live = sum(1 for e in _TOKENS.values() if e.get("expires_at", 0) > now)
    durable = 0
    try:
        durable = sum(1 for _ in _media_store_dir().glob("*") if _.is_file())
    except OSError:
        pass
    return {"tokens_live": live, "tokens_total": len(_TOKENS), "durable_files": durable}
