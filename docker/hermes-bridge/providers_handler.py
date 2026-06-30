"""
providers_handler.py — backend for the AgentBuff /app/providers tab (BYOK).

Surfaces three capabilities the existing bridge did NOT have, WITHOUT modifying
the Hermes engine source:

  1. Model discovery   — HTTP GET <baseUrl>/models (OpenAI-compatible) to list a
                         provider's available model ids using the user's key.
  2. Credential pool   — multi key-per-provider via the `hermes auth` CLI
                         (add / list / remove). Lets users rotate keys.
  3. OAuth login flow  — `hermes auth add <provider> --type oauth --no-browser`
                         spawned as a subprocess; output (login URL + code) is
                         buffered and polled by the UI (start / poll / cancel).
                         `--no-browser` is what makes this work in a headless
                         container — the user opens the printed URL themselves.

Key set/delete + default-model selection are intentionally NOT here: those go
through the existing `config.patch` (models.providers.<id>.apiKey) which the
engine already reads. This module only adds what was missing.

Pure-bridge: every external call (httpx, subprocess) is wrapped defensively so a
failure degrades to a clean error code instead of crashing the bridge.
"""
from __future__ import annotations

import asyncio
import ipaddress
import json
import logging
import os
import re
import socket
import subprocess
import time
import urllib.error
import urllib.request
import uuid
from typing import Any, Optional

log = logging.getLogger("bridge.providers")


# ── SSRF guard (SEC1) ─────────────────────────────────────────────────────
# Any user-supplied base URL (model discovery + custom endpoint) is fetched or
# stored by the bridge with the user's API key in the Authorization header. An
# attacker-chosen host would exfiltrate that key and could reach cloud metadata
# (169.254.169.254), host loopback admin, or private-network services. Validate
# the host resolves ONLY to public IPs before any fetch/store. No allowlist —
# providers come and go — but a hard private/loopback/link-local/reserved deny.
def validate_external_url(url: str) -> Optional[str]:
    """Return None if `url` is a safe public http(s) endpoint, else a short
    Bahasa rejection reason. Resolves the hostname and rejects if ANY resolved
    address is private/loopback/link-local/reserved (blocks SSRF + key exfil)."""
    raw = (url or "").strip()
    if not raw:
        return "URL kosong"
    try:
        from urllib.parse import urlparse
        parsed = urlparse(raw)
    except Exception:  # noqa: BLE001
        return "URL tidak valid"
    if parsed.scheme not in ("http", "https"):
        return "URL harus diawali http:// atau https://"
    host = parsed.hostname
    if not host:
        return "URL tidak punya host"
    # Documented exception: the custom-endpoint feature reaches a user's OWN
    # local LLM server (LM Studio etc) on the Docker host via this gateway name.
    # It resolves to a private gateway IP but is a first-class product feature,
    # so allow it by name. Metadata (169.254.x) is a DIFFERENT host and stays
    # blocked below.
    if host.lower() == "host.docker.internal":
        return None
    # Resolve every address the host maps to; reject if any is non-public.
    try:
        infos = socket.getaddrinfo(host, parsed.port or (443 if parsed.scheme == "https" else 80), proto=socket.IPPROTO_TCP)
    except Exception:  # noqa: BLE001 — unresolvable host
        return "Host tidak dapat di-resolve"
    addrs = {info[4][0] for info in infos}
    if not addrs:
        return "Host tidak dapat di-resolve"
    for addr in addrs:
        try:
            ip = ipaddress.ip_address(addr)
        except ValueError:
            return "Alamat host tidak valid"
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_reserved
            or ip.is_multicast
            or ip.is_unspecified
        ):
            return "URL menunjuk ke alamat internal/privat — tidak diizinkan"
    return None


# ── Brand scrub (hard constraint: 'hermes'/'Hermes' must never reach users) ─
# The engine's own OAuth/env catalogs carry engine-branded strings (cliCommand
# 'hermes auth add …', docsUrl on nousresearch.com / hermes-agent.*, names like
# 'Nous Portal', descriptions mentioning 'hermes model'). We mirror those
# catalogs verbatim, so scrub their user-facing strings here. Allow/deny that
# may drift on an engine bump — re-grep oauthList+envCatalog after every bump.
_AGENTBUFF_DOCS = "https://agentbuff.id/docs"
_BRAND_HOST_RE = re.compile(r"(nousresearch\.com|hermes-agent[\w.-]*)", re.IGNORECASE)
_BRAND_WORD_RE = re.compile(r"\bhermes\b", re.IGNORECASE)


def scrub_brand(text: Optional[str]) -> str:
    """Strip engine brand from a user-facing string. Replaces the 'hermes' token
    + 'Nous Portal' label with neutral copy. Empty/None → ''."""
    s = (text or "")
    if not s:
        return ""
    s = s.replace("Nous Portal", "Nous (Langganan)")
    # 'set via "hermes model"' / 'hermes model' → neutral phrasing.
    s = re.sub(r"\(?set via ['\"]?hermes model['\"]?[^)]*\)?", "(atur via Pengaturan)", s, flags=re.IGNORECASE)
    s = _BRAND_WORD_RE.sub("engine", s)
    return s


def scrub_docs_url(url: Optional[str]) -> str:
    """Rewrite engine-branded docs hosts to the AgentBuff docs; keep neutral
    third-party docs (vendor portals) untouched."""
    u = (url or "").strip()
    if not u:
        return ""
    if _BRAND_HOST_RE.search(u):
        return _AGENTBUFF_DOCS
    return u


def scrub_cli_command(cmd: Optional[str]) -> str:
    """Engine OAuth catalog ships cliCommand 'hermes auth add <id>' — pure engine
    brand. Blank it (the UI has its own tutorials). Keep genuinely 3rd-party,
    non-engine commands the user really must run on their own machine
    (e.g. 'claude setup-token', 'qwen')."""
    c = (cmd or "").strip()
    if not c:
        return ""
    low = c.lower()
    if "hermes" in low or low.startswith("hermes auth"):
        return ""  # engine brand — drop; UI tutorials cover the real steps
    return c


# ── Synthetic provider cards (CAT3/5 — engine routes them but they are NOT in
# OPTIONAL_ENV_VARS, so envCatalog omits them). get_provider() live-confirmed
# these route; we add them so the key grid can offer + setEnv them. Each names
# the CONCRETE engine provider id (never a bare aggregator alias) so a future
# model picker can pin model.provider correctly. ──────────────────────────────
_SYNTHETIC_PROVIDER_CARDS: list[dict[str, Any]] = [
    {"key": "OPENAI_API_KEY", "providerId": "openai-api", "description": "OpenAI (langsung) — GPT", "url": "https://platform.openai.com/api-keys", "category": "popular"},
    {"key": "GROQ_API_KEY", "providerId": "groq", "description": "Groq — inferensi super cepat", "url": "https://console.groq.com/keys", "category": "popular", "free": True},
    {"key": "MISTRAL_API_KEY", "providerId": "mistral", "description": "Mistral AI", "url": "https://console.mistral.ai/api-keys", "category": "popular"},
    {"key": "CEREBRAS_API_KEY", "providerId": "cerebras", "description": "Cerebras — inferensi cepat", "url": "https://cloud.cerebras.ai", "category": "popular", "free": True},
    {"key": "FIREWORKS_API_KEY", "providerId": "fireworks", "description": "Fireworks AI", "url": "https://fireworks.ai/account/api-keys", "category": "popular"},
]

