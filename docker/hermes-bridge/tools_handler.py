"""
tools_handler.py — REAL Hermes toolsets + per-profile effective tools.

REWRITE 2026-05-26: removed the invented "profile preset"
(Minimal/Coding/Messaging/Full) concept. Hermes has TOOLSETS — that's the
actual granularity. UI shows real Hermes toolsets and which are enabled
for each profile.

Hermes provides:
  - tools.list (engine RPC) → all toolsets with name, description, tool_count, enabled
  - tools.show (engine RPC) → flat tool list grouped by section
  - tools.configure (engine RPC) → enable/disable a toolset (writes to
                                    config.yaml::platform_toolsets.cli)

For per-profile resolution we read the target profile's
config.yaml::platform_toolsets.cli (Hermes' real per-profile enable list)
and report which toolsets are on/off for that profile.

RPC surface (preserved for UI back-compat — UI still calls tools.catalog +
tools.effective, but they now return REAL data):

    tools.catalog  → groups[] of toolsets with their tools
                     + profiles[] mapped to REAL Hermes toolset bundles
                     (we don't invent profiles; "profiles" here is a UI
                      convenience: "default = all enabled", "minimal = just
                      memory" etc — clearly marked as suggestions, never
                      written anywhere)

    tools.effective → toolsets currently enabled for the given profile,
                      grouped by source (core / plugin / channel)
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from hermes_client import HermesClient, HermesRpcError, HermesProcessError

log = logging.getLogger("bridge.tools_handler")


def _classify_toolset_source(name: str) -> tuple[str, str, Optional[str]]:
    """Hermes toolset name → (source, friendly label, plugin/channel id)."""
    if name.startswith("mcp:"):
        pid = name.split(":", 1)[1]
        return ("plugin", f"MCP · {pid}", pid)
    if name.startswith("plugin:"):
        pid = name.split(":", 1)[1]
        return ("plugin", _pretty(pid), pid)
    if name.startswith("channel:"):
        cid = name.split(":", 1)[1]
        return ("channel", _pretty(cid), cid)
    return ("core", _pretty(name), None)


def _pretty(name: str) -> str:
    return name.replace("_", " ").replace("-", " ").strip().title() or name


# -----------------------------------------------------------------
# Public handlers
# -----------------------------------------------------------------


async def build_tools_catalog(
    hermes: HermesClient,
    agents_handler: Any,
    agent_id: str,
    include_plugins: bool = True,
) -> dict:
    """tools.catalog — the agent's toolsets, computed IDENTICALLY to the engine's
    own dashboard (``GET /api/tools/toolsets`` in hermes_cli/web_server.py).

    The dashboard does NOT walk the raw tool registry. It iterates
    ``_get_effective_configurable_toolsets()`` (the curated, *dynamic* set — it
    already includes plugin-contributed toolsets such as ``google_meet`` when the
    plugin is loaded) and marks each enabled via
    ``_get_platform_tools(config, "cli")``. We replicate that exactly, but read
    THIS agent's profile config so on/off is per-agent. Result: /app's "Kemampuan
    Utama" count == the dashboard's "Toolsets" count, 1:1 (28 on chief, 27 on a
    plugin-less vanilla container — the +1 is google_meet).

    Per-tool descriptions are enriched from the engine ``tools.show`` RPC, falling
    back to ``resolve_toolset(name)``.

    ``include_plugins=False`` drops the plugin-contributed toolsets (those NOT in
    the static ``CONFIGURABLE_TOOLSETS``), leaving only the built-in set.
    """
    # Per-tool descriptions (best-effort enrichment; never fatal).
    section_by_ts: dict[str, list[dict]] = {}
    try:
        show_resp = await hermes.call("tools.show", {})
        for s in (show_resp.get("sections") if isinstance(show_resp, dict) else []) or []:
            section_by_ts[str(s.get("name") or "")] = s.get("tools") or []
    except (HermesRpcError, HermesProcessError):
        pass

    # Per-agent enabled state comes from the target profile's own config.yaml.
    cfg = agents_handler._read_hermes_config(agent_id)

    groups: list[dict] = []
    try:
        # Same engine internals the native dashboard uses — the bridge runs in
        # the engine's Python env, so these imports are the source of truth.
        from hermes_cli.tools_config import (  # type: ignore
            CONFIGURABLE_TOOLSETS,
            _get_effective_configurable_toolsets,
            _get_platform_tools,
            gui_toolset_label,
        )
        try:
            from toolsets import resolve_toolset  # type: ignore
        except Exception:  # noqa: BLE001
            resolve_toolset = None  # type: ignore

        # Static built-in set → used to flag which effective toolsets are
        # plugin-contributed (effective − static), so include_plugins works and
        # the UI can label/segregate them accurately.
        static_names = {
            str(t[0] if isinstance(t, (list, tuple)) else t).strip().lower()
            for t in CONFIGURABLE_TOOLSETS
        }
        enabled_set = _get_platform_tools(cfg, "cli", include_default_mcp_servers=False)

        for name, label, desc in _get_effective_configurable_toolsets():
            is_plugin_contributed = name.strip().lower() not in static_names
            if is_plugin_contributed and not include_plugins:
                continue
            source, friendly, plugin_id = _classify_toolset_source(name)
            if is_plugin_contributed and source == "core":
                source = "plugin"

            items: list[dict] = []
            for t in section_by_ts.get(name, []):
                tid = str(t.get("name") or "").strip()
                if tid:
                    items.append({
                        "id": tid,
                        "label": _pretty(tid),
                        "description": (t.get("description") or "").strip(),
                    })
            if not items and resolve_toolset is not None:
                try:
                    for tid in sorted(set(resolve_toolset(name))):
                        items.append({"id": str(tid), "label": _pretty(str(tid)), "description": ""})
                except Exception:  # noqa: BLE001
                    pass

            group: dict = {
                "id": name,
                "label": gui_toolset_label(label) if label else friendly,
                "source": source,
                "enabled": name in enabled_set,
                "toolCount": len(items),
                "description": (desc or "").strip(),
                "tools": items,
            }
            if plugin_id is not None:
                group["pluginId"] = plugin_id
            groups.append(group)
    except Exception as e:  # noqa: BLE001
        # Engine internals renamed/removed on an upstream bump: degrade to an
        # empty-but-valid catalog rather than crash the whole tab.
        log.error("tools.catalog: engine toolset introspection failed (%s)", e)

    enabled_count = sum(1 for g in groups if g["enabled"])
    return {
        "agentId": agent_id,
        "enabledCount": enabled_count,
        "totalToolsets": len(groups),
        "enabledToolsets": sorted(g["id"] for g in groups if g["enabled"]),
        "groups": groups,
    }


async def build_tools_effective(
    hermes: HermesClient,
    agents_handler: Any,
    agent_id: str,
    session_key: Optional[str] = None,
) -> dict:
    """tools.effective — what tools are ACTUALLY active for this profile.

    Reads same data as tools.catalog but flattens to enabled-only view per
    source group (core / plugin / channel).
    """
    catalog = await build_tools_catalog(
        hermes, agents_handler, agent_id, include_plugins=True
    )
    by_source: dict[str, dict] = {}
    for g in catalog["groups"]:
        if not g.get("enabled"):
            continue
        src = g.get("source", "core")
        bucket = by_source.setdefault(src, {
            "id": src,
            "label": src.title(),
            "source": src,
            "tools": [],
        })
        for t in g.get("tools", []):
            bucket["tools"].append({
                "id": t["id"],
                "label": t.get("label") or t["id"],
                "description": (t.get("description") or "").split("\n")[0],
                "rawDescription": t.get("description") or "",
                "source": src,
                "toolset": g["id"],
            })
    return {
        "agentId": agent_id,
        "enabledCount": catalog["enabledCount"],
        "totalToolsets": catalog["totalToolsets"],
        "groups": list(by_source.values()),
    }


def _norm_toolset(name: str) -> str:
    """Brand-insensitive toolset key: drop hermes-/agentbuff-/hermes_/
    agentbuff_ prefixes + lowercase, so agentbuff-telegram == hermes-telegram."""
    n = (name or "").lower()
    for pre in ("agentbuff-", "hermes-", "agentbuff_", "hermes_"):
        if n.startswith(pre):
            n = n[len(pre):]
            break
    return n


async def configure_toolset(
    hermes: HermesClient,
    agents_handler: Any,
    agent_id: str,
    toolset_name: str,
    enable: bool,
) -> dict:
    """Enable/disable a single toolset for a profile.

    Durable write to <profile>/config.yaml::platform_toolsets.cli (the source
    of truth the engine reads on reload) for BOTH active and non-active
    profiles, plus a best-effort live nudge for the active profile. The display
    id (e.g. "agentbuff-telegram") is first resolved to the engine's canonical
    name (e.g. "hermes-telegram") so the add/discard hits the right key.
    """
    # DURABLE write FIRST: explicit platform_toolsets.cli list on the profile's
    # own config.yaml. Operate in the SAME id space as tools.catalog (the UI
    # source of truth): _get_platform_tools() for the CURRENT enabled set + the
    # catalog's own toolset id. 2026-06-08 fix — the old path materialized a
    # fresh agent's cli list from the RAW tools.list registry (~50 internal
    # toolsets: hermes-gateway, browser-cdp, ...), a DIFFERENT id space, which
    # (a) polluted the list with internal toolsets that aren't user-configurable
    # and (b) resolved to canonical names ("browser-cdp") that never matched the
    # catalog id ("browser"), so an off-toggle silently did nothing. Materialize
    # from the effective ENABLED set (exactly what the catalog shows as on) and
    # toggle the catalog id directly.
    try:
        from hermes_cli.tools_config import _get_platform_tools  # type: ignore
    except Exception as e:  # noqa: BLE001
        raise ValueError(f"toolset config unavailable: {e}")

    cfg = agents_handler._read_hermes_config(agent_id)
    pts = cfg.get("platform_toolsets") if isinstance(cfg.get("platform_toolsets"), dict) else {}
    cli_raw = pts.get("cli") if isinstance(pts.get("cli"), list) else None
    if cli_raw is None:
        # No explicit list yet → start from what is ACTUALLY enabled now (matches
        # the catalog exactly), NOT the full raw registry.
        base = set(
            _get_platform_tools(cfg, "cli", include_default_mcp_servers=False)
        )
    else:
        base = {str(n) for n in cli_raw}

    norm = _norm_toolset(toolset_name)
    if enable:
        if not any(_norm_toolset(n) == norm for n in base):
            base.add(toolset_name)
    else:
        # discard EVERY brand-variant (homeassistant / agentbuff-homeassistant
        # both normalize to the same key) so the off-toggle actually removes it.
        base = {n for n in base if _norm_toolset(n) != norm}
    cli_list = sorted(base)
    agents_handler._patch_hermes_config(agent_id, {
        "platform_toolsets": {"cli": cli_list},
    })

    # Active profile: nudge the live session (best-effort; durable write above
    # already guarantees it sticks on reload).
    active = agents_handler._get_active_profile_name()
    if active == agent_id:
        try:
            await hermes.call("tools.configure", {
                "action": "enable" if enable else "disable",
                "names": [toolset_name],
            })
        except (HermesRpcError, HermesProcessError):
            pass

    return {
        "ok": True,
        "agentId": agent_id,
        "toolset": toolset_name,
        "enabled": enable,
        "writtenTo": "config.yaml::platform_toolsets.cli",
    }
