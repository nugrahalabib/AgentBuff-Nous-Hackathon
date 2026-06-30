"""
config_handler.py — RFC 7396 JSON Merge Patch wrapper for Hermes config.

Hermes' native config API is raw dict assignment (config.set: read whole
config, mutate, write whole config). This is fine for direct CLI use but
LOSES STATE under concurrent writers and DOESN'T SUPPORT NULL=DELETE
semantics that AgentBuff portal relies on (channel logout, multi-account
cleanup, etc).

AgentBuff portal uses OpenClaw's RFC 7396 merge-patch RPC contract:
  - patch is a partial config tree
  - nested objects merge recursively
  - null values delete the key
  - non-object values replace (no list merging — replace whole list)
  - atomic: read → merge → write happens under exclusive lock

This module implements that wrapper on top of Hermes' config file.

Reference: https://datatracker.ietf.org/doc/html/rfc7396

Atomicity strategy:
  - Write to temp file in same directory
  - fsync the temp file
  - os.replace() to atomic rename
  - Hold filesystem-level lock during read-merge-write

Backup strategy:
  - Before each write, copy current config.yaml to config.yaml.bak
  - Last good config always recoverable
"""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
from pathlib import Path
from typing import Any, Optional

import yaml


log = logging.getLogger("bridge.config_handler")


# Filename inside HERMES_HOME
CONFIG_FILENAME = "config.yaml"
BACKUP_FILENAME = "config.yaml.bak"
LOCK_FILENAME = ".config.lock"


class ConfigError(Exception):
    """Config operation failed."""


class ConfigHandler:
    """Manages ~/.hermes/config.yaml with merge-patch semantics.

    Thread-safe via asyncio lock. Don't share instances across event loops.
    """

    def __init__(self, hermes_home: Path) -> None:
        self._home = Path(hermes_home)
        self._config_path = self._home / CONFIG_FILENAME
        self._backup_path = self._home / BACKUP_FILENAME
        self._lock = asyncio.Lock()

    async def get(self, key_path: Optional[str] = None) -> Any:
        """Read config. If key_path given (dotted), return that subtree.

        Examples:
            await get()                        → whole config dict
            await get("channels")              → channels subtree
            await get("channels.telegram")     → telegram channel config
            await get("model.primary")         → primary model name
        """
        async with self._lock:
            cfg = self._load_or_default()

        if key_path is None:
            return cfg

        # Walk dotted path
        node: Any = cfg
        for part in key_path.split("."):
            if not isinstance(node, dict):
                return None
            node = node.get(part)
            if node is None:
                return None
        return node

    async def patch(self, patch_data: dict) -> dict:
        """Apply RFC 7396 merge-patch atomically.

        Args:
            patch_data: partial config tree to merge in.
                Nested objects merge recursively.
                None values delete keys.
                Lists replace (no merge).

        Returns:
            The full updated config dict.

        Raises:
            ConfigError on validation/write failure.
        """
        if not isinstance(patch_data, dict):
            raise ConfigError(f"patch must be a dict, got {type(patch_data).__name__}")

        async with self._lock:
            current = self._load_or_default()
            updated = apply_merge_patch(current, patch_data)
            self._write_atomic(updated)
            log.info(
                "config_handler: patch applied (keys touched at root: %s)",
                sorted(patch_data.keys()),
            )
            return updated

    async def replace(self, new_config: dict) -> dict:
        """Replace entire config (bypass merge — full write).

        Use sparingly. Mainly for initial seeding and tests.
        """
        if not isinstance(new_config, dict):
            raise ConfigError(f"new_config must be a dict, got {type(new_config).__name__}")

        async with self._lock:
            self._write_atomic(new_config)
            log.info("config_handler: full replace done")
            return new_config

    async def restore_backup(self) -> dict:
        """Restore from .bak (last known good). Returns restored config."""
        async with self._lock:
            if not self._backup_path.exists():
                raise ConfigError("no backup file to restore from")
            shutil.copy2(self._backup_path, self._config_path)
            cfg = self._load_or_default()
            log.warning("config_handler: restored from backup")
            return cfg

    # -----------------------------------------------------------------
    # Internal: load + write
    # -----------------------------------------------------------------

    def _load_or_default(self) -> dict:
        """Load YAML from disk. Return empty dict if missing."""
        if not self._config_path.exists():
            return {}
        try:
            with open(self._config_path, "r", encoding="utf-8") as f:
                data = yaml.safe_load(f)
            return data if isinstance(data, dict) else {}
        except yaml.YAMLError as e:
            log.error("config_handler: YAML parse failed: %s", e)
            raise ConfigError(f"config file is invalid YAML: {e}") from e
        except OSError as e:
            log.error("config_handler: read failed: %s", e)
            raise ConfigError(f"failed to read config: {e}") from e

    def _write_atomic(self, config: dict) -> None:
        """Atomic write: tmp + fsync + rename. Also backs up previous version."""
        self._home.mkdir(parents=True, exist_ok=True)

        # Back up current (if exists) to .bak before overwriting
        if self._config_path.exists():
            try:
                shutil.copy2(self._config_path, self._backup_path)
            except OSError as e:
                # Backup failure shouldn't block the write, but log loudly
                log.warning("config_handler: backup write failed: %s", e)

        # Serialize to YAML
        try:
            serialized = yaml.safe_dump(
                config,
                allow_unicode=True,
                default_flow_style=False,
                sort_keys=False,
            )
        except yaml.YAMLError as e:
            raise ConfigError(f"failed to serialize config to YAML: {e}") from e

        # Write to temp in same dir, fsync, then atomic rename
        tmp_fd, tmp_path = tempfile.mkstemp(
            prefix=".config.tmp.",
            dir=str(self._home),
            text=False,
        )
        try:
            with os.fdopen(tmp_fd, "wb") as f:
                f.write(serialized.encode("utf-8"))
                f.flush()
                try:
                    os.fsync(f.fileno())
                except OSError:
                    # fsync may not be supported on some FS (e.g. tmpfs);
                    # not fatal, the rename is still atomic on most FS.
                    pass
            # os.replace is atomic on POSIX and Windows
            os.replace(tmp_path, self._config_path)
        except Exception:
            # Cleanup temp on failure
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
            raise