# Category + free-tier metadata joined onto every env card (real + synthetic),
# keyed by the env var name (canonical), so /app can section the grid for
# non-technical users instead of one flat 25-card wall.
_PROVIDER_CATEGORY: dict[str, str] = {
    # popular / global
    "OPENAI_API_KEY": "popular", "GOOGLE_API_KEY": "popular", "GEMINI_API_KEY": "popular",
    "ANTHROPIC_API_KEY": "popular", "DEEPSEEK_API_KEY": "popular", "XAI_API_KEY": "popular",
    "GROQ_API_KEY": "popular", "MISTRAL_API_KEY": "popular", "CEREBRAS_API_KEY": "popular",
    "FIREWORKS_API_KEY": "popular", "OPENROUTER_API_KEY": "popular", "NVIDIA_API_KEY": "popular",
    "HF_TOKEN": "popular", "NOVITA_API_KEY": "popular", "ARCEEAI_API_KEY": "popular",
    "GMI_API_KEY": "popular",
    # regional
    "GLM_API_KEY": "regional", "ZAI_API_KEY": "regional", "Z_AI_API_KEY": "regional",
    "DASHSCOPE_API_KEY": "regional", "KIMI_API_KEY": "regional", "KIMI_CODING_API_KEY": "regional",
    "MINIMAX_API_KEY": "regional", "STEPFUN_API_KEY": "regional", "XIAOMI_API_KEY": "regional",
    "KIMI_CN_API_KEY": "regional", "MINIMAX_CN_API_KEY": "regional", "TOKENHUB_API_KEY": "regional",
    # coding-specialist
    "ALIBABA_CODING_PLAN_API_KEY": "coding", "KILOCODE_API_KEY": "coding",
    "OPENCODE_ZEN_API_KEY": "coding", "OPENCODE_GO_API_KEY": "coding",
    "COPILOT_GITHUB_TOKEN": "coding",
    # self-hosted / local
    "OLLAMA_API_KEY": "selfhosted", "LM_API_KEY": "selfhosted",
    # advanced / custom
    "AZURE_FOUNDRY_API_KEY": "custom", "CUSTOM_API_KEY": "custom",
}
# Free-tier providers — surface a green "Ada Tier Gratis" pill for awam users.
_FREE_PROVIDERS: set[str] = {"GOOGLE_API_KEY", "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY"}

# ── Provider catalog ──────────────────────────────────────────────────────
# id            : engine provider id (matches config.yaml models.providers.<id>
#                 and `hermes auth` provider arg)
# displayName   : human label (UI shows this; Bahasa polish happens client-side)
# envKeys       : env var names the engine reads for this provider's key
# baseUrl       : OpenAI-compatible base for model discovery ("" = no discovery)
# placeholder   : key format hint
# docsUrl       : where to get a key
# discover      : True if <baseUrl>/models works (OpenAI-compatible)
PROVIDER_CATALOG: list[dict[str, Any]] = [
    {"id": "google", "displayName": "Google · Gemini", "envKeys": ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
     "baseUrl": "https://generativelanguage.googleapis.com/v1beta/openai", "placeholder": "AIza...",
     "docsUrl": "https://aistudio.google.com/apikey", "discover": True, "free": True},
    {"id": "openai", "displayName": "OpenAI", "envKeys": ["OPENAI_API_KEY"],
     "baseUrl": "https://api.openai.com/v1", "placeholder": "sk-...",
     "docsUrl": "https://platform.openai.com/api-keys", "discover": True},
    {"id": "anthropic", "displayName": "Anthropic · Claude", "envKeys": ["ANTHROPIC_API_KEY"],
     "baseUrl": "https://api.anthropic.com/v1", "placeholder": "sk-ant-...",
     "docsUrl": "https://console.anthropic.com/settings/keys", "discover": True},
    {"id": "openrouter", "displayName": "OpenRouter", "envKeys": ["OPENROUTER_API_KEY"],
     "baseUrl": "https://openrouter.ai/api/v1", "placeholder": "sk-or-...",
     "docsUrl": "https://openrouter.ai/keys", "discover": True},
    {"id": "groq", "displayName": "Groq", "envKeys": ["GROQ_API_KEY"],
     "baseUrl": "https://api.groq.com/openai/v1", "placeholder": "gsk_...",
     "docsUrl": "https://console.groq.com/keys", "discover": True, "free": True},
    {"id": "deepseek", "displayName": "DeepSeek", "envKeys": ["DEEPSEEK_API_KEY"],
     "baseUrl": "https://api.deepseek.com/v1", "placeholder": "sk-...",
     "docsUrl": "https://platform.deepseek.com/api_keys", "discover": True},
    {"id": "xai", "displayName": "xAI · Grok", "envKeys": ["XAI_API_KEY", "GROK_API_KEY"],
     "baseUrl": "https://api.x.ai/v1", "placeholder": "xai-...",
     "docsUrl": "https://console.x.ai", "discover": True},
    {"id": "mistral", "displayName": "Mistral", "envKeys": ["MISTRAL_API_KEY"],
     "baseUrl": "https://api.mistral.ai/v1", "placeholder": "...",
     "docsUrl": "https://console.mistral.ai/api-keys", "discover": True},
    {"id": "kimi", "displayName": "Kimi · Moonshot", "envKeys": ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
     "baseUrl": "https://api.moonshot.ai/v1", "placeholder": "sk-...",
     "docsUrl": "https://platform.moonshot.ai/console/api-keys", "discover": True},
    {"id": "qwen", "displayName": "Qwen · DashScope", "envKeys": ["DASHSCOPE_API_KEY", "QWEN_API_KEY"],
     "baseUrl": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "placeholder": "sk-...",
     "docsUrl": "https://bailian.console.alibabacloud.com", "discover": True},
    {"id": "minimax", "displayName": "MiniMax", "envKeys": ["MINIMAX_API_KEY"],
     "baseUrl": "https://api.minimax.io/v1", "placeholder": "...",
     "docsUrl": "https://www.minimax.io/platform", "discover": True},
    {"id": "zhipu", "displayName": "Zhipu · GLM", "envKeys": ["ZHIPUAI_API_KEY", "GLM_API_KEY"],
     "baseUrl": "https://open.bigmodel.cn/api/paas/v4", "placeholder": "...",
     "docsUrl": "https://open.bigmodel.cn", "discover": True},
    {"id": "cerebras", "displayName": "Cerebras", "envKeys": ["CEREBRAS_API_KEY"],
     "baseUrl": "https://api.cerebras.ai/v1", "placeholder": "csk-...",
     "docsUrl": "https://cloud.cerebras.ai", "discover": True, "free": True},
    {"id": "fireworks", "displayName": "Fireworks", "envKeys": ["FIREWORKS_API_KEY"],
     "baseUrl": "https://api.fireworks.ai/inference/v1", "placeholder": "fw_...",
     "docsUrl": "https://fireworks.ai/account/api-keys", "discover": True},
    {"id": "together", "displayName": "Together", "envKeys": ["TOGETHER_API_KEY"],
     "baseUrl": "https://api.together.xyz/v1", "placeholder": "...",
     "docsUrl": "https://api.together.ai/settings/api-keys", "discover": True},
    {"id": "deepgram", "displayName": "Deepgram · STT", "envKeys": ["DEEPGRAM_API_KEY"],
     "baseUrl": "", "placeholder": "...",
     "docsUrl": "https://console.deepgram.com", "discover": False},
    {"id": "custom", "displayName": "Custom (OpenAI-compatible)", "envKeys": ["CUSTOM_API_KEY"],
     "baseUrl": "", "placeholder": "...", "docsUrl": "", "discover": True, "custom": True},
]

