"""
agents_archive.py — Export/import AgentBuff agent profiles as .agentbuff.tar.gz.

PORTED from Hermes engine `hermes_cli/profiles.py::export_profile/import_profile`
with bridge-side scope (we only archive agent dir contents, not Hermes profile
dirs). Includes:
  - Safe extraction (zip-slip + path traversal prevention)
  - Credential stripping (always)
  - Optional memory stripping ("share without personal data")

RPC surface:
    agents.export(agentId, includeMemory?)
        → { agentId, filename, base64, sizeBytes }
    agents.import(base64, newAgentId?, overwrite?)
        → { agentId, profile, importedFiles[] }
"""

from __future__ import annotations

import base64 as _b64
import hashlib
import io
import json
import logging
import os
import re
import shutil
import tarfile
import tempfile
import time
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Optional

log = logging.getLogger("bridge.agents_archive")


# Files NEVER included in export (mirror engine _CREDENTIAL_FILES)
_CREDENTIAL_FILES = frozenset({".env", "auth.json", "auth.lock", ".update_check"})

# Files conditionally excluded when "share without personal data" flag set.
# Personal files live in memories/ subdir but we filter by basename across
# all levels via the copytree ignore callback.
_PERSONAL_FILES = frozenset({"MEMORY.md", "USER.md"})

# Extra exclusions when exporting the DEFAULT profile (HERMES_HOME).
# Mirrors hermes_cli/profiles.py::_DEFAULT_EXPORT_EXCLUDE_ROOT but trimmed
# to the items most relevant to AgentBuff containers. We exclude:
#   - infra: hermes-agent (repo), bin, node_modules, profiles (sibling),
#            .worktrees
#   - runtime state DBs: state.db / state.db-* / response_store.db
#   - per-run dirs: gateway.pid, gateway_state.json, processes.json
#   - caches that bloat archives + don't aid restore:
#            audio_cache, image_cache, document_cache, browser_screenshots,
#            checkpoints, sandboxes, logs, cache
#   - bridge invented overlay: agents (we deleted it but defensive)
#   - other AgentBuff state files at HERMES_HOME root that are
#     container-local: agentbuff_folders.json, channel_directory.json,
#     models_dev_cache.json, kanban.db (per-container state)
_DEFAULT_EXTRA_EXCLUDES = frozenset({
    "hermes-agent", ".worktrees", "profiles", "bin", "node_modules",
    "state.db", "state.db-shm", "state.db-wal",
    "hermes_state.db",
    "response_store.db", "response_store.db-shm", "response_store.db-wal",
    "gateway.pid", "gateway_state.json", "processes.json",
    "auth.lock", "active_profile", ".update_check",
    "errors.log", ".hermes_history",
    "image_cache", "audio_cache", "document_cache",
    "browser_screenshots", "checkpoints", "sandboxes",
    "logs", "cache",
    "agents",  # legacy invented overlay
    "agentbuff_folders.json", "channel_directory.json",
    "models_dev_cache.json", "kanban.db",
    "memory",  # legacy alt-name dir
})

# Max import size (10 MB — agents shouldn't exceed this; abuse protection)
MAX_IMPORT_BYTES = 10 * 1024 * 1024


# -----------------------------------------------------------------
# Safe extraction (port of engine _normalize_profile_archive_parts +
# _safe_extract_profile_archive)
# -----------------------------------------------------------------


def _normalize_archive_parts(member_name: str) -> list[str]:
    normalized = member_name.replace("\\", "/")
    posix = PurePosixPath(normalized)
    windows = PureWindowsPath(member_name)
    if (
        not normalized
        or posix.is_absolute()
        or windows.is_absolute()
        or windows.drive
    ):
        raise ValueError(f"unsafe archive member path: {member_name!r}")
    parts = [p for p in posix.parts if p not in {"", "."}]
    if not parts or any(p == ".." for p in parts):
        raise ValueError(f"unsafe archive member path: {member_name!r}")
    return parts


def _safe_extract(archive: Path, destination: Path) -> list[str]:
    extracted: list[str] = []
    with tarfile.open(archive, "r:gz") as tf:
        for member in tf.getmembers():
            parts = _normalize_archive_parts(member.name)
            target = destination.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            if not member.isfile():
                raise ValueError(f"unsupported archive member type: {member.name}")
            target.parent.mkdir(parents=True, exist_ok=True)
            extracted_member = tf.extractfile(member)
            if extracted_member is None:
                raise ValueError(f"cannot read archive member: {member.name}")
            with extracted_member, open(target, "wb") as dst:
                shutil.copyfileobj(extracted_member, dst)
            try:
                os.chmod(target, member.mode & 0o777)
            except OSError:
                pass
            extracted.append(str(target.relative_to(destination)))
    return extracted


