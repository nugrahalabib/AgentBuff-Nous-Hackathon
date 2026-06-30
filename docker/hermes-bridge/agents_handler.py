"""
agents_handler.py — REAL Hermes-native profile manager (rewrite 2026-05-26).

CHIEF MANDATE (2026-05-26): mirror Hermes Desktop's Agents tab using REAL
Hermes profile primitives. The previous version invented a filesystem
overlay at ~/.hermes/agents/<id>/ that the engine NEVER read. This
rewrite drops that overlay completely and uses what Hermes Desktop uses:

  - Default profile  = ~/.hermes (HERMES_HOME itself)
  - Named profiles   = ~/.hermes/profiles/<name>/
  - SOUL.md          = <profile_root>/SOUL.md         (engine reads this)
  - MEMORY.md        = <profile_root>/memories/MEMORY.md
  - USER.md          = <profile_root>/memories/USER.md
  - config.yaml      = <profile_root>/config.yaml      (model, skills, channels)
  - skills/          = <profile_root>/skills/          (installed skills)
  - sessions/        = <profile_root>/sessions/        (chat history)
  - cron/            = <profile_root>/cron/            (scheduled jobs)
  - hooks/           = <profile_root>/hooks/           (event hooks)
  - active_profile   = ~/.hermes/active_profile        (sentinel — which one wins)

AgentBuff identity sidecar (emoji, theme, avatar) goes in:
  - <profile_root>/agentbuff.yaml

Engine never reads agentbuff.yaml — purely UI-side metadata.

CLI delegation: create/delete/use go through `hermes profile` subprocess
(matches HD pattern). Read operations hit the filesystem directly so the
UI is fast.

Backwards compat: the old ~/.hermes/agents/ overlay still exists in
production containers from before the rewrite. `migrate_legacy_overlay()`
runs at handler init to copy any non-empty identity sidecar into the
default profile's agentbuff.yaml and rmtree the overlay dir.
"""

from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import yaml


log = logging.getLogger("bridge.agents_handler")


# Platform-essential skills that must NEVER be disabled, regardless of the
# per-agent allowlist. RAW engine keys here; the UI persists the brand-scrubbed
# name (Buff / Buff-skill-authoring / debugging-agentbuff-tui-commands), so
# set_skill_allowlist subtracts this set from the computed `disabled` list to
# keep them on (fixes the "3 skill selalu off" scrub-mismatch bug, 2026-06-01).
_ALWAYS_ENABLED_SKILLS = {
    "hermes-agent",
    "hermes-agent-skill-authoring",
    "debugging-hermes-tui-commands",
}


# Mirror Hermes' profile name regex (utils.ts:6, profiles.py:33)
# Named profiles: lowercase alphanumeric + underscore + hyphen, 1-64 chars,
# can't start with hyphen.
# M3 (2026-05-30): aligned to engine's _PROFILE_ID_RE (hermes_cli/profiles.py:
# ^[a-z0-9][a-z0-9_-]{0,63}$) — no LEADING underscore. The old bridge regex
# allowed "_foo", which then failed engine validation in `hermes profile
# create` and surfaced as an ugly ENGINE_ERROR instead of a clean
# INVALID_REQUEST at the bridge boundary.
_PROFILE_NAME_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")

# Canonical name for the default profile (HERMES_HOME root).
DEFAULT_PROFILE = "default"

# Files the UI can edit per agent. These live in REAL Hermes locations.
EDITABLE_FILES = frozenset({
    "SOUL.md",                  # <root>/SOUL.md
    "memories/MEMORY.md",       # <root>/memories/MEMORY.md
    "memories/USER.md",         # <root>/memories/USER.md
})

# Hermes Desktop char limits (memory.ts:7-8). We mirror them so the bridge
# rejects oversized writes the same way HD does.
MEMORY_CHAR_LIMIT = 2200
USER_CHAR_LIMIT = 1375
SOUL_MAX_BYTES = 64 * 1024  # 64 KB — Hermes engine reads SOUL into context

# AgentBuff identity sidecar — UI-only metadata (emoji, theme, avatar).
AGENTBUFF_SIDECAR = "agentbuff.yaml"

# Legacy overlay dir from pre-2026-05-26 bridge. Migrated then removed.
LEGACY_AGENTS_DIR = "agents"