# OAuth providers — ONLY device-code flows are listed, because AgentBuff runs the
# engine in a remote container. Verified LIVE 2026-06-02:
#   - DEVICE-CODE (works remotely: user opens URL + enters code; CLI polls):
#       openai-codex (oauth_external, prints device code) ✓
#       minimax-oauth (oauth_minimax, user_code grant)    ✓
#   - LOOPBACK (REMOVED — cannot complete remotely: CLI binds 127.0.0.1:PORT
#     callback INSIDE the container; the provider redirects the user's browser to
#     127.0.0.1 = the USER's machine, not the container → callback never arrives):
#       xai-oauth (binds /callback server)          ✗ removed
#       google-gemini-cli (redirect 127.0.0.1:8085) ✗ removed
#   - qwen-oauth removed earlier (needs external `qwen` CLI authed first).
# flow:
#   "device"   = user opens URL + enters a code; CLI polls (no callback needed).
#   "loopback" = provider redirects to an in-container 127.0.0.1 callback. The
#                user's browser can't reach it, so we use a manual relay: user
#                pastes the redirect URL/code back and the BRIDGE replays it to
#                the in-container callback server (proven reachable). Verified.
OAUTH_PROVIDERS: list[dict[str, str]] = [
    {"id": "openai-codex", "displayName": "ChatGPT (Codex / Plus)", "flow": "device"},
    {"id": "minimax-oauth", "displayName": "MiniMax", "flow": "device"},
    {"id": "google-gemini-cli", "displayName": "Gemini (langganan Google)", "flow": "loopback"},
    {"id": "xai-oauth", "displayName": "xAI · Grok (langganan)", "flow": "loopback"},
]

_CATALOG_BY_ID = {p["id"]: p for p in PROVIDER_CATALOG}

# Providers whose key can ALSO go into the rotating credential pool via
# `hermes auth add` (VERIFIED LIVE 2026-06-02 — others return "Unknown
# provider"). Maps catalog id → the hermes-auth provider id. Providers NOT in
# this map support only a single key via .env (the API-key grid).
POOL_ID: dict[str, str] = {
    "google": "gemini",
    "anthropic": "anthropic",
    "openrouter": "openrouter",
    "deepseek": "deepseek",
    "xai": "xai",
    "minimax": "minimax",
    "zhipu": "zai",
}


def get_catalog() -> dict[str, Any]:
    """Static catalog for the UI. Each provider gets a `poolId` (null if the
    provider can't be added to the credential pool)."""
    providers = [{**p, "poolId": POOL_ID.get(p["id"])} for p in PROVIDER_CATALOG]
    return {"providers": providers, "oauth": OAUTH_PROVIDERS}


# ── Key validity check (after a user saves a key) ─────────────────────────
# OpenAI-compatible base per env var → GET <base>/models with the saved key.
# 200 = valid, 401/403 = invalid. The engine has no dedicated "is this key
# valid" RPC, so we use the same models-list probe the discover path uses; this
# map covers the providers whose endpoint speaks the OpenAI /models shape.
_PROVIDER_BASE_BY_ENV: dict[str, str] = {
    "OPENAI_API_KEY": "https://api.openai.com/v1",
    "GOOGLE_API_KEY": "https://generativelanguage.googleapis.com/v1beta/openai",
    "GEMINI_API_KEY": "https://generativelanguage.googleapis.com/v1beta/openai",
    "ANTHROPIC_API_KEY": "https://api.anthropic.com/v1",
    "DEEPSEEK_API_KEY": "https://api.deepseek.com/v1",
    "XAI_API_KEY": "https://api.x.ai/v1",
    "GROQ_API_KEY": "https://api.groq.com/openai/v1",
    "MISTRAL_API_KEY": "https://api.mistral.ai/v1",
    "CEREBRAS_API_KEY": "https://api.cerebras.ai/v1",
    "FIREWORKS_API_KEY": "https://api.fireworks.ai/inference/v1",
    "OPENROUTER_API_KEY": "https://openrouter.ai/api/v1",
    "DASHSCOPE_API_KEY": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    "GLM_API_KEY": "https://api.z.ai/api/paas/v4",
    "ZAI_API_KEY": "https://api.z.ai/api/paas/v4",
    "KIMI_API_KEY": "https://api.moonshot.ai/v1",
    "KIMI_CODING_API_KEY": "https://api.moonshot.ai/v1",
    "MINIMAX_API_KEY": "https://api.minimax.io/v1",
    "NVIDIA_API_KEY": "https://integrate.api.nvidia.com/v1",
    "HF_TOKEN": "https://router.huggingface.co/v1",
    "NOVITA_API_KEY": "https://api.novita.ai/openai/v1",
    "OLLAMA_API_KEY": "https://ollama.com/v1",
    "ARCEEAI_API_KEY": "https://api.arcee.ai/api/v1",
    "GMI_API_KEY": "https://api.gmi-serving.com/v1",
    "OPENCODE_ZEN_API_KEY": "https://opencode.ai/zen/v1",
    "KILOCODE_API_KEY": "https://api.kilo.ai/api/gateway",
}


async def test_key(env_key: str) -> dict[str, Any]:
    """Validate the saved key for `env_key` by calling the provider's
    OpenAI-compatible /models. Returns {status, modelCount?, message?} where
    status ∈ valid | invalid | no-key | unsupported | error."""
    name = (env_key or "").strip()
    base = _PROVIDER_BASE_BY_ENV.get(name)
    if not base:
        # No known endpoint to probe (regional/custom) — can't auto-validate.
        return {"status": "unsupported"}
    # Read the saved key from the engine's .env (never trust a client-sent key).
    try:
        from hermes_cli.config import load_env
        env = load_env() or {}
    except Exception:  # noqa: BLE001
        env = {}
    key = (env.get(name) or os.environ.get(name) or "").strip()
    if not key:
        return {"status": "no-key"}
    ssrf = validate_external_url(base)
    if ssrf:
        return {"status": "error", "message": ssrf}
    url = f"{base.rstrip('/')}/models"
    headers = {"Authorization": f"Bearer {key}"}
    if name == "ANTHROPIC_API_KEY":
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
    try:
        import httpx
        async with httpx.AsyncClient(timeout=12.0) as client:
            resp = await client.get(url, headers=headers)
    except Exception as e:  # noqa: BLE001
        log.warning("test_key %s failed: %s", name, e)
        return {"status": "error", "message": "Tidak bisa menghubungi penyedia"}
    if resp.status_code in (401, 403):
        return {"status": "invalid"}
    if resp.status_code >= 400:
        # Some providers reject /models but the key may still be fine — report
        # softly rather than claiming the key is invalid.
        return {"status": "error", "message": f"HTTP {resp.status_code}"}
    count = None
    try:
        data = resp.json()
        rows = data.get("data") if isinstance(data, dict) else None
        if isinstance(rows, list):
            count = len(rows)
    except Exception:  # noqa: BLE001
        pass
    return {"status": "valid", "modelCount": count}


