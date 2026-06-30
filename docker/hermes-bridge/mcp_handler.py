"""
mcp_handler.py — Model Context Protocol connector manager for /app/agents.

REAL Hermes-native (verified 2026-05-26 against hermes_cli/mcp_config.py):
  - Servers stored in `config.yaml::mcp_servers.<name>` (NOT skills.servers)
  - Server config: { url } for HTTP, { command, args, env? } for stdio
  - Auth: "oauth" | "header" (bearer via headers.Authorization env-var ref)
  - Per-server tool selection via `enabled_tools` list
  - Discovery: connect → list tools → user selects which to enable
  - Hermes only ships ONE preset ("codex"); we bake a CURATED community
    preset list for mass-market discoverability

CLI delegation: add/remove/test/configure/login via subprocess `hermes mcp`.
Reads + presets are bridge-side (faster + we own the curated list).

RPC surface (registered in rpc_router):
    mcp.list                                       → servers + tool counts
    mcp.info(name)                                 → one server detail
    mcp.presets                                    → curated preset list
    mcp.add({name, presetId | url | command, ...}) → add new server
    mcp.remove(name)                               → delete server
    mcp.test(name)                                 → connect + list tools
    mcp.configure({name, enabledTools[]})          → toggle tool selection
"""

from __future__ import annotations

import logging
import os
import re
import subprocess
from pathlib import Path
from typing import Any, Optional

import yaml


log = logging.getLogger("bridge.mcp_handler")


# Mirror Hermes' MCP server name regex (alphanumeric + _- only)
_MCP_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")


class McpError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


# -----------------------------------------------------------------
# CURATED preset catalog — community-popular MCP servers with
# mass-market Bahasa labels + npx commands. AgentBuff value-add since
# Hermes only ships "codex" preset.
# -----------------------------------------------------------------

_CURATED_PRESETS: list[dict] = [
    {
        "id": "notion",
        "label": "Notion",
        "labelId": "Notion",
        "description": "Akses workspace Notion kamu — baca + tulis halaman, database, komentar.",
        "category": "produktivitas",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@notionhq/notion-mcp-server"],
        "envVars": [
            {
                "name": "NOTION_API_KEY",
                "hint": "Dapet dari notion.so/profile/integrations",
                "required": True,
            },
        ],
        "icon": "📝",
        "popularity": 95,
    },
    {
        "id": "github",
        "label": "GitHub",
        "labelId": "GitHub",
        "description": "Akses repo, issue, PR, commit GitHub kamu.",
        "category": "developer",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-github"],
        "envVars": [
            {
                "name": "GITHUB_PERSONAL_ACCESS_TOKEN",
                "hint": "Generate di github.com/settings/tokens (perlu repo + workflow scope)",
                "required": True,
            },
        ],
        "icon": "🐙",
        "popularity": 92,
    },
    {
        "id": "filesystem",
        "label": "File Sistem Lokal",
        "labelId": "Filesystem",
        "description": "Baca + tulis file di folder tertentu (sandbox aman, dibatasin path yang kamu pilih).",
        "category": "produktivitas",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"],
        "envVars": [],
        "icon": "📁",
        "popularity": 88,
    },
    {
        "id": "slack",
        "label": "Slack",
        "labelId": "Slack",
        "description": "Kirim + baca pesan, list channel, manage workspace Slack.",
        "category": "komunikasi",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-slack"],
        "envVars": [
            {
                "name": "SLACK_BOT_TOKEN",
                "hint": "Bot token (xoxb-...) dari api.slack.com/apps",
                "required": True,
            },
            {
                "name": "SLACK_TEAM_ID",
                "hint": "Team ID workspace Slack",
                "required": True,
            },
        ],
        "icon": "💬",
        "popularity": 85,
    },
    {
        "id": "gdrive",
        "label": "Google Drive",
        "labelId": "Google Drive",
        "description": "Akses file di Google Drive — list, baca, search.",
        "category": "produktivitas",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-gdrive"],
        "envVars": [
            {
                "name": "GDRIVE_CREDENTIALS",
                "hint": "Path ke OAuth credentials.json dari Google Cloud Console",
                "required": True,
            },
        ],
        "icon": "📂",
        "popularity": 82,
    },
    {
        "id": "memory",
        "label": "Memori Tambahan",
        "labelId": "Memory (MCP)",
        "description": "Knowledge graph memori berbasis MCP — ingatan persistent untuk agen.",
        "category": "agen-tools",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-memory"],
        "envVars": [],
        "icon": "🧠",
        "popularity": 78,
    },
    {
        "id": "brave-search",
        "label": "Brave Search",
        "labelId": "Brave Search",
        "description": "Cari di web pakai Brave Search API (tidak tracked Google).",
        "category": "riset",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-brave-search"],
        "envVars": [
            {
                "name": "BRAVE_API_KEY",
                "hint": "Daftar gratis di brave.com/search/api/",
                "required": True,
            },
        ],
        "icon": "🦁",
        "popularity": 75,
    },
    {
        "id": "puppeteer",
        "label": "Browser Otomatis (Puppeteer)",
        "labelId": "Puppeteer",
        "description": "Kontrol browser headless buat scrape, screenshot, fill form.",
        "category": "otomasi",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-puppeteer"],
        "envVars": [],
        "icon": "🤖",
        "popularity": 72,
    },
    {
        "id": "postgres",
        "label": "PostgreSQL",
        "labelId": "PostgreSQL",
        "description": "Query database PostgreSQL — SELECT, INSERT, UPDATE, schema inspection.",
        "category": "developer",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-postgres"],
        "envVars": [
            {
                "name": "POSTGRES_CONNECTION_STRING",
                "hint": "postgresql://user:pass@host:port/db",
                "required": True,
            },
        ],
        "icon": "🐘",
        "popularity": 70,
    },
    {
        "id": "sequential-thinking",
        "label": "Berpikir Bertahap",
        "labelId": "Sequential Thinking",
        "description": "Tool berpikir bertahap untuk problem kompleks — agen pecah masalah step-by-step.",
        "category": "agen-tools",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-sequential-thinking"],
        "envVars": [],
        "icon": "🧩",
        "popularity": 68,
    },
    {
        "id": "everart",
        "label": "EverArt (Image Gen)",
        "labelId": "EverArt",
        "description": "Generate gambar via EverArt API (alternatif DALL-E).",
        "category": "kreatif",
        "transport": "stdio",
        "command": "npx",
        "args": ["-y", "@modelcontextprotocol/server-everart"],
        "envVars": [
            {
                "name": "EVERART_API_KEY",
                "hint": "Dapet dari everart.ai",
                "required": True,
            },
        ],
        "icon": "🎨",
        "popularity": 60,
    },
    {
        "id": "codex",
        "label": "Codex (built-in Hermes)",
        "labelId": "Codex",
        "description": "Bawaan Hermes — codex MCP server.",
        "category": "developer",
        "transport": "stdio",
        "command": "codex",
        "args": ["mcp-server"],
        "envVars": [],
        "icon": "🔧",
        "popularity": 50,
    },
]