class AgentsError(Exception):
    """Operation failed. Maps to RPC error response."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code
        self.message = message


# -----------------------------------------------------------------
# Public handler
# -----------------------------------------------------------------


class AgentsHandler:
    """Hermes-native profile manager."""

    def __init__(self, hermes_home: Path) -> None:
        self._home = Path(hermes_home)
        self._profiles_dir = self._home / "profiles"
        # One-time migration of pre-2026-05-26 overlay
        try:
            self._migrate_legacy_overlay()
        except Exception as e:
            log.warning("legacy overlay migration failed (non-fatal): %s", e)

    # -----------------------------------------------------------------
    # Path resolution — mirrors HD profileHome()
    # -----------------------------------------------------------------

    def profile_home(self, name: Optional[str]) -> Path:
        """Resolve profile name → directory. None/'default' → HERMES_HOME."""
        if name is None or name == "" or name == DEFAULT_PROFILE:
            return self._home
        if not _PROFILE_NAME_RE.match(name):
            raise AgentsError(
                "INVALID_REQUEST",
                f"invalid profile name {name!r}: lowercase + numbers + _- only, 1-64 chars, can't start with -",
            )
        return self._profiles_dir / name

    def file_path(self, profile: Optional[str], filename: str) -> Path:
        """Resolve <profile>/<filename> with traversal protection."""
        if filename not in EDITABLE_FILES:
            raise AgentsError(
                "INVALID_REQUEST",
                f"file {filename!r} not editable; allowlist: {sorted(EDITABLE_FILES)}",
            )
        root = self.profile_home(profile)
        path = root / filename
        # Defense-in-depth: ensure result stays under root
        try:
            path.resolve().relative_to(root.resolve())
        except ValueError:
            raise AgentsError("INVALID_REQUEST", "path traversal blocked")
        return path

    def sidecar_path(self, profile: Optional[str]) -> Path:
        return self.profile_home(profile) / AGENTBUFF_SIDECAR

    # -----------------------------------------------------------------
    # List / get / create / delete — mirrors HD profiles.ts
    # -----------------------------------------------------------------

    async def list_agents(self) -> dict:
        """List all profiles. Default always first, then named alphabetically.

        Returns shape compatible with UI's AgentsListResult:
            { defaultId, mainKey, scope, agents: [AgentRow, ...] }
        """
        active = self._get_active_profile_name()
        agents: list[dict] = []

        # Default profile is HERMES_HOME itself
        agents.append(self._build_agent_row(DEFAULT_PROFILE, is_default=True, is_active=(active == DEFAULT_PROFILE)))

        # Named profiles under ~/.hermes/profiles/
        if self._profiles_dir.is_dir():
            for entry in sorted(self._profiles_dir.iterdir()):
                if not entry.is_dir():
                    continue
                if entry.name.startswith("."):
                    continue
                if not _PROFILE_NAME_RE.match(entry.name):
                    continue
                agents.append(
                    self._build_agent_row(entry.name, is_default=False, is_active=(active == entry.name))
                )

        return {
            "defaultId": DEFAULT_PROFILE,
            "activeId": active or DEFAULT_PROFILE,
            "mainKey": "main",
            "scope": "per-sender",
            "agents": agents,
        }

    async def get_agent(self, agent_id: str) -> dict:
        """Get single agent's profile + identity sidecar."""
        root = self.profile_home(agent_id)
        if not self._profile_exists(agent_id):
            raise AgentsError("NOT_FOUND", f"profile {agent_id!r} does not exist")
        active = self._get_active_profile_name()
        return self._build_agent_row(
            agent_id,
            is_default=(agent_id == DEFAULT_PROFILE),
            is_active=(active == agent_id),
        )

    async def create_agent(
        self,
        agent_id: str,
        profile: Optional[dict] = None,
        soul_content: str = "",
    ) -> dict:
        """Create a new Hermes profile.

        agent_id "default" is reserved — can't create.
        Uses `hermes profile create <name>` subprocess (matches HD pattern).

        Optional profile dict carries UI metadata that goes into the
        agentbuff.yaml sidecar (not Hermes config):
            - identity.{emoji, theme, avatar, name}
            - description, templateId, templateUseCase, etc.

        Optional soul_content writes <root>/SOUL.md after profile creation.
        """
        if agent_id == DEFAULT_PROFILE:
            raise AgentsError("INVALID_REQUEST", "cannot create the default profile")
        if not _PROFILE_NAME_RE.match(agent_id):
            raise AgentsError(
                "INVALID_REQUEST",
                "profile name: lowercase alphanumeric + _- only, 1-64 chars",
            )
        if self._profile_exists(agent_id):
            raise AgentsError("ALREADY_EXISTS", f"profile {agent_id!r} already exists")

        # Call Hermes CLI to create the profile (creates dir structure,
        # seeds bundled skills). Pass --no-alias because AgentBuff users
        # never hit the shell — every interaction goes via gateway WS, so
        # the wrapper script at ~/.local/bin/<id> is dead clutter that
        # pollutes the container PATH. Verified flag exists in hermes
        # profile create --help.
        try:
            result = subprocess.run(
                ["hermes", "profile", "create", "--no-alias", agent_id],
                capture_output=True, text=True, timeout=60,
                env={**os.environ, "HERMES_HOME": str(self._home)},
            )
        except FileNotFoundError:
            raise AgentsError("ENGINE_DOWN", "hermes CLI not on PATH")
        except subprocess.TimeoutExpired:
            raise AgentsError("ENGINE_DOWN", "hermes profile create timed out")
        if result.returncode != 0:
            raise AgentsError(
                "ENGINE_ERROR",
                f"hermes profile create failed: {(result.stderr or result.stdout).strip()}",
            )

        # SOUL.md handling — CRITICAL: hermes CLI seeded its default which
        # leaks "You are Hermes Agent... created by Nous Research" brand.
        # Replace it on every fresh create:
        #   - If caller passed soul_content (e.g. template flow) → use that.
        #   - Else → fall back to DEFAULT_SOUL_AGENTBUFF so the new agent
        #     introduces itself as "Buff" not "Hermes Agent".
        # This is anti-overwrite-safe because create_agent only runs ONCE
        # at profile creation; subsequent edits via set_file are preserved
        # (we never re-seed an existing profile's SOUL outside this path).
        soul_path = self.profile_home(agent_id) / "SOUL.md"
        soul_to_write = soul_content.strip() if soul_content else DEFAULT_SOUL_AGENTBUFF
        self._atomic_write(soul_path, soul_to_write)
        # Snapshot the create-time SOUL as THIS agent's "factory default" so a
        # later Reset restores its real persona (rich, archetype + owner aware) —
        # NOT a generic "Buff/Chief" template (chief: "kalau di-reset jadi sampah
        # jelek ga berguna?"). Hidden dotfile, not shown in the Persona file list.
        self._atomic_write(
            self.profile_home(agent_id) / ".soul_default.md", soul_to_write
        )

        # Memory files (memories/MEMORY.md, memories/USER.md) are intentionally
        # NOT pre-seeded. The owner context (name, role, business, jurusan, city)
        # now lives in SOUL.md (built from the onboarding data), so a
        # "# Tentang Chief" template here is redundant AND wrongly hardcodes
        # "Chief" (chief 2026-06-16: "ini harusnya kosong … udah jelas semua di
        # soul.md"). A fresh agent starts with EMPTY long-term memory; the engine
        # creates + fills these files itself when it actually writes memory.
        (self.profile_home(agent_id) / "memories").mkdir(parents=True, exist_ok=True)

        # Write AgentBuff identity sidecar
        if profile:
            self._write_sidecar(agent_id, _extract_sidecar_payload(profile))

        # Skill scope: NO forcing. Per chief's mandate ("persis vanilla, semua
        # 94 nyala") a new agent starts with ALL skills ENABLED (skills.disabled
        # empty, no sidecar allowlist) — same as the default's CORRECT baseline.
        # We deliberately do NOT copy the default's skills.disabled: the default
        # may carry a stale curation (the "tiba-tiba reset" bug), and inheriting
        # it would propagate that. `hermes profile create` already yields
        # disabled=[] → all-on, which is exactly the baseline. Nothing to do.

        log.info("agents: created profile %r", agent_id)
        return await self.get_agent(agent_id)

    async def update_agent(self, agent_id: str, patch: dict) -> dict:
        """Patch agent identity / metadata.

        Identity fields (emoji, theme, avatar, name, description, templateId,
        ...) write to <profile>/agentbuff.yaml sidecar.

        Model field (model.primary, model.fallbacks) writes to REAL Hermes
        config.yaml::model.{default,fallbacks}.

        Skills field (skills array) writes to REAL config.yaml — uses
        skills.disabled inverted from allowlist when non-empty.

        Tools.profile / .alsoAllow / .deny — deprecated, kept silently
        ignored to avoid breaking older UI versions that still send them.

        Default flag — calls `hermes profile use <name>` to set active.
        """
        if not isinstance(patch, dict):
            raise AgentsError("INVALID_REQUEST", "patch must be a dict")
        if not self._profile_exists(agent_id):
            raise AgentsError("NOT_FOUND", f"profile {agent_id!r} does not exist")

        # ── Default flag → DELIBERATELY a no-op ───────────────────────
        # H1 (2026-05-30): the portal must NOT write the engine
        # `active_profile` sentinel. HERMES_HOME is pinned to the root
        # ("default") profile for this container; writing the sentinel
        # repoints the engine + the `hermes gateway run` channel runtime to a
        # named profile on the next restart/respawn (split-brain: portal reads
        # default, channels run the named profile). The AgentBuff "default
        # agent" = the engine root profile = immutable per container, so there
        # is nothing to switch. We accept the flag for backward-compat with
        # older UI builds but do not act on it.
        if patch.get("default") is True:
            log.info(
                "agents: ignoring default=True for %r — engine profile is "
                "pinned to root (no active_profile sentinel write)", agent_id,
            )

        # ── Model → real config.yaml::model.{default,fallbacks} ───────
        # UI sends model.{primary,fallbacks}; Hermes canonical key is
        # model.default. Map + WRAP under `model` — passing the inner dict
        # straight to _patch_hermes_config would merge {primary,default} at
        # the config ROOT (not under `model`), so the routing hook +
        # _build_agent_row (both read model.default) would never see it.
        model_patch = patch.get("model")
        if isinstance(model_patch, dict):
            hermes_model: dict = {}
            primary = model_patch.get("default") or model_patch.get("primary")
            if isinstance(primary, str) and primary.strip():
                primary = primary.strip()
                hermes_model["default"] = primary
                # Keep the non-canonical `primary` key in lock-step with the
                # canonical `default`. Previously only `default` was rewritten,
                # leaving a STALE `model.primary` (e.g. an old gemini id) that
                # desynced the config + could confuse any path reading `primary`.
                hermes_model["primary"] = primary
                # Set the CORRECT provider for the chosen model so the engine
                # routes it to the right endpoint. `providerSlug` is resolved
                # upstream (rpc_router) from model.options' provider groups —
                # without it the engine mis-infers (e.g. a Codex model
                # "gpt-5.4-mini" went to gemini → HTTP 404; a custom model with
                # no base_url → "no endpoint credentials"). Custom additionally
                # needs its base_url/api_key stamped into THIS profile (scoped —
                # a global write once made gemini report an 8192 ctx window).
                slug = (model_patch.get("providerSlug") or "").strip()
                if slug == "custom":
                    cust = _read_custom_provider_cfg() or {}
                    hermes_model["provider"] = "custom"
                    hermes_model["base_url"] = cust.get("base_url")
                    hermes_model["api_key"] = cust.get("api_key") or "local"
                elif slug:
                    # Known provider (openai-codex / gemini / deepseek / …):
                    # route there + clear any stale custom-endpoint creds.
                    hermes_model["provider"] = slug
                    hermes_model["base_url"] = None
                    hermes_model["api_key"] = None
                else:
                    # Provider couldn't be resolved — clear custom routing and
                    # let the engine infer from the model id.
                    hermes_model["base_url"] = None
                    hermes_model["api_key"] = None
                    hermes_model["provider"] = None
            # NOTE: do NOT write model.fallbacks — the engine IGNORES it
            # (get_fallback_chain reads ONLY top-level fallback_providers). The
            # fallback chain is written as fallback_providers just below.
            if hermes_model:
                self._patch_hermes_config(agent_id, {"model": hermes_model})

            # Fallback chain → TOP-LEVEL fallback_providers (the field the engine
            # ACTUALLY reads). UI sends model.fallbacks=[{provider,model}] (provider
            # resolved upstream in rpc_router). Empty list clears the chain.
            if isinstance(model_patch.get("fallbacks"), list):
                fb_chain = []
                for e in model_patch["fallbacks"]:
                    if isinstance(e, str) and e.strip():
                        # Bare model-id (UI shape). Provider is normally resolved
                        # upstream in rpc_router; "" is a safe fallback (engine
                        # infers from the model id).
                        fb_chain.append({"provider": "", "model": e.strip()})
                    elif isinstance(e, dict) and (e.get("model") or "").strip():
                        fb_chain.append({
                            "provider": (e.get("provider") or "").strip(),
                            "model": (e.get("model") or "").strip(),
                        })
                self._patch_hermes_config(agent_id, {"fallback_providers": fb_chain})

        # ── Auxiliary per-task models → auxiliary.<task>.{provider,model}.
        #    provider "auto" = use the agent's main model for that side task. ─────
        aux_patch = patch.get("auxiliary")
        if isinstance(aux_patch, dict) and aux_patch:
            aux_write: dict = {}
            for task, v in aux_patch.items():
                if not isinstance(v, dict):
                    continue
                prov = (v.get("provider") or "auto").strip() or "auto"
                mdl = (v.get("model") or "").strip()
                aux_write[str(task)] = (
                    {"provider": "auto", "model": ""}
                    if prov == "auto" or not mdl
                    else {"provider": prov, "model": mdl}
                )
            if aux_write:
                self._patch_hermes_config(agent_id, {"auxiliary": aux_write})

        # ── Context window → top-level model_context_length (0 = auto-detect). ───
        if "modelContextLength" in patch:
            try:
                cl = int(patch.get("modelContextLength") or 0)
            except (TypeError, ValueError):
                cl = 0
            self._patch_hermes_config(agent_id, {"model_context_length": max(0, cl)})

        # ── Sidecar identity / description ────────────────────────────
        sidecar = self._read_sidecar(agent_id)
        sidecar_changes = _extract_sidecar_payload(patch)
        if sidecar_changes:
            # Deep-merge identity / nested fields
            new_sidecar = dict(sidecar)
            for k, v in sidecar_changes.items():
                if k == "identity" and isinstance(v, dict) and isinstance(sidecar.get("identity"), dict):
                    merged_identity = dict(sidecar["identity"])
                    merged_identity.update(v)
                    new_sidecar["identity"] = merged_identity
                else:
                    new_sidecar[k] = v
            self._write_sidecar(agent_id, new_sidecar)

        log.info("agents: updated %r (keys: %s)", agent_id, sorted(patch.keys()))
        return await self.get_agent(agent_id)

    async def delete_agent(self, agent_id: str) -> dict:
        """Delete a named profile. 'default' (HERMES_HOME) cannot be deleted."""
        if agent_id == DEFAULT_PROFILE:
            raise AgentsError(
                "INVALID_REQUEST",
                "cannot delete the default profile",
            )
        if not _PROFILE_NAME_RE.match(agent_id):
            raise AgentsError("INVALID_REQUEST", "invalid profile name")
        if not self._profile_exists(agent_id):
            raise AgentsError("NOT_FOUND", f"profile {agent_id!r} does not exist")

        try:
            result = subprocess.run(
                ["hermes", "profile", "delete", agent_id, "--yes"],
                capture_output=True, text=True, timeout=30,
                env={**os.environ, "HERMES_HOME": str(self._home)},
            )
        except FileNotFoundError:
            raise AgentsError("ENGINE_DOWN", "hermes CLI not on PATH")
        except subprocess.TimeoutExpired:
            raise AgentsError("ENGINE_DOWN", "hermes profile delete timed out")
        if result.returncode != 0:
            # Fall back to filesystem rm if CLI failed
            log.warning("hermes profile delete failed, falling back to rmtree: %s",
                        (result.stderr or result.stdout).strip())
            try:
                shutil.rmtree(self.profile_home(agent_id))
            except OSError as e:
                raise AgentsError("IO_ERROR", f"rmtree failed: {e}")

        log.info("agents: deleted profile %r", agent_id)
        return {"deleted": agent_id}

    async def clone_agent(
        self,
        source_id: str,
        new_id: str,
        new_name: Optional[str] = None,
        new_emoji: Optional[str] = None,
    ) -> dict:
        """Clone source profile → new named profile.

        Uses `hermes profile create <new> --clone` when source is default,
        or filesystem copy + CLI-equivalent steps for named-source clone.
        Either way the result is a real Hermes profile.
        """
        if source_id == new_id:
            raise AgentsError("INVALID_REQUEST", "source and new id must differ")
        if new_id == DEFAULT_PROFILE:
            raise AgentsError("INVALID_REQUEST", "new id cannot be 'default'")
        if not _PROFILE_NAME_RE.match(new_id):
            raise AgentsError("INVALID_REQUEST", "invalid new profile name")
        if not self._profile_exists(source_id):
            raise AgentsError("NOT_FOUND", f"source profile {source_id!r} does not exist")
        if self._profile_exists(new_id):
            raise AgentsError("ALREADY_EXISTS", f"profile {new_id!r} already exists")

        if source_id == DEFAULT_PROFILE:
            # Hermes CLI directly supports `--clone` (= clone default's config)
            try:
                result = subprocess.run(
                    ["hermes", "profile", "create", new_id, "--clone"],
                    capture_output=True, text=True, timeout=90,
                    env={**os.environ, "HERMES_HOME": str(self._home)},
                )
            except FileNotFoundError:
                raise AgentsError("ENGINE_DOWN", "hermes CLI not on PATH")
            except subprocess.TimeoutExpired:
                raise AgentsError("ENGINE_DOWN", "hermes profile create --clone timed out")
            if result.returncode != 0:
                raise AgentsError(
                    "ENGINE_ERROR",
                    f"clone failed: {(result.stderr or result.stdout).strip()}",
                )
        else:
            # Named-source clone: create fresh + manually copy clone files.
            try:
                result = subprocess.run(
                    ["hermes", "profile", "create", new_id],
                    capture_output=True, text=True, timeout=60,
                    env={**os.environ, "HERMES_HOME": str(self._home)},
                )
            except FileNotFoundError:
                raise AgentsError("ENGINE_DOWN", "hermes CLI not on PATH")
            if result.returncode != 0:
                raise AgentsError(
                    "ENGINE_ERROR",
                    f"create stub for clone failed: {(result.stderr or result.stdout).strip()}",
                )
            src_root = self.profile_home(source_id)
            dst_root = self.profile_home(new_id)
            # NOTE: .env is intentionally NOT cloned — it holds the source
            # agent's channel credentials (bot tokens). Cloning them would make
            # two agents claim the same bot token (session conflict) and leak
            # channel creds into the clone; the clone re-pairs its own channels.
            # (Audit 2026-06-10 — C1 clone-credential leak.)
            for rel in ("config.yaml", "SOUL.md", "memories/MEMORY.md", "memories/USER.md"):
                src = src_root / rel
                if src.exists():
                    dst = dst_root / rel
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst)
            # Copy capability/automation dirs if they exist. skills/ was always
            # copied; hooks/ + cron/ were previously dropped, silently losing
            # the clone's event hooks + scheduled jobs (audit 2026-06-10 HIGH #11).
            for sub in ("skills", "hooks", "cron"):
                src_sub = src_root / sub
                if src_sub.is_dir():
                    shutil.copytree(src_sub, dst_root / sub, dirs_exist_ok=True)

        # Copy AgentBuff sidecar + override name/emoji
        src_sidecar = self._read_sidecar(source_id)
        new_sidecar = dict(src_sidecar)
        new_sidecar.pop("default", None)  # never inherit default flag
        identity = dict(new_sidecar.get("identity") or {})
        if new_name:
            new_sidecar["name"] = new_name
            identity["name"] = new_name
        else:
            base = src_sidecar.get("name") or source_id
            new_sidecar["name"] = f"{base} (copy)"
            identity["name"] = new_sidecar["name"]
        if new_emoji is not None:
            identity["emoji"] = new_emoji
        new_sidecar["identity"] = identity
        new_sidecar["cloned_from"] = source_id
        new_sidecar["created_at"] = datetime.now(timezone.utc).isoformat()
        self._write_sidecar(new_id, new_sidecar)

        log.info("agents: cloned %r → %r", source_id, new_id)
        return await self.get_agent(new_id)

    # -----------------------------------------------------------------
    # File operations — REAL Hermes locations
    # -----------------------------------------------------------------

    async def list_files(self, agent_id: str) -> dict:
        """List Hermes-native editable files for the profile."""
        if not self._profile_exists(agent_id):
            raise AgentsError("NOT_FOUND", f"profile {agent_id!r} does not exist")
        files = []
        for rel in sorted(EDITABLE_FILES):
            path = self.file_path(agent_id, rel)
            if path.exists():
                stat = path.stat()
                files.append({
                    "name": rel,
                    "path": rel,
                    "size": stat.st_size,
                    "mtime": stat.st_mtime,
                    # Portal-facing fields (AgentFileEntry): epoch-ms + existence
                    # flag. The portal reads updatedAtMs/missing, not mtime.
                    "updatedAtMs": int(stat.st_mtime * 1000),
                    "missing": False,
                })
            else:
                files.append({
                    "name": rel,
                    "path": rel,
                    "size": 0,
                    "mtime": None,
                    "updatedAtMs": None,
                    "missing": True,
                })
        return {"files": files, "agentId": agent_id}

    async def get_file(self, agent_id: str, filename: str) -> dict:
        """Read a real Hermes file from the profile."""
        if not self._profile_exists(agent_id):
            raise AgentsError("NOT_FOUND", f"profile {agent_id!r} does not exist")
        path = self.file_path(agent_id, filename)
        if not path.exists():
            return {"name": filename, "content": "", "agentId": agent_id, "exists": False}
        try:
            content = path.read_text(encoding="utf-8")
        except OSError as e:
            raise AgentsError("IO_ERROR", f"read failed: {e}")
        return {"name": filename, "content": content, "agentId": agent_id, "exists": True}

    async def set_file(self, agent_id: str, filename: str, content: str) -> dict:
        """Atomic write to real Hermes file location.

        Enforces per-file size caps (MEMORY/USER limits, SOUL max bytes).
        Creates parent dir if missing (e.g. memories/ may not exist on fresh
        named profiles).
        """
        if not isinstance(content, str):
            raise AgentsError("INVALID_REQUEST", "content must be a string")
        if not self._profile_exists(agent_id):
            raise AgentsError("NOT_FOUND", f"profile {agent_id!r} does not exist")
        path = self.file_path(agent_id, filename)
        nbytes = len(content.encode("utf-8"))
        # Per-file size caps (match HD)
        if filename == "memories/MEMORY.md" and len(content) > MEMORY_CHAR_LIMIT:
            raise AgentsError(
                "TOO_LARGE",
                f"MEMORY.md exceeds {MEMORY_CHAR_LIMIT} chars ({len(content)})",
            )
        if filename == "memories/USER.md" and len(content) > USER_CHAR_LIMIT:
            raise AgentsError(
                "TOO_LARGE",
                f"USER.md exceeds {USER_CHAR_LIMIT} chars ({len(content)})",
            )
        if filename == "SOUL.md" and nbytes > SOUL_MAX_BYTES:
            raise AgentsError(
                "TOO_LARGE",
                f"SOUL.md exceeds {SOUL_MAX_BYTES} bytes ({nbytes})",
            )
        path.parent.mkdir(parents=True, exist_ok=True)
        self._atomic_write(path, content)
        log.info("agents: wrote %s for %r (%d bytes)", filename, agent_id, nbytes)
        return {"name": filename, "size": nbytes, "agentId": agent_id}

    async def reset_file(self, agent_id: str, filename: str) -> dict:
        """Restore SOUL.md to THIS agent's create-time persona (the snapshot
        written at create), so a reset gives back the agent's real rich SOUL —
        not a generic 'Buff/Chief' template. Falls back to DEFAULT_SOUL_AGENTBUFF
        only when no snapshot exists (agents created before snapshots, or the
        house 'Buff' default agent)."""
        if filename != "SOUL.md":
            raise AgentsError(
                "INVALID_REQUEST",
                "only SOUL.md is reset-able (memories must be user-curated)",
            )
        snap = self.profile_home(agent_id) / ".soul_default.md"
        try:
            if snap.is_file():
                content = snap.read_text(encoding="utf-8").strip()
                if content:
                    return await self.set_file(agent_id, "SOUL.md", content)
        except OSError:
            pass
        return await self.set_file(agent_id, "SOUL.md", DEFAULT_SOUL_AGENTBUFF)

    async def get_soul_content(self, agent_id: str) -> str:
        """Read SOUL.md for prompt.submit overlay. Used by chat.send routing."""
        try:
            res = await self.get_file(agent_id, "SOUL.md")
            return res.get("content") or ""
        except AgentsError:
            return ""

    # -----------------------------------------------------------------
    # Multi-agent session routing — preserve Sprint May 11 pattern
    # -----------------------------------------------------------------

    async def resolve_agent_for_session(self, session_key: str) -> dict:
        """Parse 'agent:<id>:<rest>' session_key and return agent profile.

        Multi-agent routing semantics: the prefix tells the bridge which
        profile's SOUL/model overlay to use for THIS turn's prompt.submit.
        The Hermes engine itself runs ONE active profile (HERMES_HOME),
        but the bridge can inject per-turn overlay context.

        If the prefix references a profile that doesn't exist, fall back
        to the default profile.
        """
        from event_translator import decanonicalize_session_key

        agent_id, _ = decanonicalize_session_key(session_key)
        if agent_id and self._profile_exists(agent_id):
            try:
                return await self.get_agent(agent_id)
            except AgentsError:
                pass
        return await self.get_agent(DEFAULT_PROFILE)

    # -----------------------------------------------------------------
    # Sidecar (AgentBuff identity metadata) — UI-only, engine ignores
    # -----------------------------------------------------------------

    def _read_sidecar(self, agent_id: str) -> dict:
        path = self.sidecar_path(agent_id)
        if not path.exists():
            return {}
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    def _write_sidecar(self, agent_id: str, payload: dict) -> None:
        path = self.sidecar_path(agent_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = dict(payload)
        payload["updated_at"] = datetime.now(timezone.utc).isoformat()
        try:
            text = yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)
        except yaml.YAMLError as e:
            raise AgentsError("IO_ERROR", f"sidecar serialize failed: {e}")
        self._atomic_write(path, text)

    # -----------------------------------------------------------------
    # Skill allowlist — writes to REAL config.yaml::skills.disabled
    # -----------------------------------------------------------------

    async def set_skill_allowlist(self, agent_id: str, skill_names: list[str]) -> dict:
        """Per-agent (= per-profile) skill scope via real Hermes config.

        Hermes' skills.disabled config is a GLOBAL list of disabled skill
        names. We invert allowlist semantics by computing
        disabled = (all_skills - allowlist) and writing that. Empty
        allowlist = clear disabled list (allow all).
        """
        if not isinstance(skill_names, list):
            raise AgentsError("INVALID_REQUEST", "skills must be a list")
        if not self._profile_exists(agent_id):
            raise AgentsError("NOT_FOUND", f"profile {agent_id!r} does not exist")

        allowlist = sorted({s.strip() for s in skill_names if isinstance(s, str) and s.strip()})

        if not allowlist:
            # Clear disabled list = allow all
            self._patch_hermes_config(agent_id, {"skills": {"disabled": None}})
        else:
            # Compute disabled = all_known_skills - allowlist, MINUS the
            # platform-essential skills that must ALWAYS stay enabled. They use
            # the RAW engine key (hermes-agent / hermes-agent-skill-authoring /
            # debugging-hermes-tui-commands), but the UI persists their
            # BRAND-SCRUBBED name (Buff / Buff-skill-authoring /
            # debugging-agentbuff-tui-commands). Without this subtraction the raw
            # key always falls into `disabled` (scrubbed != raw) and the skill can
            # never stay on — that was the "3 skill selalu off" bug (2026-06-01).
            all_skills = self._scan_skill_names(agent_id)
            # Agent-authored skills are NEVER auto-disabled by an allowlist edit.
            # They live in their own tab + are gated only by skills.disabled
            # directly (see set_agent_skill_disabled). Excluding them here means
            # editing the builtin allowlist can't retroactively block a skill the
            # agent created after the allowlist was materialized.
            agent_created = self._agent_created_skill_names(all_skills)
            disabled = sorted(
                all_skills - set(allowlist) - _ALWAYS_ENABLED_SKILLS - agent_created
            )
            self._patch_hermes_config(
                agent_id, {"skills": {"disabled": disabled if disabled else None}}
            )

        # Also store allowlist in sidecar so UI can show "what's allowed"
        # without recomputing the inversion every render.
        sidecar = self._read_sidecar(agent_id)
        sidecar["skills_allowlist"] = allowlist
        self._write_sidecar(agent_id, sidecar)

        return await self.get_agent(agent_id)

    def _scan_skill_names(self, agent_id: str) -> set[str]:
        """All skill names the engine knows about — the universe used to invert
        the allowlist into skills.disabled.

        CRITICAL: must match the SAME universe the UI skill picker lists
        (skills_extras.build_skills_status → tools.skills_tool._find_all_skills),
        which includes BUNDLED skills shipped in the Hermes package dir — NOT
        just the per-profile <profile>/skills/ dir. The old per-profile-only walk
        missed bundled skills, so de-selecting a bundled skill in the allowlist
        never added it to `disabled` and the toggle silently failed (P1 fix
        2026-05-30). Engine introspection first, profile-dir walk as fallback."""
        out: set[str] = set()
        try:
            from tools.skills_tool import _find_all_skills  # type: ignore
            for s in _find_all_skills(skip_disabled=True) or []:
                nm = str((s or {}).get("name") or "").strip()
                if nm:
                    out.add(nm)
        except Exception:
            log.warning("set_skill_allowlist: _find_all_skills unavailable; "
                        "falling back to profile-dir scan", exc_info=True)
        # Union with the per-profile skills dir so profile-local skills the
        # engine introspection might miss are still covered.
        skills_dir = self.profile_home(agent_id) / "skills"
        if skills_dir.is_dir():
            for cat in skills_dir.iterdir():
                if not cat.is_dir():
                    continue
                for skill in cat.iterdir():
                    if skill.is_dir() and (skill / "SKILL.md").exists():
                        out.add(skill.name)
        return out

    def _read_builtin_baseline(self) -> set[str]:
        """The factory skill set = builtin (vanilla) skills snapshotted at
        provision time (~/.hermes/skills/.agentbuff_builtin_baseline.json).
        Empty set if not captured yet."""
        import json as _json
        home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
        path = Path(home) / "skills" / ".agentbuff_builtin_baseline.json"
        try:
            return set(_json.loads(path.read_text(encoding="utf-8")))
        except Exception:
            return set()

    def _agent_created_skill_names(self, all_names: set[str]) -> set[str]:
        """Skills authored by an agent = those NOT in the builtin baseline
        snapshot. Mirrors skills_extras' detection so the two agree."""
        baseline = self._read_builtin_baseline()
        if not baseline:
            return set()
        return {n for n in all_names if n not in baseline}

    async def reset_skills_to_factory(self, agent_id: str) -> dict:
        """Reset skills to the factory baseline.

        - Every BUILTIN (vanilla) skill → ON (cleared from skills.disabled).
        - Every NON-builtin skill (agent-authored or marketplace-bought) → OFF
          but KEPT on disk (added to skills.disabled, files untouched).
        - Clears the user's allowlist sidecar.
        The user can still toggle anything manually afterwards.
        """
        if not self._profile_exists(agent_id):
            raise AgentsError("NOT_FOUND", f"profile {agent_id!r} does not exist")
        # Universe = the skills the UI actually shows (skills.status uses
        # _find_all_skills), which is the SAME universe the baseline was
        # captured from. Using _scan_skill_names here would also sweep in
        # profile-dir-only skills that never surface in the UI and wrongly
        # disable them.
        try:
            from tools.skills_tool import _find_all_skills  # type: ignore
            all_skills = {
                str(s.get("name") or "").strip()
                for s in (_find_all_skills(skip_disabled=True) or [])
            }
            all_skills.discard("")
        except Exception:
            all_skills = self._scan_skill_names(agent_id)
        baseline = self._read_builtin_baseline()
        # Safety: if the baseline was never captured, do NOT disable everything —
        # just clear to all-on (engine default).
        non_builtin = sorted(all_skills - baseline) if baseline else []
        self._patch_hermes_config(
            agent_id, {"skills": {"disabled": non_builtin if non_builtin else None}}
        )
        sidecar = self._read_sidecar(agent_id)
        sidecar["skills_allowlist"] = []
        self._write_sidecar(agent_id, sidecar)
        return {
            "ok": True,
            "agentId": agent_id,
            "builtinOn": len(baseline & all_skills) if baseline else len(all_skills),
            "nonBuiltinOff": len(non_builtin),
        }

    async def set_agent_skill_disabled(
        self, agent_id: str, name: str, disabled: bool
    ) -> dict:
        """Toggle a SINGLE skill's per-agent disabled state directly in
        skills.disabled — the engine-native gate, bypassing the allowlist
        whitelist. Used by the "Buatan Agen" tab so agent-created skills reflect
        (and control) the real engine state instead of the synthetic allowlist.
        """
        name = (name or "").strip()
        if not name:
            raise AgentsError("INVALID_REQUEST", "name required")
        if not self._profile_exists(agent_id):
            raise AgentsError("NOT_FOUND", f"profile {agent_id!r} does not exist")
        cfg = self._read_hermes_config(agent_id) or {}
        cur = set((cfg.get("skills") or {}).get("disabled") or [])
        if disabled:
            cur.add(name)
        else:
            cur.discard(name)
        new_list = sorted(cur)
        self._patch_hermes_config(
            agent_id, {"skills": {"disabled": new_list if new_list else None}}
        )
        return {"ok": True, "name": name, "disabled": disabled}

    # -----------------------------------------------------------------
    # Internal — Hermes config patching, profile inspection
    # -----------------------------------------------------------------

    def _profile_exists(self, agent_id: str) -> bool:
        if agent_id == DEFAULT_PROFILE:
            return True
        if not _PROFILE_NAME_RE.match(agent_id):
            return False
        return (self._profiles_dir / agent_id).is_dir()

    def _get_active_profile_name(self) -> Optional[str]:
        """Read ~/.hermes/active_profile sentinel. Returns 'default' if missing."""
        sentinel = self._home / "active_profile"
        if not sentinel.exists():
            return DEFAULT_PROFILE
        try:
            name = sentinel.read_text(encoding="utf-8").strip()
            return name or DEFAULT_PROFILE
        except OSError:
            return DEFAULT_PROFILE

    def _set_active_profile(self, agent_id: str) -> None:
        """Write the active_profile sentinel (mirrors `hermes profile use`)."""
        sentinel = self._home / "active_profile"
        try:
            self._atomic_write(sentinel, agent_id)
        except OSError as e:
            raise AgentsError("IO_ERROR", f"set active profile failed: {e}")

    def _read_hermes_config(self, agent_id: str) -> dict:
        path = self.profile_home(agent_id) / "config.yaml"
        if not path.exists():
            return {}
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        return data if isinstance(data, dict) else {}

    def _patch_hermes_config(self, agent_id: str, patch: dict) -> None:
        """RFC 7396 merge-patch onto the profile's config.yaml.

        For the default profile this hits ~/.hermes/config.yaml — which the
        existing config_handler.py also writes. Bridge config_handler is for
        the active profile; this is for whichever profile the user is
        editing. Both serialize via yaml.safe_dump.
        """
        path = self.profile_home(agent_id) / "config.yaml"
        current = self._read_hermes_config(agent_id)
        merged = _merge_patch(current, patch)
        path.parent.mkdir(parents=True, exist_ok=True)
        try:
            text = yaml.safe_dump(merged, allow_unicode=True, sort_keys=False)
        except yaml.YAMLError as e:
            raise AgentsError("IO_ERROR", f"config serialize failed: {e}")
        self._atomic_write(path, text)

    def _build_agent_row(self, agent_id: str, is_default: bool, is_active: bool) -> dict:
        """Compose UI-friendly AgentRow from real filesystem + sidecar."""
        root = self.profile_home(agent_id)
        sidecar = self._read_sidecar(agent_id)
        config = self._read_hermes_config(agent_id)

        # Identity priority: sidecar.identity > sidecar.name > profile name
        identity = sidecar.get("identity") if isinstance(sidecar.get("identity"), dict) else {}
        name = identity.get("name") or sidecar.get("name") or agent_id
        emoji = identity.get("emoji") or ""
        theme = identity.get("theme") or "indigo"
        avatar = identity.get("avatar") or None

        # Model from REAL config.yaml::model.default
        model_block = config.get("model") if isinstance(config.get("model"), dict) else {}
        primary = model_block.get("default") or ""
        # Fallback chain — the REAL engine field is TOP-LEVEL `fallback_providers`
        # (get_fallback_chain reads ONLY fallback_providers + legacy fallback_model;
        # it IGNORES model.fallbacks). Expose as [{provider, model}] for the UI.
        fp_raw = config.get("fallback_providers")
        # Expose as a flat list of model-ids (string[]) — the shape the UI's
        # fallback picker already uses. The provider per entry is re-resolved on
        # write (rpc_router) so we don't need to round-trip it through the UI.
        fallbacks = (
            [
                str(e.get("model"))
                for e in fp_raw
                if isinstance(e, dict) and e.get("model")
            ]
            if isinstance(fp_raw, list)
            else []
        )
        # Auxiliary per-task models (auxiliary.<task>.{provider,model}); provider
        # "auto" (or absent) = use the agent's main model for that side task.
        aux_raw = config.get("auxiliary") if isinstance(config.get("auxiliary"), dict) else {}
        auxiliary = {
            str(task): {
                "provider": (v.get("provider") or "auto"),
                "model": (v.get("model") or ""),
            }
            for task, v in aux_raw.items()
            if isinstance(v, dict)
        }
        # Context window override — top-level `model_context_length` (0 = auto-detect).
        ctx_len = config.get("model_context_length")
        context_length = ctx_len if isinstance(ctx_len, int) and ctx_len > 0 else 0

        # Skills: from sidecar allowlist (UI semantic) — but raw filesystem
        # always wins for what's actually installed.
        skills_allowlist = sidecar.get("skills_allowlist") if isinstance(sidecar.get("skills_allowlist"), list) else []

        # Provider hint: prefer config, fallback to "auto"
        provider = model_block.get("provider") or "auto"

        # File existence + counts
        has_soul = (root / "SOUL.md").exists()
        has_env = (root / ".env").exists()
        memory_path = root / "memories" / "MEMORY.md"
        memory_exists = memory_path.exists()
        skill_count = len(self._scan_skill_names(agent_id))

        # Gateway running detection (matches HD pattern)
        gateway_pid_file = root / "gateway.pid"
        gateway_running = gateway_pid_file.exists()

        row: dict = {
            "id": agent_id,
            "name": name,
            "default": is_default,
            "active": is_active,
            "identity": {
                "name": name,
                "emoji": emoji,
                "theme": theme,
                "avatar": avatar,
            },
            "workspace": str(root),
            "model": {
                "primary": primary,
                "fallbacks": fallbacks,
                "provider": provider,
                "auxiliary": auxiliary,
                "contextLength": context_length,
            },
            "skills": skills_allowlist,
            "skillCount": skill_count,
            "hasEnv": has_env,
            "hasSoul": has_soul,
            "hasMemory": memory_exists,
            "gatewayRunning": gateway_running,
            "description": sidecar.get("description") or "",
            "description_auto": bool(sidecar.get("description_auto")),
        }
        if sidecar.get("templateId"):
            row["templateId"] = sidecar["templateId"]
        if sidecar.get("templateUseCase"):
            row["templateUseCase"] = sidecar["templateUseCase"]
        if sidecar.get("cloned_from"):
            row["cloned_from"] = sidecar["cloned_from"]
        if sidecar.get("imported_from"):
            row["imported_from"] = sidecar["imported_from"]
        return row

    # -----------------------------------------------------------------
    # Atomic write helper
    # -----------------------------------------------------------------

    def _atomic_write(self, path: Path, content: str) -> None:
        import tempfile
        path.parent.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(
            prefix=f".{path.name}.tmp.",
            dir=str(path.parent),
        )
        try:
            with os.fdopen(fd, "wb") as f:
                f.write(content.encode("utf-8"))
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

    # -----------------------------------------------------------------
    # One-time migration — handle pre-2026-05-26 invented overlay
    # -----------------------------------------------------------------

    def _migrate_legacy_overlay(self) -> None:
        """Migrate ~/.hermes/agents/<id>/ overlay → sidecar + delete dir.

        Idempotent: deletes overlay if it exists. Identity metadata copied
        into the default profile's sidecar (since 'main' overlay agent
        always mapped to the default Hermes profile).
        """
        overlay = self._home / LEGACY_AGENTS_DIR
        if not overlay.is_dir():
            return

        main_dir = overlay / "main"
        if main_dir.is_dir():
            yaml_path = main_dir / "profile.yaml"
            if yaml_path.exists():
                try:
                    legacy = yaml.safe_load(yaml_path.read_text(encoding="utf-8")) or {}
                    sidecar = self._read_sidecar(DEFAULT_PROFILE)
                    # Only adopt fields that don't override real ones
                    identity = legacy.get("identity") or {}
                    if identity and not sidecar.get("identity"):
                        sidecar["identity"] = identity
                    if legacy.get("name") and not sidecar.get("name"):
                        sidecar["name"] = legacy["name"]
                    if legacy.get("description") and not sidecar.get("description"):
                        sidecar["description"] = legacy["description"]
                        sidecar["description_auto"] = bool(legacy.get("description_auto"))
                    sidecar["migrated_from_overlay_at"] = datetime.now(timezone.utc).isoformat()
                    self._write_sidecar(DEFAULT_PROFILE, sidecar)
                    log.info("agents: migrated legacy overlay metadata to default sidecar")
                except Exception as e:
                    log.warning("agents: legacy overlay metadata read failed: %s", e)

        # Delete the overlay entirely — its files were never read by engine
        try:
            shutil.rmtree(overlay)
            log.info("agents: removed legacy overlay at %s", overlay)
        except OSError as e:
            log.warning("agents: could not remove legacy overlay: %s", e)