# ── Key storage = .env (canonical engine path) ────────────────────────────
# Hermes' provider-check (`_has_any_provider_configured`, hermes_cli/main.py)
# reads ONLY env vars — a key in config.yaml is NOT enough. So we write the
# registry env var (GEMINI_API_KEY, OPENAI_API_KEY, ...) to ~/.hermes/.env via
# the bridge's atomic writer, set it in this process's env (so authStatus +
# discovery see it instantly), and the caller restarts the engine subprocess so
# the running agent picks it up. This is EXACTLY how the working seeded key is
# stored — guaranteed-consumed.


def set_key(provider_id: str, api_key: str) -> dict[str, Any]:
    entry = _CATALOG_BY_ID.get(provider_id)
    if not entry:
        return {"ok": False, "error": f"unknown provider {provider_id}"}
    env_keys = entry.get("envKeys", [])
    if not env_keys:
        return {"ok": False, "error": f"no env key for {provider_id}"}
    key = (api_key or "").strip()
    if not key:
        return {"ok": False, "error": "empty key"}
    try:
        from channels_handler import _write_env_values
        # Write the primary env var; also write aliases (e.g. GOOGLE_API_KEY +
        # GEMINI_API_KEY) so whichever the engine reads first is satisfied.
        _write_env_values({k: key for k in env_keys})
        for k in env_keys:
            os.environ[k] = key
    except Exception as e:  # noqa: BLE001
        log.exception("set_key %s failed", provider_id)
        return {"ok": False, "error": str(e)[:200]}
    return {"ok": True, "envKeys": env_keys}


def delete_key(provider_id: str) -> dict[str, Any]:
    entry = _CATALOG_BY_ID.get(provider_id)
    if not entry:
        return {"ok": False, "error": f"unknown provider {provider_id}"}
    env_keys = entry.get("envKeys", [])
    try:
        from channels_handler import _remove_env_values
        _remove_env_values(list(env_keys))
        for k in env_keys:
            os.environ.pop(k, None)
    except Exception as e:  # noqa: BLE001
        log.exception("delete_key %s failed", provider_id)
        return {"ok": False, "error": str(e)[:200]}
    return {"ok": True, "envKeys": env_keys}


def _read_dotenv_file() -> dict[str, str]:
    """Read ~/.hermes/.env into a dict. Keys live in .env (not always in the
    bridge process os.environ), so discovery must consult the file too — same
    source authStatus reads."""
    out: dict[str, str] = {}
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    path = os.path.join(home, ".env")
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                out[k.strip()] = v.strip().strip('"').strip("'")
    except Exception:  # noqa: BLE001
        pass
    return out


def _resolve_key(provider_id: str, override: Optional[str]) -> Optional[str]:
    if override:
        return override.strip()
    entry = _CATALOG_BY_ID.get(provider_id)
    if not entry:
        return None
    dotenv = _read_dotenv_file()
    for env_key in entry.get("envKeys", []):
        # process env first, then the .env file (where user keys actually live)
        val = os.environ.get(env_key) or dotenv.get(env_key)
        if val:
            return val.strip()
    return None


# ── 1. Model discovery ────────────────────────────────────────────────────
async def discover_models(
    provider_id: str,
    base_url: Optional[str] = None,
    api_key: Optional[str] = None,
) -> dict[str, Any]:
    """GET <base>/models on an OpenAI-compatible endpoint → list model ids.

    Returns {status, models, count}. status ∈
      ok | no-key | unsupported | unknown-host | error
    """
    entry = _CATALOG_BY_ID.get(provider_id)
    if entry is None:
        return {"status": "error", "models": [], "count": 0, "message": "unknown provider"}
    if not entry.get("discover"):
        return {"status": "unsupported", "models": [], "count": 0}

    base = (base_url or entry.get("baseUrl") or "").strip().rstrip("/")
    if not base:
        return {"status": "unknown-host", "models": [], "count": 0}

    # SEC1 — SSRF guard: the user's key rides in the Authorization header, so a
    # private/loopback/metadata host would exfiltrate it. Reject before fetch.
    ssrf = validate_external_url(base)
    if ssrf:
        return {"status": "error", "models": [], "count": 0, "message": ssrf}

    key = _resolve_key(provider_id, api_key)
    if not key:
        return {"status": "no-key", "models": [], "count": 0}

    url = f"{base}/models"
    headers = {"Authorization": f"Bearer {key}"}
    # Anthropic uses x-api-key + a version header instead of Bearer.
    if provider_id == "anthropic":
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}

    try:
        import httpx
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.get(url, headers=headers)
    except Exception as e:  # noqa: BLE001 — network errors degrade cleanly
        log.warning("discover %s failed: %s", provider_id, e)
        return {"status": "error", "models": [], "count": 0, "message": str(e)[:200]}

    if resp.status_code in (401, 403):
        return {"status": "no-key", "models": [], "count": 0}
    if resp.status_code >= 400:
        return {"status": "error", "models": [], "count": 0,
                "message": f"HTTP {resp.status_code}"}

    try:
        data = resp.json()
    except Exception:
        return {"status": "error", "models": [], "count": 0, "message": "bad json"}

    ids: list[str] = []
    rows = data.get("data") if isinstance(data, dict) else None
    if isinstance(rows, list):
        for row in rows:
            mid = row.get("id") if isinstance(row, dict) else None
            if isinstance(mid, str) and mid:
                ids.append(mid)
    # Gemini openai-compat sometimes returns "models" list of {name}
    if not ids and isinstance(data, dict) and isinstance(data.get("models"), list):
        for row in data["models"]:
            mid = row.get("id") or row.get("name") if isinstance(row, dict) else None
            if isinstance(mid, str) and mid:
                ids.append(mid.split("/")[-1])

    ids = sorted(set(ids))
    return {"status": "ok", "models": ids, "count": len(ids)}


# ── 2. Credential pool via `hermes auth` CLI ──────────────────────────────
def _run_hermes_auth(args: list[str], timeout: float = 30.0) -> tuple[int, str, str]:
    """Run `hermes auth <args>` synchronously. Returns (rc, stdout, stderr)."""
    try:
        proc = subprocess.run(
            ["hermes", "auth", *args],
            capture_output=True, text=True, timeout=timeout,
            env={**os.environ},
        )
        return proc.returncode, proc.stdout or "", proc.stderr or ""
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"
    except FileNotFoundError:
        # SEC4 — neutral string (this stderr can surface to the user).
        return 127, "", "Layanan engine tidak tersedia"
    except Exception as e:  # noqa: BLE001
        return 1, "", str(e)


# Parses lines like:
#   gemini (1 credentials):
#     #1  GEMINI_API_KEY       api_key env:GEMINI_API_KEY ←
_POOL_HEADER_RE = re.compile(r"^(\S+)\s+\((\d+)\s+credential")
_POOL_ROW_RE = re.compile(r"^\s*#(\d+)\s+(\S+)\s+(\S+)(.*)$")


# Short-TTL cache for pool_list. `hermes auth list` spawns a CLI subprocess
# (~900ms cold start) — the providers tab + its TanStack polling called it on
# every mount/refetch, so each open stalled ~1s. The credential pool only
# changes on add/remove/oauth-complete, all of which invalidate this cache, so
# a small TTL is safe and makes repeat opens instant.
_POOL_CACHE: dict[str, Any] = {}  # provider-key -> (ts, result)
# Long TTL: the credential pool only changes via add/remove/oauth (all of which
# call invalidate_pool_cache()), so a stale window only matters for out-of-band
# CLI edits. 5 min keeps the Providers tab instant (the ~900ms `hermes auth`
# subprocess is paid at most once per 5 min idle instead of on every focus).
_POOL_CACHE_TTL = 300.0


