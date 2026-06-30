"""
plugins_handler.py — REAL Hermes plugin manager for /app/agents Plugin tab.

Hermes plugin system (verified 2026-05-26 against hermes_cli/plugins.py):

  - **Discovery sources** (later wins on name collision):
      1. Bundled    — <repo>/plugins/<name>/         (ships with hermes-agent pip)
      2. User       — ~/.hermes/plugins/<name>/      (per-container volume)
      3. Project    — ./.hermes/plugins/<name>/      (opt-in env var)
      4. Entrypoint — pip package with `hermes_agent.plugins` entry-point group

  - **Manifest** — every directory plugin has `plugin.yaml` with:
      name, version, description, author, kind, provides_tools[],
      provides_hooks[], requires_env[]

  - **Lifecycle** — plugin's `__init__.py::register(ctx)` is called at boot;
    registers tools (toolsets), hooks (lifecycle callbacks), CLI commands,
    dashboard tabs.

  - **Enable/disable state** — stored in REAL config.yaml at
      plugins:
        enabled: [<name>, ...]
        disabled: [<name>, ...]

  - **CLI** — `hermes plugins {list,enable,disable,install,update,remove}`
    handle state changes. We forward via subprocess for state changes;
    introspection reads the live PluginManager directly (faster).

RPC surface:
    plugins.list                  → all discovered plugins + state
    plugins.info(name)            → detail incl. SKILL.md count + dashboard tab
    plugins.enable(name)          → write plugins.enabled list
    plugins.disable(name)         → write plugins.disabled list (deny-list)
    plugins.discover              → force re-scan (no restart needed)
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
from pathlib import Path
from typing import Any, Optional

import yaml


log = logging.getLogger("bridge.plugins_handler")


# Plugin name validator. Hermes accepts any non-empty string but for our
# RPC layer we mirror the file/dir-name constraints (lowercase + nested
# category support like "image_gen/openai").
_PLUGIN_KEY_RE = re.compile(r"^[a-z0-9][a-z0-9_./-]{0,127}$")


_PROTECTED_PLUGIN_KEYS = {"multichannel", "multimodal"}


def _is_protected_plugin_key(key: str) -> bool:
    """True for AgentBuff bundled plugins - never disable/remove them."""
    k = (key or "").lower()
    for pre in ("agentbuff-", "hermes-", "agentbuff_", "hermes_"):
        if k.startswith(pre):
            k = k[len(pre):]
            break
    return k in _PROTECTED_PLUGIN_KEYS


class PluginsError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


def _validate_plugin_key(key: str) -> None:
    if not isinstance(key, str) or not key:
        raise PluginsError("INVALID_REQUEST", "plugin key must be a non-empty string")
    if not _PLUGIN_KEY_RE.match(key):
        raise PluginsError(
            "INVALID_REQUEST",
            "plugin key: lowercase alphanumeric + _ - . / only, 1-128 chars",
        )


class PluginsHandler:
    """Hermes-native plugin manager exposed to /app via plugins.* RPC."""

    def __init__(self, hermes_home: Path) -> None:
        self._home = Path(hermes_home)
        self._user_plugins_dir = self._home / "plugins"

    # -----------------------------------------------------------------
    # List + info
    # -----------------------------------------------------------------

    async def list_plugins(self) -> dict:
        """Return the user-facing plugin list, identical to `hermes plugins list`
        + the native dashboard: bundled general plugins + user plugins (top-level
        dirs with a plugin.yaml manifest), manageable via enable/disable. Source:
        user / bundled / project / entrypoint.
        """
        # Source of truth = the engine CLI `hermes plugins list --json` — the SAME
        # list `hermes plugins list` + the native dashboard show (bundled general
        # plugins + user plugins, top-level dirs only). We deliberately do NOT use
        # the in-process plugin manager: it returns ~40 entries because it also
        # registers auto-loaded provider backends (web/*, image_gen/*, platform
        # adapters) the engine never surfaces as user plugins — that was the source
        # of /app showing 40 "plugins". Mirror the engine 1:1 -> 7.
        raw_list = self._list_plugins_from_cli()
        config_state = self._read_config_state()
        bundled_dir = self._bundled_plugins_dir()
        items: list[dict] = []
        for entry in raw_list:
            key = entry.get("key") or entry.get("name") or ""
            name = entry.get("name") or key
            manifest_path = self._locate_manifest(key, name, bundled_dir)
            manifest_extra = self._read_manifest(manifest_path) if manifest_path else {}
            source = entry.get("source") or self._infer_source(manifest_path, bundled_dir)
            # Plugin author + extra metadata fields
            row = {
                "key": key,
                "name": name,
                "version": entry.get("version") or manifest_extra.get("version") or "",
                "description": (
                    entry.get("description")
                    or manifest_extra.get("description")
                    or ""
                ),
                "author": manifest_extra.get("author") or "",
                "kind": entry.get("kind") or manifest_extra.get("kind") or "standalone",
                "source": source,
                # "enabled" mirrors the engine CLI exactly — it comes from
                # `hermes plugins list --json` status (config-based opt-in, the
                # same signal _plugin_status uses).
                "enabled": bool(entry.get("enabled")),
                "explicitlyEnabled": key in config_state["enabled"] or name in config_state["enabled"],
                "explicitlyDisabled": key in config_state["disabled"] or name in config_state["disabled"],
                "providesTools": _as_list(manifest_extra.get("provides_tools")),
                "providesHooks": _as_list(manifest_extra.get("provides_hooks")),
                "requiresEnv": _normalize_requires_env(
                    manifest_extra.get("requires_env")
                ),
                # Runtime counts (post-load, only meaningful if enabled+loaded)
                "toolsRegistered": int(entry.get("tools") or 0),
                "hooksRegistered": int(entry.get("hooks") or 0),
                "commandsRegistered": int(entry.get("commands") or 0),
                "loadError": entry.get("error"),
                "manifestPath": str(manifest_path) if manifest_path else None,
                "pluginPath": str(manifest_path.parent) if manifest_path else None,
                # Filesystem hints for the UI
                "hasDashboard": (
                    bool(manifest_path) and (manifest_path.parent / "dashboard" / "manifest.json").exists()
                ),
                "skillFiles": self._count_plugin_skill_files(manifest_path),
            }
            items.append(row)

        # Stable sort: user plugins first (most actionable), then bundled,
        # then entrypoint; within each group by name.
        source_order = {
            "user": 0,
            "project": 1,
            "bundled": 2,
            "entrypoint": 4,
            "unknown": 9,
        }
        items.sort(key=lambda x: (
            source_order.get(x["source"], 9),
            x["name"].lower(),
        ))

        return {
            "plugins": items,
            "total": len(items),
            "enabledCount": sum(1 for x in items if x["enabled"]),
            "userInstalledCount": sum(1 for x in items if x["source"] == "user"),
            "bundledCount": sum(1 for x in items if x["source"] == "bundled"),
            "hasErrors": any(x["loadError"] for x in items),
        }

    async def get_plugin(self, key: str) -> dict:
        """Return single plugin enriched with full manifest details."""
        _validate_plugin_key(key)
        list_res = await self.list_plugins()
        for p in list_res["plugins"]:
            if p["key"] == key or p["name"] == key:
                return p
        raise PluginsError("NOT_FOUND", f"plugin {key!r} not found")

    # -----------------------------------------------------------------
    # Enable / disable
    # -----------------------------------------------------------------

    async def enable_plugin(self, key: str) -> dict:
        """Enable a plugin via `hermes plugins enable <key>` subprocess.

        The CLI writes to config.yaml::plugins.enabled (allow-list) + removes
        from plugins.disabled (deny-list). Plugin loads on next discover or
        next bridge subprocess restart — for immediate effect we also call
        discover with force=True afterwards.
        """
        _validate_plugin_key(key)
        try:
            result = subprocess.run(
                ["hermes", "plugins", "enable", key],
                capture_output=True, text=True, timeout=30,
                env={**os.environ, "HERMES_HOME": str(self._home)},
            )
        except FileNotFoundError:
            raise PluginsError("ENGINE_DOWN", "hermes CLI not on PATH")
        except subprocess.TimeoutExpired:
            raise PluginsError("ENGINE_DOWN", "hermes plugins enable timed out")
        if result.returncode != 0:
            raise PluginsError(
                "ENGINE_ERROR",
                f"enable failed: {(result.stderr or result.stdout).strip()}",
            )
        self._force_rediscover()
        return await self.get_plugin(key)

    async def disable_plugin(self, key: str) -> dict:
        """Disable a plugin via `hermes plugins disable <key>` subprocess.

        Writes config.yaml::plugins.disabled list. Plugin unloads on next
        discover OR remains loaded until subprocess restart (Hermes does
        NOT hot-unload — disable means "don't load next time").
        """
        _validate_plugin_key(key)
        if _is_protected_plugin_key(key):
            raise PluginsError(
                "INVALID_REQUEST",
                "plugin bawaan AgentBuff ga bisa dimatiin",
            )
        try:
            result = subprocess.run(
                ["hermes", "plugins", "disable", key],
                capture_output=True, text=True, timeout=30,
                env={**os.environ, "HERMES_HOME": str(self._home)},
            )
        except FileNotFoundError:
            raise PluginsError("ENGINE_DOWN", "hermes CLI not on PATH")
        except subprocess.TimeoutExpired:
            raise PluginsError("ENGINE_DOWN", "hermes plugins disable timed out")
        if result.returncode != 0:
            raise PluginsError(
                "ENGINE_ERROR",
                f"disable failed: {(result.stderr or result.stdout).strip()}",
            )
        self._force_rediscover()
        return await self.get_plugin(key)

    async def remove_plugin(self, key: str) -> dict:
        """Remove a USER-installed plugin via CLI. Bundled plugins refused."""
        _validate_plugin_key(key)
        if _is_protected_plugin_key(key):
            raise PluginsError(
                "INVALID_REQUEST",
                "plugin bawaan AgentBuff ga bisa dihapus",
            )
        # Pre-check: refuse to delete bundled plugins. Caller would just get
        # a confusing error from the CLI ("can't delete bundled").
        try:
            info = await self.get_plugin(key)
        except PluginsError:
            info = {}
        if info.get("source") == "bundled":
            raise PluginsError(
                "INVALID_REQUEST",
                "plugin bawaan engine ga bisa dihapus — disable aja",
            )
        try:
            result = subprocess.run(
                ["hermes", "plugins", "remove", key],
                capture_output=True, text=True, timeout=30,
                env={**os.environ, "HERMES_HOME": str(self._home)},
            )
        except FileNotFoundError:
            raise PluginsError("ENGINE_DOWN", "hermes CLI not on PATH")
        except subprocess.TimeoutExpired:
            raise PluginsError("ENGINE_DOWN", "hermes plugins remove timed out")
        if result.returncode != 0:
            raise PluginsError(
                "ENGINE_ERROR",
                f"remove failed: {(result.stderr or result.stdout).strip()}",
            )
        self._force_rediscover()
        return {"removed": key}

    async def force_discover(self) -> dict:
        """Force re-scan of plugin dirs without container restart."""
        self._force_rediscover()
        list_res = await self.list_plugins()
        return {
            "ok": True,
            "total": list_res["total"],
            "enabled": list_res["enabledCount"],
        }

    # -----------------------------------------------------------------
    # Internal — manager + filesystem helpers
    # -----------------------------------------------------------------

    def _list_plugins_from_cli(self) -> list[dict]:
        """Plugins exactly as the engine surfaces them: `hermes plugins list --json`.

        This is the AUTHORITATIVE user-facing plugin set — bundled general plugins
        + user plugins (top-level dirs only), identical to `hermes plugins list`
        and the native dashboard. We do NOT use the in-process PluginManager: it
        also lists auto-loaded provider backends (web/*, image_gen/*, platform
        adapters) that the engine never presents as user-manageable plugins.
        """
        import json as _json
        try:
            result = subprocess.run(
                ["hermes", "plugins", "list", "--json"],
                capture_output=True, text=True, timeout=30,
                env={**os.environ, "HERMES_HOME": str(self._home)},
            )
        except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
            log.warning("hermes plugins list --json failed: %s", exc)
            return []
        if result.returncode != 0:
            log.warning(
                "hermes plugins list --json rc=%s: %s",
                result.returncode, (result.stderr or "")[:200],
            )
            return []
        try:
            data = _json.loads(result.stdout or "[]")
        except Exception as exc:
            log.warning("hermes plugins list --json parse failed: %s", exc)
            return []
        rows = data if isinstance(data, list) else (
            data.get("plugins") if isinstance(data, dict) else []
        )
        out: list[dict] = []
        for p in rows or []:
            if not isinstance(p, dict):
                continue
            nm = p.get("name") or p.get("key") or ""
            if not nm:
                continue
            out.append({
                "key": nm,
                "name": nm,
                "version": p.get("version") or "",
                "description": p.get("description") or "",
                "source": p.get("source") or "",
                # CLI `status` ∈ {"enabled","not enabled","disabled"} — config-based,
                # the engine's user-facing enabled state.
                "enabled": (p.get("status") == "enabled"),
            })
        return out

    def _force_rediscover(self) -> None:
        """Re-run discovery with force=True so config changes take effect."""
        try:
            from hermes_cli.plugins import discover_plugins
            discover_plugins(force=True)
        except Exception as exc:
            log.warning("force discover failed: %s", exc)

    def _read_config_state(self) -> dict:
        """Read plugins.enabled / plugins.disabled lists from config.yaml."""
        cfg_path = self._home / "config.yaml"
        if not cfg_path.exists():
            return {"enabled": set(), "disabled": set()}
        try:
            data = yaml.safe_load(cfg_path.read_text(encoding="utf-8")) or {}
        except Exception:
            return {"enabled": set(), "disabled": set()}
        plugins = data.get("plugins") if isinstance(data.get("plugins"), dict) else {}
        enabled = plugins.get("enabled") if isinstance(plugins.get("enabled"), list) else []
        disabled = plugins.get("disabled") if isinstance(plugins.get("disabled"), list) else []
        return {
            "enabled": {str(x) for x in enabled if x},
            "disabled": {str(x) for x in disabled if x},
        }

    def _bundled_plugins_dir(self) -> Optional[Path]:
        """Locate the bundled plugins directory (env override + default)."""
        env_path = os.environ.get("HERMES_BUNDLED_PLUGINS")
        if env_path:
            p = Path(env_path)
            if p.is_dir():
                return p
        # Default: <hermes_cli parent>/plugins
        try:
            import hermes_cli
            base = Path(hermes_cli.__file__).resolve().parent.parent
        except Exception:
            return None
        candidate = base / "plugins"
        return candidate if candidate.is_dir() else None

    def _locate_manifest(
        self,
        key: str,
        name: str,
        bundled_dir: Optional[Path],
    ) -> Optional[Path]:
        """Find plugin.yaml for a plugin (user dir first, then bundled)."""
        if not key and not name:
            return None
        search = []
        if self._user_plugins_dir.is_dir():
            search.append(self._user_plugins_dir)
        if bundled_dir is not None and bundled_dir.is_dir():
            search.append(bundled_dir)
        for base in search:
            for candidate_key in {key, name}:
                if not candidate_key:
                    continue
                candidate = base / candidate_key / "plugin.yaml"
                if candidate.exists():
                    return candidate
        return None

    def _read_manifest(self, manifest_path: Optional[Path]) -> dict:
        if not manifest_path or not manifest_path.exists():
            return {}
        try:
            data = yaml.safe_load(manifest_path.read_text(encoding="utf-8")) or {}
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    def _infer_source(
        self,
        manifest_path: Optional[Path],
        bundled_dir: Optional[Path],
    ) -> str:
        if not manifest_path:
            return "unknown"
        if self._user_plugins_dir in manifest_path.parents:
            return "user"
        if bundled_dir is not None and bundled_dir in manifest_path.parents:
            return "bundled"
        return "unknown"

    def _count_plugin_skill_files(self, manifest_path: Optional[Path]) -> int:
        """Walk <plugin>/skills/**/SKILL.md to count skills this plugin ships."""
        if not manifest_path:
            return 0
        skills_dir = manifest_path.parent / "skills"
        if not skills_dir.is_dir():
            return 0
        count = 0
        try:
            for p in skills_dir.rglob("SKILL.md"):
                if p.is_file():
                    count += 1
        except OSError:
            pass
        return count


# -----------------------------------------------------------------
# Helpers
# -----------------------------------------------------------------


def _as_list(value: Any) -> list[str]:
    if value is None:
        return []
    if isinstance(value, list):
        return [str(x) for x in value if x is not None]
    if isinstance(value, str):
        return [value]
    return []


def _normalize_requires_env(value: Any) -> list[dict]:
    """Hermes manifest's requires_env entries can be string OR dict. Normalize
    to dict form for UI consistency: {name, optional?, hint?}."""
    out: list[dict] = []
    if not value:
        return out
    if isinstance(value, list):
        for item in value:
            if isinstance(item, str):
                out.append({"name": item, "optional": False})
            elif isinstance(item, dict):
                name = item.get("name")
                if name:
                    out.append({
                        "name": str(name),
                        "optional": bool(item.get("optional")),
                        "hint": str(item.get("hint") or ""),
                    })
    elif isinstance(value, str):
        out.append({"name": value, "optional": False})
    return out