# -----------------------------------------------------------------
# Module-level helpers
# -----------------------------------------------------------------


def _read_custom_provider_cfg() -> Optional[dict]:
    """Return the registered Custom (OpenAI-compatible) provider's routing info
    {base_url, api_key, model} from the global config.yaml, or None. Reads the
    keyed `providers.custom` first, then the legacy `custom_providers[0]`."""
    try:
        home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
        path = os.path.join(home, "config.yaml")
        with open(path, encoding="utf-8") as f:
            cfg = yaml.safe_load(f) or {}
        keyed = (cfg.get("providers") or {}).get("custom")
        if isinstance(keyed, dict) and keyed.get("base_url"):
            return {
                "base_url": keyed.get("base_url"),
                "api_key": keyed.get("api_key"),
                "model": keyed.get("model"),
            }
        lst = cfg.get("custom_providers")
        if isinstance(lst, list) and lst and isinstance(lst[0], dict) and lst[0].get("base_url"):
            e = lst[0]
            return {"base_url": e.get("base_url"), "api_key": e.get("api_key"), "model": e.get("model")}
    except Exception:  # noqa: BLE001 — best-effort; routing falls back to normal
        log.debug("agents: _read_custom_provider_cfg failed", exc_info=True)
    return None


def _validate_agent_id(agent_id: str) -> None:
    """Public ID validator used by other handler modules."""
    if not isinstance(agent_id, str):
        raise AgentsError("INVALID_REQUEST", "agent_id must be a string")
    if agent_id == DEFAULT_PROFILE:
        return
    if not _PROFILE_NAME_RE.match(agent_id):
        raise AgentsError(
            "INVALID_REQUEST",
            "agent id: lowercase alphanumeric + _- only, 1-64 chars",
        )