def _validate_mcp_name(name: str) -> None:
    if not isinstance(name, str) or not name:
        raise McpError("INVALID_REQUEST", "name must be a non-empty string")
    if not _MCP_NAME_RE.match(name):
        raise McpError(
            "INVALID_REQUEST",
            "name: lowercase alphanumeric + _ - only, 1-64 chars",
        )


class McpHandler:
    """Hermes-native MCP connector manager exposed via RPC."""

    def __init__(self, hermes_home: Path) -> None:
        self._home = Path(hermes_home)

    # -----------------------------------------------------------------
    # Public RPC handlers
    # -----------------------------------------------------------------

    async def list_servers(self) -> dict:
        """mcp.list — enumerate configured MCP servers with status."""
        servers_cfg = self._read_servers_config()
        items: list[dict] = []
        for name, raw in sorted(servers_cfg.items()):
            if not isinstance(raw, dict):
                continue
            items.append(self._build_server_row(name, raw))
        return {
            "servers": items,
            "total": len(items),
            "enabledCount": sum(1 for s in items if s["enabled"]),
        }

    async def get_server(self, name: str) -> dict:
        _validate_mcp_name(name)
        servers_cfg = self._read_servers_config()
        if name not in servers_cfg:
            raise McpError("NOT_FOUND", f"server {name!r} not configured")
        raw = servers_cfg[name]
        if not isinstance(raw, dict):
            raise McpError("CORRUPT", f"server {name!r} config is malformed")
        return self._build_server_row(name, raw)

    async def list_presets(self) -> dict:
        """mcp.presets — curated community MCP server catalog."""
        return {
            "presets": list(_CURATED_PRESETS),
            "total": len(_CURATED_PRESETS),
            "categories": sorted(set(p["category"] for p in _CURATED_PRESETS)),
        }

    async def add_server(self, params: dict) -> dict:
        """mcp.add — install a new MCP server (preset OR custom).

        params: {
          name: str,                  # required, used as config key
          presetId?: str,             # if using preset
          url?: str,                  # custom HTTP MCP
          command?: str,              # custom stdio MCP
          args?: list[str],           # stdio args
          env?: dict[str, str],       # stdio env vars
          auth?: "oauth"|"header"|null,
        }
        """
        if not isinstance(params, dict):
            raise McpError("INVALID_REQUEST", "params must be a dict")
        name = (params.get("name") or "").strip().lower()
        _validate_mcp_name(name)

        preset_id = params.get("presetId") or params.get("preset")
        url = params.get("url")
        command = params.get("command")
        args = params.get("args") or []
        env = params.get("env") or {}
        auth = params.get("auth")

        # Resolve from preset if given
        if preset_id and not url and not command:
            preset = next((p for p in _CURATED_PRESETS if p["id"] == preset_id), None)
            if not preset:
                raise McpError("NOT_FOUND", f"preset {preset_id!r} not in catalog")
            command = preset.get("command")
            args = list(preset.get("args") or [])
            # NB: env values must be supplied by caller; preset only describes which vars

        if not url and not command:
            raise McpError(
                "INVALID_REQUEST",
                "must provide presetId, url, or command",
            )

        # Check existing
        existing = self._read_servers_config()
        if name in existing:
            raise McpError(
                "ALREADY_EXISTS",
                f"server {name!r} already configured (remove dulu kalau mau ganti)",
            )

        # Build config dict
        server_config: dict[str, Any] = {}
        if url:
            server_config["url"] = str(url)
        else:
            server_config["command"] = str(command)
            if args:
                server_config["args"] = [str(a) for a in args]
            if env:
                server_config["env"] = {str(k): str(v) for k, v in env.items() if k}

        if auth == "oauth":
            server_config["auth"] = "oauth"
        elif auth == "header":
            # Caller can pre-populate headers separately if they have token
            pass

        # Save via direct config patch (avoid CLI interactive prompts)
        self._save_server_config(name, server_config)
        self._signal_reload()

        return await self.get_server(name)

    async def remove_server(self, name: str) -> dict:
        """mcp.remove — delete a configured MCP server."""
        _validate_mcp_name(name)
        cfg = self._read_full_config()
        servers = cfg.get("mcp_servers") if isinstance(cfg.get("mcp_servers"), dict) else {}
        if name not in servers:
            raise McpError("NOT_FOUND", f"server {name!r} not configured")
        # Use CLI for proper cleanup (closes any connections + clears auth tokens)
        try:
            result = subprocess.run(
                ["hermes", "mcp", "remove", name],
                capture_output=True, text=True, timeout=20,
                env={**os.environ, "HERMES_HOME": str(self._home)},
            )
            if result.returncode != 0:
                # Fall back to direct config edit
                log.warning("hermes mcp remove failed, falling back: %s", result.stderr)
                del servers[name]
                if not servers:
                    cfg.pop("mcp_servers", None)
                else:
                    cfg["mcp_servers"] = servers
                self._write_full_config(cfg)
        except (FileNotFoundError, subprocess.TimeoutExpired):
            # Direct fallback
            del servers[name]
            if not servers:
                cfg.pop("mcp_servers", None)
            else:
                cfg["mcp_servers"] = servers
            self._write_full_config(cfg)

        self._signal_reload()
        return {"removed": name}

    async def test_server(self, name: str) -> dict:
        """mcp.test — try to connect to server + report tool count."""
        _validate_mcp_name(name)
        try:
            result = subprocess.run(
                ["hermes", "mcp", "test", name],
                capture_output=True, text=True, timeout=60,
                env={**os.environ, "HERMES_HOME": str(self._home)},
            )
        except FileNotFoundError:
            raise McpError("ENGINE_DOWN", "hermes CLI not on PATH")
        except subprocess.TimeoutExpired:
            raise McpError("TIMEOUT", "test timed out after 60s")

        stdout = (result.stdout or "").strip()
        stderr = (result.stderr or "").strip()
        ok = result.returncode == 0
        # Parse tool count from typical output ("Connected! Found N tool(s)...")
        tool_count = None
        m = re.search(r"Found (\d+) tool", stdout)
        if m:
            tool_count = int(m.group(1))
        return {
            "name": name,
            "ok": ok,
            "toolCount": tool_count,
            "output": stdout[:2000],
            "error": stderr[:1000] if not ok else None,
        }

    async def configure_server(self, name: str, enabled_tools: Optional[list[str]] = None, enabled: Optional[bool] = None) -> dict:
        """mcp.configure — toggle which tools from the server are exposed.

        enabled_tools: explicit list of tool names to expose (None = all)
        enabled: turn whole server on/off without removing
        """
        _validate_mcp_name(name)
        cfg = self._read_full_config()
        servers = cfg.get("mcp_servers") if isinstance(cfg.get("mcp_servers"), dict) else {}
        if name not in servers:
            raise McpError("NOT_FOUND", f"server {name!r} not configured")
        if not isinstance(servers[name], dict):
            raise McpError("CORRUPT", f"server {name!r} config is malformed")
        server = servers[name]
        if enabled_tools is not None:
            if not isinstance(enabled_tools, list):
                raise McpError("INVALID_REQUEST", "enabled_tools must be a list")
            server["enabled_tools"] = [str(t) for t in enabled_tools if t]
        if enabled is not None:
            server["enabled"] = bool(enabled)
        cfg["mcp_servers"] = servers
        self._write_full_config(cfg)
        self._signal_reload()
        return await self.get_server(name)

    # -----------------------------------------------------------------
    # Internal helpers
    # -----------------------------------------------------------------

    def _config_path(self) -> Path:
        return self._home / "config.yaml"

    def _read_full_config(self) -> dict:
        path = self._config_path()
        if not path.exists():
            return {}
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    def _read_servers_config(self) -> dict:
        cfg = self._read_full_config()
        servers = cfg.get("mcp_servers")
        return servers if isinstance(servers, dict) else {}

    def _write_full_config(self, cfg: dict) -> None:
        import tempfile
        path = self._config_path()
        try:
            text = yaml.safe_dump(cfg, allow_unicode=True, sort_keys=False)
        except yaml.YAMLError as e:
            raise McpError("IO_ERROR", f"yaml serialize: {e}")
        # atomic write
        fd, tmp = tempfile.mkstemp(prefix=".config.yaml.tmp.", dir=str(path.parent))
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(text.encode("utf-8"))
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    pass
            os.replace(tmp, path)
        except Exception:
            try:
                os.unlink(tmp)
            except OSError:
                pass
            raise

    def _save_server_config(self, name: str, server_config: dict) -> None:
        cfg = self._read_full_config()
        servers = cfg.get("mcp_servers") if isinstance(cfg.get("mcp_servers"), dict) else {}
        servers[name] = server_config
        cfg["mcp_servers"] = servers
        self._write_full_config(cfg)

    def _signal_reload(self) -> None:
        """Make a freshly added/removed/configured MCP server take effect.

        Reality (verified 2026-05-30): MCP servers load from config.yaml::
        mcp_servers when an agent is BUILT, and the /app control gateway builds
        a fresh agent (re-reading config) for every NEW chat session — so a new
        MCP server activates automatically on the next new thread, NO restart
        needed. A session already live uses the engine's per-session reload.mcp.

        Belt-and-suspenders: SIGUSR1 the CHANNEL runtime (`hermes gateway run`,
        a separate process) so channel-routed agents notice too. We locate it by
        /proc cmdline scan (the minimal image has no `pgrep`), the same pattern
        the WA-bridge restart uses. Best-effort — failure is harmless because the
        next-new-session fresh read already covers /app chat."""
        try:
            import signal as _signal
            for pid_s in os.listdir("/proc"):
                if not pid_s.isdigit():
                    continue
                try:
                    with open(f"/proc/{pid_s}/cmdline", "rb") as f:
                        cmd = f.read().replace(b"\x00", b" ").decode("utf-8", "replace")
                except OSError:
                    continue
                if "gateway" in cmd and "run" in cmd and "agentbuff_bridge" not in cmd:
                    try:
                        os.kill(int(pid_s), _signal.SIGUSR1)
                        log.info("mcp: signaled channel gateway reload (pid=%s)", pid_s)
                    except OSError:
                        pass
        except Exception:
            log.debug("mcp: channel gateway reload signal skipped", exc_info=True)

    def _build_server_row(self, name: str, raw: dict) -> dict:
        transport = "http" if raw.get("url") else "stdio"
        return {
            "name": name,
            "transport": transport,
            "url": raw.get("url"),
            "command": raw.get("command"),
            "args": raw.get("args") or [],
            "env": raw.get("env") or {},
            "auth": raw.get("auth"),
            "enabled": raw.get("enabled", True),
            "enabledTools": raw.get("enabled_tools") or None,
            "raw": raw,
        }