def _inspect_archive_root(archive: Path) -> Optional[str]:
    """Validate archive has a single top-level dir + return its name."""
    roots: set[str] = set()
    with tarfile.open(archive, "r:gz") as tf:
        for member in tf.getmembers():
            parts = _normalize_archive_parts(member.name)
            if parts:
                roots.add(parts[0])
    if len(roots) != 1:
        return None
    return roots.pop()


# -----------------------------------------------------------------
# Export
# -----------------------------------------------------------------


async def export_agent(
    agents_handler: Any,
    agent_id: str,
    include_memory: bool = True,
) -> dict:
    """Build a tar.gz of the profile's REAL Hermes directory + return base64.

    Source path = agents_handler.profile_home(agent_id) — i.e.
    ~/.hermes for default, ~/.hermes/profiles/<name>/ for named.

    For the DEFAULT profile we use Hermes' broader exclusion list because
    HERMES_HOME contains lots of infra (state.db, sessions, cache dirs,
    sibling profiles, repo checkout, etc.) that shouldn't be in a share
    archive. Mirrors hermes_cli/profiles.py::_DEFAULT_EXPORT_EXCLUDE_ROOT.

    For NAMED profiles we just strip credentials.
    """
    from agents_handler import AgentsError, DEFAULT_PROFILE, _validate_agent_id  # type: ignore
    _validate_agent_id(agent_id)

    profile_dir = agents_handler.profile_home(agent_id)
    if not profile_dir.is_dir():
        raise AgentsError("NOT_FOUND", f"profile {agent_id!r} does not exist")

    excluded = set(_CREDENTIAL_FILES)
    if not include_memory:
        excluded |= set(_PERSONAL_FILES)

    # Default profile = HERMES_HOME — needs broader infra exclusion
    if agent_id == DEFAULT_PROFILE:
        excluded |= _DEFAULT_EXTRA_EXCLUDES

    # Stage to a temp dir then archive
    with tempfile.TemporaryDirectory(prefix=f"agentbuff_export_{agent_id}_") as tmp:
        tmp_path = Path(tmp)
        staged = tmp_path / agent_id
        shutil.copytree(
            profile_dir,
            staged,
            ignore=lambda d, contents: excluded & set(contents),
        )
        # Redact any literal API key from the exported config.yaml so a shared
        # archive never carries the user's BYOK secret out of the container.
        # Operates on the temp STAGING copy only — the live profile config the
        # engine reads at runtime is never touched. (Audit 2026-06-10 — C1.)
        _scrub_config_secrets(staged / "config.yaml")
        # Write manifest
        manifest = {
            "format": "agentbuff-profile",
            "version": "2.0",
            "agentId": agent_id,
            "sourceWasDefault": agent_id == DEFAULT_PROFILE,
            "exportedAt": int(time.time()),
            "includeMemory": include_memory,
            "files": _list_relative(staged),
        }
        (staged / ".agentbuff-manifest.json").write_text(
            json.dumps(manifest, indent=2, ensure_ascii=False),
            encoding="utf-8",
        )

        archive_path = tmp_path / f"{agent_id}.agentbuff.tar.gz"
        with tarfile.open(archive_path, "w:gz") as tf:
            tf.add(staged, arcname=agent_id)

        raw = archive_path.read_bytes()

    encoded = _b64.b64encode(raw).decode("ascii")
    sha = hashlib.sha256(raw).hexdigest()[:16]
    filename = f"{agent_id}.agentbuff.tar.gz"
    return {
        "agentId": agent_id,
        "filename": filename,
        "base64": encoded,
        "sizeBytes": len(raw),
        "sha256Prefix": sha,
        "includeMemory": include_memory,
    }


def _list_relative(root: Path) -> list[str]:
    out: list[str] = []
    for p in sorted(root.rglob("*")):
        if p.is_file():
            out.append(str(p.relative_to(root)))
    return out