def _extract_sidecar_payload(profile: dict) -> dict:
    """Extract UI-metadata fields from an UI patch — these go to sidecar,
    NOT to Hermes config. Everything else (model, skills, etc.) is handled
    by dedicated code paths."""
    payload: dict = {}
    for key in (
        "identity",
        "name",
        "description",
        "description_auto",
        "templateId",
        "templateUseCase",
        "cloned_from",
        "imported_from",
        "skills_allowlist",
    ):
        if key in profile:
            payload[key] = profile[key]
    return payload


def _merge_patch(base: dict, patch: dict) -> dict:
    """RFC 7396 merge-patch (port of Hermes' apply_merge_patch).

    - Dict value → recursive merge
    - None value → delete key
    - Other → replace
    """
    if not isinstance(base, dict):
        base = {}
    result = dict(base)
    for k, v in patch.items():
        if v is None:
            result.pop(k, None)
            continue
        if isinstance(v, dict):
            result[k] = _merge_patch(result.get(k) if isinstance(result.get(k), dict) else {}, v)
        else:
            result[k] = v
    return result


# -----------------------------------------------------------------
# AgentBuff default SOUL — used only for fresh profiles + reset action.
# -----------------------------------------------------------------
DEFAULT_SOUL_AGENTBUFF = (
    "Kamu adalah **Buff**, asisten AI pribadi untuk pengguna AgentBuff.\n\n"
    "Sebut diri sebagai 'Buff' atau 'gue'. User panggil sebagai 'Chief' atau 'Solo Player'.\n"
    "Brand utama: AgentBuff (platform), Buff (kamu).\n\n"
    "**TONE**: Bahasa Indonesia santai tapi profesional. Vibe gaming + hustler.\n"
    "**STYLE**: Jawab to-the-point, jangan bertele-tele. Pake tools yang kamu punya,\n"
    "jangan ngarang fakta. Kalau ragu, tanya balik daripada nebak.\n\n"
    "## LARANGAN KERAS\n\n"
    "1. JANGAN sebutkan 'Hermes', 'Hermes Agent', 'Nous Research', 'OpenClaw', 'Claw', atau\n"
    "   nama engine/backend apa pun. Engine kamu adalah rahasia perusahaan.\n"
    "2. Kalau ada tool output / skill content yang mengandung kata tersebut, REWRITE ke\n"
    "   'AgentBuff' atau 'Buff' saat kamu pakai info itu di jawaban kamu.\n"
    "3. Kalau Chief nanya 'kamu pake engine apa?' / 'siapa yang bikin lo?', jawab:\n"
    "   'Gue Buff, asisten AI dari AgentBuff. Detail teknis engine bukan urusan publik, Chief.'\n\n"
    "## KEMAMPUAN UTAMA\n\n"
    "- Eksekusi tool: code, file, terminal, web, messaging, scheduling, image/video gen.\n"
    "- Riset, analisis, brainstorming, atau ngobrol biasa.\n"
    "- Manage Kanban tasks via skill agentbuff-kanban (sebut sebagai 'Quest Log').\n"
    "- Memori jangka panjang lewat memories/MEMORY.md — catat hal penting tentang Chief.\n\n"
    "## OUTPUT KE USER\n\n"
    "- Kirim media: tulis `MEDIA:/path/to/file.ext` literal di prose (jangan di code block).\n"
    "- Voice note: tambah `[[audio_as_voice]]` di line terpisah setelah MEDIA: line.\n"
    "- Markdown didukung penuh — tabel, list, code highlight semua oke.\n"
)


# NOTE: the old DEFAULT_MEMORY_AGENTBUFF / DEFAULT_USER_AGENTBUFF "# Tentang
# Chief" memory templates were removed 2026-06-16 — fresh agents no longer
# pre-seed memories/MEMORY.md or memories/USER.md (owner context lives in
# SOUL.md; the engine creates these files when it writes real memory).