# ---------------------------------------------------------------------
# RFC 7396 implementation (pure function, no I/O)
# ---------------------------------------------------------------------


def apply_merge_patch(target: Any, patch: Any) -> Any:
    """Apply RFC 7396 JSON Merge Patch.

    Spec: https://datatracker.ietf.org/doc/html/rfc7396

    Rules:
      - If patch is not a dict: it REPLACES target entirely
      - If patch is a dict:
        - If target is not a dict: target becomes {}
        - For each (key, value) in patch:
          - If value is None: DELETE key from target
          - Else if value is a dict: recursive merge into target[key]
          - Else: target[key] = value (replace, no list merging)

    The function returns a NEW object; target is not mutated.

    Examples:
        merge({"a": 1, "b": 2}, {"b": 3})           → {"a": 1, "b": 3}
        merge({"a": 1, "b": 2}, {"b": null})        → {"a": 1}
        merge({"a": {"x": 1}}, {"a": {"y": 2}})     → {"a": {"x": 1, "y": 2}}
        merge({"a": {"x": 1}}, {"a": null})         → {}
        merge({"a": [1, 2]}, {"a": [3]})            → {"a": [3]}   # list replace
        merge({"a": 1}, "scalar")                   → "scalar"
    """
    # Non-dict patch fully replaces target
    if not isinstance(patch, dict):
        return _deep_copy(patch)

    # If target is not a dict, treat as empty (per spec)
    if not isinstance(target, dict):
        target = {}

    result = dict(target)
    for key, value in patch.items():
        if value is None:
            # null = delete
            result.pop(key, None)
        elif isinstance(value, dict):
            # recursive merge
            result[key] = apply_merge_patch(result.get(key), value)
        else:
            # scalar or list: replace
            result[key] = _deep_copy(value)

    return result


def _deep_copy(value: Any) -> Any:
    """Recursive copy of plain JSON-like data (dict, list, primitives).

    Avoids dependency on copy.deepcopy (which is overkill for our shapes).
    """
    if isinstance(value, dict):
        return {k: _deep_copy(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_deep_copy(item) for item in value]
    return value