def invalidate_pool_cache() -> None:
    """Drop the pool_list cache (call after any add/remove/oauth mutation)."""
    _POOL_CACHE.clear()


def pool_list(provider: Optional[str] = None, *, use_cache: bool = True) -> dict[str, Any]:
    import time as _t

    ck = provider or "__all__"
    if use_cache:
        hit = _POOL_CACHE.get(ck)
        if hit and (_t.time() - hit[0]) < _POOL_CACHE_TTL:
            return hit[1]
    result = _pool_list_uncached(provider)
    # Only cache successful reads (don't pin a transient error).
    if "error" not in result:
        _POOL_CACHE[ck] = (_t.time(), result)
    return result


def _pool_list_uncached(provider: Optional[str] = None) -> dict[str, Any]:
    args = ["list"]
    if provider:
        args.append(provider)
    rc, out, err = _run_hermes_auth(args)
    if rc != 0 and not out:
        return {"pools": {}, "error": (err or "auth list failed").strip()[:200]}
    pools: dict[str, list[dict[str, Any]]] = {}
    current: Optional[str] = None
    for raw in out.splitlines():
        line = raw.rstrip()
        if not line.strip():
            continue
        mh = _POOL_HEADER_RE.match(line.strip())
        if mh:
            current = mh.group(1)
            pools.setdefault(current, [])
            continue
        mr = _POOL_ROW_RE.match(line)
        if mr and current is not None:
            idx, label, ktype, rest = mr.groups()
            active = "←" in rest
            source = ""
            sm = re.search(r"(env:\S+|file|oauth|api_key)", rest)
            if sm:
                source = sm.group(1)
            pools[current].append({
                "index": int(idx), "label": label, "type": ktype,
                "active": active, "source": source.strip(),
            })
    return {"pools": pools}


def pool_add(provider: str, api_key: str, label: Optional[str] = None) -> dict[str, Any]:
    if not provider or not api_key:
        return {"ok": False, "error": "provider and apiKey required"}
    # Map catalog id → hermes-auth id; reject providers that don't support pooling.
    auth_id = POOL_ID.get(provider, provider if provider in POOL_ID.values() else None)
    if not auth_id:
        return {"ok": False, "error": f"Provider '{provider}' tidak mendukung pool kredensial — pakai grid Kunci API."}
    provider = auth_id
    args = ["add", provider, "--type", "api-key", "--api-key", api_key]
    if label:
        args += ["--label", label]
    rc, out, err = _run_hermes_auth(args, timeout=45.0)
    if rc != 0:
        return {"ok": False, "error": (err or out or "add failed").strip()[:300]}
    invalidate_pool_cache()
    return {"ok": True, "message": (out or "added").strip()[:300]}


def pool_remove(provider: str, selector: str) -> dict[str, Any]:
    if not provider or not selector:
        return {"ok": False, "error": "provider and selector required"}
    rc, out, err = _run_hermes_auth(["remove", provider, str(selector)], timeout=30.0)
    if rc != 0:
        return {"ok": False, "error": (err or out or "remove failed").strip()[:300]}
    invalidate_pool_cache()
    return {"ok": True, "message": (out or "removed").strip()[:300]}


# ── 3. OAuth login flow (subprocess + poll) ───────────────────────────────
_ANSI_RE = re.compile(r"\x1b\[[0-9;]*m")  # strip terminal color codes
_URL_RE = re.compile(r"https?://[^\s'\"<>]+")
# Device-code user code: from `user_code=ABCD-1234` in the verify URL, or a
# bare "enter code: ABCD-1234" / "code: ABCD-1234" prompt line.
_USER_CODE_URL_RE = re.compile(r"user_code=([A-Za-z0-9][A-Za-z0-9\-]{3,})")
_USER_CODE_LINE_RE = re.compile(r"(?:enter|your)?\s*code:?\s*([A-Z0-9]{3,}-[A-Z0-9]{3,})", re.IGNORECASE)
# Some CLIs (OpenAI Codex) print the label and the code on SEPARATE lines:
#     2. Enter this code:
#        OPXG-ZUAXF
# so neither regex above matches (no user_code= in the /device URL, and the
# code line carries no 'code' label). _BARE_CODE_RE catches a dashed/grouped
# code standing ALONE on its line; _CODE_PROMPT_RE recognises the label line
# that precedes it so the next bare line is captured even before the URL.
_BARE_CODE_RE = re.compile(r"^\s*([A-Z0-9]{3,6}(?:-[A-Z0-9]{3,6})+)\s*$")
_CODE_PROMPT_RE = re.compile(
    r"\b(?:enter (?:this|the) code|your code|device code|code)\b\s*:?\s*$",
    re.IGNORECASE,
)


def _strip_ansi(s: str) -> str:
    return _ANSI_RE.sub("", s)


# SECURITY: scrub long token VALUES from OAuth subprocess output before it's
# buffered/shown in the UI — defense in depth in case a CLI ever echoes a token
# on stdout. Preserves the login URL + short device codes (which the user needs).
_TOKEN_VALUE_RE = re.compile(
    r"((?:access_token|refresh_token|id_token|api[_-]?key|client_secret|bearer)[\"':=\s]+)([A-Za-z0-9._\-/+~]{12,})",
    re.IGNORECASE,
)


def _scrub_secret_line(line: str) -> str:
    return _TOKEN_VALUE_RE.sub(lambda m: m.group(1) + "__REDACTED__", line)


# Lines that look like a Python traceback / internal stack frame — never shown
# to the user (leaks file paths, line numbers, internal fn names + looks scary).
_NOISE_LINE_RE = re.compile(
    r"^\s*(Traceback \(most recent|File \"|\^{3,}|raise\b|"
    r"[A-Za-z_][A-Za-z0-9_.]*Error[:\(]|sys\.exit|args\.func|.*\bline \d+, in )",
)


def _is_noise_line(line: str) -> bool:
    return bool(_NOISE_LINE_RE.search(line or ""))


def _classify_oauth_error(lines: list, rc: int) -> str:
    """Turn a failed OAuth-login subprocess output into ONE clean Bahasa message
    (never a raw traceback). Inspects the buffered lines for the real cause."""
    blob = "\n".join(lines or []).lower()
    if "429" in blob or "rate limit" in blob or "too many" in blob:
        return ("🚦 OpenAI membatasi permintaan login (terlalu sering dalam waktu "
                "singkat). Tunggu ~10–15 menit, lalu coba login lagi.")
    if ("device" in blob and "code" in blob and
            any(k in blob for k in ("enable", "not enabled", "disabled", "aktifkan", "settings", "security"))):
        return ("🔐 Aktifkan dulu 'otorisasi kode perangkat untuk Codex' di "
                "ChatGPT → Settings → Security, lalu coba login lagi.")
    if any(k in blob for k in ("expired", "timed out", "timeout")):
        return "⏳ Kode perangkat kedaluwarsa. Mulai login lagi untuk kode baru."
    if any(k in blob for k in ("403", "forbidden", "unauthorized", "not entitled", "no access", "subscription", "plan")):
        return ("🔒 Akun ditolak. Pastikan akun ChatGPT-mu punya akses Codex "
                "(termasuk di langganan ChatGPT Plus/Pro/Team kamu).")
    if "401" in blob or "invalid" in blob:
        return "🔑 Kredensial ditolak. Tutup lalu mulai login lagi."
    # NOTE: never push paid API keys here — OAuth users are logging in with an
    # existing subscription; suggesting they buy a key would be the wrong advice.
    return "⚠️ Login belum berhasil. Tutup dialog ini lalu coba mulai login lagi."