def _scrub_config_secrets(config_path: Path) -> None:
    """Null any literal API key inside a STAGED config.yaml before it is
    archived for export. The live profile config (read by the engine at
    runtime) is never touched — only the artifact that leaves the container.
    'local' / empty sentinels are left as-is (they are not secrets)."""
    if not config_path.is_file():
        return
    try:
        import yaml  # PyYAML — already a bridge dependency
        data = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    except Exception:
        return
    if not isinstance(data, dict):
        return
    changed = False
    model = data.get("model")
    if isinstance(model, dict):
        if model.get("api_key") not in (None, "", "local"):
            model["api_key"] = None
            changed = True
        providers = model.get("providers")
        if isinstance(providers, dict):
            for pv in providers.values():
                if isinstance(pv, dict) and pv.get("api_key") not in (None, "", "local"):
                    pv["api_key"] = None
                    changed = True
    if changed:
        try:
            config_path.write_text(
                yaml.safe_dump(data, allow_unicode=True, sort_keys=False),
                encoding="utf-8",
            )
        except Exception as e:
            log.warning("export: config secret scrub failed: %s", e)


# -----------------------------------------------------------------
# Import
# -----------------------------------------------------------------


async def import_agent(
    agents_handler: Any,
    archive_base64: str,
    new_agent_id: Optional[str] = None,
    overwrite: bool = False,
) -> dict:
    """Restore an agent from a base64 tar.gz produced by export_agent.

    Validates: manifest, safe-extract, size cap, agent_id collision.
    """
    from agents_handler import AgentsError, _validate_agent_id  # type: ignore

    if not isinstance(archive_base64, str) or not archive_base64.strip():
        raise AgentsError("INVALID_REQUEST", "archive base64 required")

    try:
        raw = _b64.b64decode(archive_base64, validate=True)
    except Exception as e:
        raise AgentsError("INVALID_REQUEST", f"base64 decode failed: {e}")

    if len(raw) > MAX_IMPORT_BYTES:
        raise AgentsError(
            "TOO_LARGE",
            f"archive exceeds {MAX_IMPORT_BYTES} bytes (got {len(raw)})",
        )

    # All imports become NAMED profiles under ~/.hermes/profiles/.
    # Never overwrite the default (HERMES_HOME) — that's the chief's REAL
    # main agent and corrupting it would brick the whole container.
    home = agents_handler._home
    profiles_dir = home / "profiles"
    profiles_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="agentbuff_import_") as tmp:
        tmp_path = Path(tmp)
        archive_path = tmp_path / "in.tar.gz"
        archive_path.write_bytes(raw)

        # Validate single root + read manifest
        root_name = _inspect_archive_root(archive_path)
        if not root_name:
            raise AgentsError(
                "INVALID_REQUEST",
                "archive must contain exactly one top-level directory",
            )

        stage_dir = tmp_path / "extract"
        stage_dir.mkdir()
        try:
            extracted = _safe_extract(archive_path, stage_dir)
        except ValueError as e:
            raise AgentsError("INVALID_REQUEST", f"unsafe archive: {e}")

        source = stage_dir / root_name
        if not source.is_dir():
            raise AgentsError("INVALID_REQUEST", "archive root is not a directory")

        manifest_path = source / ".agentbuff-manifest.json"
        manifest: dict = {}
        if manifest_path.exists():
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            except Exception:
                manifest = {}
        # Strip manifest file itself before copy
        if manifest_path.exists():
            manifest_path.unlink()

        # Resolve target id — imports always go to NAMED profile.
        # Reject "default" — that's the chief's REAL container HERMES_HOME.
        target_id = (new_agent_id or root_name).strip().lower()
        from agents_handler import DEFAULT_PROFILE  # type: ignore
        if target_id == DEFAULT_PROFILE:
            raise AgentsError(
                "INVALID_REQUEST",
                "cannot import as 'default' — pick a different name",
            )
        _validate_agent_id(target_id)

        target_dir = profiles_dir / target_id
        if target_dir.exists():
            if not overwrite:
                raise AgentsError(
                    "ALREADY_EXISTS",
                    f"profile {target_id!r} already exists (pass overwrite=true to replace)",
                )
            shutil.rmtree(target_dir)

        # Strip credentials defensively (in case exporter forgot)
        for cred in _CREDENTIAL_FILES:
            p = source / cred
            if p.exists():
                p.unlink()

        # Copy staged source → final destination
        shutil.copytree(source, target_dir)

        # Write agentbuff sidecar with import metadata
        try:
            sidecar = agents_handler._read_sidecar(target_id)
            sidecar["imported_from"] = manifest.get("agentId") or root_name
            sidecar["imported_at"] = int(time.time())
            sidecar["default"] = False
            agents_handler._write_sidecar(target_id, sidecar)
        except Exception as e:
            log.warning("import: sidecar write for %s failed: %s", target_id, e)

        return {
            "agentId": target_id,
            "profile": await agents_handler.get_agent(target_id),
            "importedFiles": [
                p for p in extracted if not p.endswith(".agentbuff-manifest.json")
            ],
            "fromManifest": manifest,
        }


def _now() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()