class OAuthManager:
    """Spawns `hermes auth add <provider> --type oauth --no-browser` and buffers
    its output so the UI can poll for the login URL + completion status."""

    def __init__(self) -> None:
        self._flows: dict[str, dict[str, Any]] = {}
        self._lock = asyncio.Lock()

    async def start(self, provider: str, timeout: int = 300) -> dict[str, Any]:
        if not provider:
            raise ValueError("provider required")
        flow_id = uuid.uuid4().hex[:12]
        try:
            proc = subprocess.Popen(
                ["hermes", "auth", "add", provider, "--type", "oauth",
                 "--no-browser", "--timeout", str(timeout)],
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, env={**os.environ},
            )
        except FileNotFoundError:
            raise RuntimeError("Layanan engine tidak tersedia")
        flow = {
            "proc": proc, "provider": provider, "lines": [], "status": "running",
            "url": None, "error": None, "started": time.time(),
            "callback_url": None, "state": None,
            # mode is discovered from the subprocess output:
            #   "device"      → URL + user_code, CLI self-polls (no user input)
            #   "paste_stdin" → CLI prints URL then waits on STDIN for the code
            #   "loopback"    → CLI binds 127.0.0.1 callback; relay via HTTP
            "mode": None, "user_code": None,
        }
        self._flows[flow_id] = flow
        asyncio.get_event_loop().run_in_executor(None, self._pump, flow_id)
        return {"flowId": flow_id, "provider": provider}

    def _pump(self, flow_id: str) -> None:
        flow = self._flows.get(flow_id)
        if not flow:
            return
        proc = flow["proc"]
        try:
            for raw in iter(proc.stdout.readline, ""):
                line = _scrub_secret_line(_strip_ansi(raw.rstrip("\n")))
                # Keep ALL lines in the buffer (the error classifier needs the
                # full output, e.g. the "...status 429" frame). Traceback/stack
                # noise is filtered out at DISPLAY time in poll() so it never
                # reaches the UI but classification still sees it.
                if line:
                    flow["lines"].append(line)
                    self._absorb_line(flow, line)
                if len(flow["lines"]) > 500:
                    flow["lines"] = flow["lines"][-500:]
        except Exception as e:  # noqa: BLE001
            flow["lines"].append(f"[stream error] {e}")
        rc = proc.wait()
        if flow["status"] == "running":
            if rc == 0:
                flow["status"] = "success"
            else:
                flow["status"] = "error"
                # Clean, classified Bahasa message — NEVER the raw output/traceback.
                flow["error"] = _classify_oauth_error(flow["lines"], rc)

    @staticmethod
    def _url_score(u: Optional[str]) -> int:
        """Rank candidate URLs so the device-VERIFY url (with user_code) wins
        over an authorize url, which wins over a bare base/portal url."""
        if not u:
            return -1
        ul = u.lower()
        if "user_code=" in ul:
            return 3
        if "authorize" in ul or "/oauth" in ul:
            return 2
        return 1

    def _absorb_line(self, flow: dict, line: str) -> None:
        """Extract URL / user_code / flow mode from one subprocess output line.

        Fixes the prior bug where the FIRST url (a bare 'Portal:' base url) was
        locked in, hiding the real device-verify url + user code, and where
        anthropic's remote redirect_uri was mis-read as a loopback callback."""
        import urllib.parse as _up

        low = line.lower()

        # 1. Device user code, in priority:
        #    (a) user_code=XXXX inside a URL (verification_uri_complete)
        #    (b) inline "enter this code: XXXX-YYYY"
        #    (c) a bare code on its OWN line — right after an "enter this code"
        #        prompt line, OR once we already know this is a device flow.
        #        OpenAI Codex prints the label and code on SEPARATE lines, so
        #        (a)+(b) miss it; (c) is what makes the code box appear.
        if flow.get("user_code") is None:
            mu = _USER_CODE_URL_RE.search(line) or _USER_CODE_LINE_RE.search(line)
            if mu:
                flow["user_code"] = mu.group(1)
                flow["_expect_code"] = False
                if not flow.get("mode"):
                    flow["mode"] = "device"
            else:
                bare = _BARE_CODE_RE.match(line)
                if bare and (flow.get("_expect_code") or flow.get("mode") == "device"):
                    flow["user_code"] = bare.group(1)
                    flow["_expect_code"] = False
                    if not flow.get("mode"):
                        flow["mode"] = "device"

        # Remember a standalone "enter this code" / "code:" prompt so the bare
        # code on the FOLLOWING line is captured even before the /device URL.
        if flow.get("user_code") is None and _CODE_PROMPT_RE.search(line):
            flow["_expect_code"] = True

        # 2. Best URL — upgrade to a higher-scoring candidate as it appears.
        m = _URL_RE.search(line)
        if m:
            url = m.group(0).rstrip(".,)")
            if self._url_score(url) > self._url_score(flow.get("url")):
                flow["url"] = url
                # A '/device' verification URL (e.g. auth.openai.com/codex/device)
                # is a device-code flow even without a user_code= query param.
                if "/device" in url.lower() and flow.get("mode") not in (
                    "paste_stdin", "loopback"):
                    flow["mode"] = "device"
                try:
                    qs = _up.parse_qs(_up.urlparse(url).query)
                    if qs.get("state"):
                        flow["state"] = qs["state"][0]
                    ru = (qs.get("redirect_uri") or [None])[0]
                    # Loopback ONLY when the redirect target is a LOCAL callback
                    # the bridge can reach. A remote redirect (e.g.
                    # console.anthropic.com) is a paste-code flow, not loopback.
                    if ru and ("127.0.0.1" in ru or "localhost" in ru):
                        flow["callback_url"] = ru
                        flow["mode"] = "loopback"
                except Exception:  # noqa: BLE001
                    pass

        # 3. Mode hints from prompt lines (only if not already loopback).
        if flow.get("mode") != "loopback":
            if ("authorization code:" in low or "paste it below" in low
                    or "paste the code" in low or "paste the authorization" in low):
                flow["mode"] = "paste_stdin"
            elif ("waiting for approval" in low or "polling" in low) and not flow.get("mode"):
                flow["mode"] = "device"

    def poll(self, flow_id: str, cursor: int = 0) -> dict[str, Any]:
        flow = self._flows.get(flow_id)
        if not flow:
            return {"status": "error", "error": "unknown flow", "lines": [], "cursor": 0}
        lines = flow["lines"]
        new = lines[cursor:] if cursor < len(lines) else []
        # Strip Python tracebacks / stack frames from what the UI shows — they
        # leak file paths + internals and look alarming. The cursor still
        # advances past them (no re-send); the cause is in the classified error.
        new = [ln for ln in new if not _is_noise_line(ln)]
        mode = flow.get("mode")
        # The UI must collect a pasted code when the CLI waits on stdin
        # (paste_stdin, e.g. anthropic) OR a loopback redirect must be relayed.
        needs_input = mode in ("paste_stdin", "loopback")
        return {
            "status": flow["status"], "url": flow["url"], "error": flow["error"],
            "lines": new, "cursor": len(lines),
            "mode": mode,
            "userCode": flow.get("user_code"),
            "needsInput": needs_input,
            # legacy alias kept for older clients
            "callbackReady": bool(flow.get("callback_url")),
        }

    def relay(self, flow_id: str, pasted: str) -> dict[str, Any]:
        """Complete a flow that needs the user-pasted code.

        Two completion paths:
          - paste_stdin (e.g. anthropic): the CLI is blocked on input() — write
            the code to its STDIN. The subprocess exchanges it → token.
          - loopback (e.g. xai/gemini-cli): replay the redirect URL/code to the
            in-container callback server the user's browser couldn't reach.
        """
        flow = self._flows.get(flow_id)
        if not flow:
            return {"ok": False, "error": "unknown flow"}
        text = (pasted or "").strip()
        if not text:
            return {"ok": False, "error": "empty input"}

        # ── paste_stdin: feed the code to the waiting CLI's stdin ──────────
        if flow.get("mode") == "paste_stdin" or not flow.get("callback_url"):
            import urllib.parse as up
            code = text
            # If the user pasted a full URL, pull ?code= out of it.
            if "://" in text or "code=" in text:
                try:
                    qs = up.parse_qs(up.urlparse(text).query)
                    if qs.get("code"):
                        code = qs["code"][0]
                except Exception:  # noqa: BLE001
                    pass
            proc = flow.get("proc")
            if proc is None or proc.stdin is None:
                return {"ok": False, "error": "flow not accepting input"}
            try:
                proc.stdin.write(code + "\n")
                proc.stdin.flush()
            except Exception as e:  # noqa: BLE001
                return {"ok": False, "error": f"stdin write failed: {str(e)[:160]}"}
            return {"ok": True}

        # ── loopback: replay to the in-container callback server ───────────
        cb = flow.get("callback_url")
        if not cb:
            return {"ok": False, "error": "flow has no loopback callback"}
        import urllib.parse as up
        code = None
        state = flow.get("state")
        # Accept either the full redirect URL or a bare code.
        if "://" in text or text.startswith("/") or "code=" in text:
            try:
                qs = up.parse_qs(up.urlparse(text).query)
                if qs.get("code"):
                    code = qs["code"][0]
                if qs.get("state"):
                    state = qs["state"][0]
            except Exception:  # noqa: BLE001
                pass
        if not code:
            code = text  # treat the whole paste as the code
        target = f"{cb}?code={up.quote(code)}"
        if state:
            target += f"&state={up.quote(state)}"
        try:
            req = urllib.request.Request(target, method="GET")
            with urllib.request.urlopen(req, timeout=15) as resp:
                resp.read()
        except urllib.error.HTTPError as e:
            # The callback server processed it (any HTTP status). The subprocess
            # decides success/error; the pump + poll will report it.
            log.info("oauth relay HTTP %s (server processed)", e.code)
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": f"relay failed: {str(e)[:160]}"}
        return {"ok": True}

    def cancel(self, flow_id: str) -> dict[str, Any]:
        flow = self._flows.get(flow_id)
        if not flow:
            return {"ok": True}
        proc = flow["proc"]
        try:
            if proc.poll() is None:
                proc.terminate()
                try:
                    proc.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    proc.kill()
        except Exception:  # noqa: BLE001
            pass
        flow["status"] = "cancelled"
        return {"ok": True}


# Process-wide singleton.
OAUTH_MANAGER = OAuthManager()


# ── Engine-canonical mirror (anti-drift) ──────────────────────────────────
# The bridge lives in the same container as the engine, so it imports the
# engine's OWN provider registries directly. /app/providers renders from these
# → it can NEVER drift from the engine's /env page; whatever providers the
# engine supports show up automatically with the correct flow + live status.

def engine_oauth_list() -> dict[str, Any]:
    """Mirror the engine's GET /api/providers/oauth — the canonical OAuth
    provider catalog (`_OAUTH_PROVIDER_CATALOG`) plus live login status for
    each. flow ∈ {pkce, device_code, external}."""
    try:
        from hermes_cli.web_server import (
            _OAUTH_PROVIDER_CATALOG,
            _resolve_provider_status,
        )
    except Exception as e:  # noqa: BLE001
        log.warning("engine_oauth_list import failed: %s", e)
        return {"providers": [], "error": "Layanan engine tidak tersedia, coba lagi."}

    out: list[dict[str, Any]] = []
    for p in _OAUTH_PROVIDER_CATALOG:
        try:
            status = _resolve_provider_status(p["id"], p.get("status_fn")) or {}
        except Exception as e:  # noqa: BLE001
            status = {"logged_in": False, "error": str(e)}
        out.append({
            "id": p["id"],
            # Brand scrub: engine names like 'Nous Portal' + cliCommand
            # 'hermes auth add …' + docsUrl on nousresearch.com/hermes-agent.*
            # must never reach users (hard constraint). UI also overrides names
            # via OAUTH_DISPLAY, but scrub here as defense-in-depth.
            "name": scrub_brand(p["name"]),
            "flow": p["flow"],
            "cliCommand": scrub_cli_command(p.get("cli_command", "")),
            "docsUrl": scrub_docs_url(p.get("docs_url", "")),
            "status": {
                "loggedIn": bool(status.get("logged_in")),
                "sourceLabel": status.get("source_label"),
                "tokenPreview": status.get("token_preview"),
                "expiresAt": status.get("expires_at"),
                "hasRefreshToken": bool(status.get("has_refresh_token")),
                "error": status.get("error"),
            },
        })
    return {"providers": out}


def engine_env_catalog() -> dict[str, Any]:
    """Mirror the engine's GET /api/env for the LLM-provider category — every
    provider env var the engine recognizes, with current is_set + redacted
    value + metadata, read straight from `OPTIONAL_ENV_VARS`."""
    try:
        from hermes_cli.config import OPTIONAL_ENV_VARS, load_env, redact_key
    except Exception as e:  # noqa: BLE001
        log.warning("engine_env_catalog import failed: %s", e)
        return {"vars": [], "error": "Layanan engine tidak tersedia, coba lagi."}
    try:
        env = load_env() or {}
    except Exception:  # noqa: BLE001
        env = {}

    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for name, info in OPTIONAL_ENV_VARS.items():
        if info.get("category") != "provider":
            continue
        # Skip engine-internal config vars (gemini-cli OAuth client creds, qwen
        # base-url override). They are NOT user BYOK keys, and the 'HERMES_'
        # prefix would leak the engine brand into a user-facing card name.
        if name.startswith("HERMES_"):
            continue
        seen.add(name)
        val = env.get(name)
        # Brand scrub: a couple of engine descriptions leak 'Nous Portal' +
        # "set via 'hermes model'" — strip before surfacing.
        desc = scrub_brand(info.get("description", "") or "")
        # Some keys are ALIASES for the same provider (engine reads either),
        # e.g. GEMINI_API_KEY = "alias for GOOGLE_API_KEY". Surface the canonical
        # so /app can collapse aliases into ONE provider card instead of showing
        # confusing duplicates.
        m = re.search(r"alias for (\w+)", desc, re.IGNORECASE)
        canonical = m.group(1) if m else name
        out.append({
            "key": name,
            "canonical": canonical,
            "isSet": bool(val),
            "redactedValue": redact_key(val) if val else None,
            "description": desc,
            "url": info.get("url"),
            "isPassword": bool(info.get("password", False)),
            "advanced": bool(info.get("advanced", False)),
            # CAT — category + free-tier metadata so /app can section the grid
            # for non-technical users (Populer / Regional / Coding / …).
            "category": _PROVIDER_CATEGORY.get(name, "popular"),
            "free": name in _FREE_PROVIDERS,
        })

    # CAT3/5 — synthetic cards for providers the engine ROUTES (get_provider
    # live-confirmed) but that are absent from OPTIONAL_ENV_VARS (so the env
    # catalog omits them): OpenAI-direct, Groq, Mistral, Cerebras, Fireworks.
    # Append only if the engine didn't already surface that env var.
    for card in _SYNTHETIC_PROVIDER_CARDS:
        name = card["key"]
        if name in seen:
            continue
        val = env.get(name)
        out.append({
            "key": name,
            "canonical": name,
            "isSet": bool(val),
            "redactedValue": redact_key(val) if val else None,
            "description": card["description"],
            "url": card.get("url"),
            "isPassword": True,
            "advanced": False,
            "category": card.get("category", "popular"),
            "free": bool(card.get("free")),
            # The CONCRETE engine provider id this key serves (never a bare
            # aggregator alias). A future model picker pins model.provider here.
            "providerId": card.get("providerId"),
            "synthetic": True,
        })
    return {"vars": out}


def write_qwen_creds(raw_json: str) -> dict[str, Any]:
    """Qwen-oauth is an 'external' flow: the engine reads the Qwen CLI's
    ~/.qwen/oauth_creds.json. The Qwen CLI isn't in the container, so the user
    runs `qwen` login on their own machine and pastes that file's JSON here; we
    write it to the path the engine reads. Advanced path — most users use the
    DASHSCOPE_API_KEY instead."""
    import json as _json
    from pathlib import Path as _Path

    text = (raw_json or "").strip()
    if not text:
        return {"ok": False, "error": "creds JSON kosong"}
    try:
        data = _json.loads(text)
        if not isinstance(data, dict):
            raise ValueError("harus berupa objek JSON")
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"JSON tidak valid: {str(e)[:120]}"}
    try:
        path = _Path.home() / ".qwen" / "oauth_creds.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_json.dumps(data), encoding="utf-8")
        try:
            path.chmod(0o600)
        except Exception:  # noqa: BLE001
            pass
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:200]}


def disconnect_oauth(provider_id: str) -> dict[str, Any]:
    """Disconnect an OAuth provider: delete its creds file (claude-code/qwen) or
    remove its pooled credential via `hermes auth remove <id>` (the rest)."""
    from pathlib import Path as _Path

    pid = (provider_id or "").strip()
    if pid == "claude-code":
        try:
            (_Path.home() / ".claude" / ".credentials.json").unlink(missing_ok=True)
            return {"ok": True}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)[:160]}
    if pid == "qwen-oauth":
        try:
            (_Path.home() / ".qwen" / "oauth_creds.json").unlink(missing_ok=True)
            return {"ok": True}
        except Exception as e:  # noqa: BLE001
            return {"ok": False, "error": str(e)[:160]}
    # anthropic / nous / openai-codex / minimax-oauth → engine credential store.
    # Use `hermes auth logout <provider>` (clears stored auth state). NOTE: the
    # `remove` subcommand needs a second `target` arg and is for pool entries —
    # logout is the right one for disconnecting a provider login. Logout is a
    # graceful no-op (rc=0) when nothing is logged in.
    rc, out, err = _run_hermes_auth(["logout", pid])
    blob = (err + out).lower()
    if rc != 0 and "no auth" not in blob and "not" not in blob and "no " not in blob:
        return {"ok": False, "error": (err or out or "logout failed").strip()[:200]}
    invalidate_pool_cache()
    return {"ok": True}


def write_claude_creds(raw: str) -> dict[str, Any]:
    """claude-code (external): the engine reads ~/.claude/.credentials.json with
    shape {claudeAiOauth:{accessToken, refreshToken?, expiresAt?}} (NOT the
    CLAUDE_CODE_OAUTH_TOKEN env — verified against read_claude_code_credentials).
    The user runs `claude setup-token` (or logs into Claude Code) on their own
    machine and pastes either the raw token or the full credentials JSON; we
    write it to the path the engine reads."""
    import json as _json
    from pathlib import Path as _Path

    text = (raw or "").strip()
    if not text:
        return {"ok": False, "error": "token/creds kosong"}

    creds = None
    if text.startswith("{"):
        try:
            data = _json.loads(text)
            if isinstance(data, dict):
                if isinstance(data.get("claudeAiOauth"), dict):
                    creds = data  # full credentials.json pasted
                elif data.get("accessToken"):
                    creds = {"claudeAiOauth": data}  # bare oauth object
        except Exception:  # noqa: BLE001
            pass
    if creds is None:
        # Raw setup-token / access-token string.
        creds = {"claudeAiOauth": {"accessToken": text, "refreshToken": "", "expiresAt": 0}}

    if not (creds.get("claudeAiOauth") or {}).get("accessToken"):
        return {"ok": False, "error": "accessToken tidak ditemukan di input"}
    try:
        path = _Path.home() / ".claude" / ".credentials.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(_json.dumps(creds), encoding="utf-8")
        try:
            path.chmod(0o600)
        except Exception:  # noqa: BLE001
            pass
        return {"ok": True}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:200]}


def set_env(key: str, value: str) -> dict[str, Any]:
    """Set ANY recognized env var via the engine's own writer (has the engine's
    name validation + denylist). Caller restarts the engine to adopt it."""
    try:
        from hermes_cli.config import save_env_value
    except Exception as e:  # noqa: BLE001
        log.warning("set_env import failed: %s", e)
        return {"ok": False, "error": "Layanan engine tidak tersedia, coba lagi."}
    try:
        save_env_value(key, value)
        try:
            os.environ[key] = value
        except Exception:  # noqa: BLE001
            pass
        # SEC3 — the engine's save_env_value deliberately skips chmod inside
        # containers, leaving ~/.hermes/.env at 0644 despite the UI's "0600"
        # promise. Enforce 0600 here so the secret file is owner-only.
        _enforce_env_perms()
        return {"ok": True, "key": key}
    except ValueError as e:
        return {"ok": False, "error": str(e)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:300]}


def _enforce_env_perms() -> None:
    """Best-effort chmod ~/.hermes/.env to 0600 (matches the UI's security
    promise; the engine skips this in containers)."""
    try:
        from pathlib import Path as _Path
        home = os.environ.get("HERMES_HOME") or str(_Path.home() / ".hermes")
        env_path = _Path(home) / ".env"
        if env_path.exists():
            env_path.chmod(0o600)
    except Exception:  # noqa: BLE001
        pass


def delete_env(key: str) -> dict[str, Any]:
    """Remove a recognized env var via the engine's own remover."""
    try:
        from hermes_cli.config import remove_env_value
    except Exception as e:  # noqa: BLE001
        log.warning("delete_env import failed: %s", e)
        return {"ok": False, "error": "Layanan engine tidak tersedia, coba lagi."}
    try:
        remove_env_value(key)
        try:
            os.environ.pop(key, None)
        except Exception:  # noqa: BLE001
            pass
        # WIRE5 — absence IS the desired end state. A no-op delete (key already
        # gone) returns ok:true, not a false-failure on the engine's False.
        return {"ok": True, "key": key}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": str(e)[:300]}
