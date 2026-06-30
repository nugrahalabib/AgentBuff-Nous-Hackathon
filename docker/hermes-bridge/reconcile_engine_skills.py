"""reconcile_engine_skills.py — align ENGINE-origin skills to the current engine
version on an EXISTING volume, WITHOUT touching user-authored / marketplace skills.

Why this exists
---------------
When the Hermes engine is bumped (e.g. 0.15.2 -> 0.16.0) the bundled skill set
changes: some skills are dropped or demoted from the lean baseline, others are
added. New containers pick this up automatically (the lean seed copies the new
bundled pack). But EXISTING containers keep their volume, so their skill set
stays frozen at the version they were provisioned on.

Chief's mandate (2026-06-07): on every engine update, existing users must also
follow the new engine baseline — "yang terhapus ikut terhapus, yang nambah ikut
nambah" — BUT anything that is NOT from the engine must stay exactly as the user
left it: agent-authored skills (the agent created its own skill), marketplace /
BuffHub purchases, and any user config. Those are never touched.

How engine-origin is identified
-------------------------------
`~/.hermes/skills/.agentbuff_builtin_baseline.json` is a snapshot, captured at
provision time, of every skill name that shipped with the engine then. By
construction (see skills_extras._builtin_baseline_names) ANY skill NOT in that
snapshot is user-authored / marketplace. So:

    remove  <=>  skill is in the OLD baseline (engine-origin)
                 AND its name is NOT in the NEW engine bundled pack (dropped/demoted)

Everything else is kept. After reconciling we re-capture the baseline from the
NEW engine pack so the RESET feature also follows the new version.

Conservative by design: if a skill's provenance is uncertain it is KEPT. We only
ever delete a skill we can positively prove was engine-origin AND is gone from
the new engine.
"""
from __future__ import annotations

import json
import logging
import os
import re
import shutil
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

log = logging.getLogger("bridge.reconcile_engine_skills")

_BASELINE_FILE = ".agentbuff_builtin_baseline.json"
_NAME_RE = re.compile(r"^name:\s*(.+?)\s*$", re.MULTILINE)


def _skill_name(skill_md: Path) -> Optional[str]:
    """Read a skill's canonical `name:` from its SKILL.md frontmatter.

    Falls back to the containing directory name when no `name:` is present.
    """
    try:
        head = skill_md.read_text(encoding="utf-8", errors="replace")[:1200]
    except Exception:
        return skill_md.parent.name
    m = _NAME_RE.search(head)
    if m:
        return m.group(1).strip().strip("\"'")
    return skill_md.parent.name


def _scan_skill_md(root: Path) -> List[Tuple[Path, str]]:
    """Return [(skill_dir, canonical_name)] for every SKILL.md under root."""
    out: List[Tuple[Path, str]] = []
    if not root.is_dir():
        return out
    for skill_md in root.rglob("SKILL.md"):
        out.append((skill_md.parent, _skill_name(skill_md) or skill_md.parent.name))
    return out


def _read_baseline(home: Path) -> Optional[Set[str]]:
    path = home / "skills" / _BASELINE_FILE
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, list):
            return {str(x) for x in data}
    except Exception as exc:
        log.warning("reconcile: read baseline failed: %s", exc)
    return None


def _new_engine_names(bundled_dir: Path, *, lean: bool) -> Set[str]:
    """Names the NEW engine ships. lean=True -> core `skills/` only (matches the
    lean seed); otherwise core + optional."""
    names: Set[str] = set()
    subs = ("skills",) if lean else ("skills", "optional-skills")
    for sub in subs:
        for _dir, name in _scan_skill_md(bundled_dir / sub):
            names.add(name)
    return names


def reconcile(
    home: str,
    bundled_dir: str,
    *,
    lean: bool = True,
    dry_run: bool = False,
) -> Dict[str, object]:
    """Align engine-origin skills in `home`/skills to the engine pack in
    `bundled_dir`. Returns a report dict. User/marketplace skills are preserved.
    """
    home_p = Path(home)
    bundled_p = Path(bundled_dir)
    skills_root = home_p / "skills"

    report: Dict[str, object] = {
        "ran": False,
        "removed": [],
        "kept_user": [],
        "kept_engine": 0,
        "new_baseline": 0,
        "reason": "",
    }

    old_baseline = _read_baseline(home_p)
    if old_baseline is None:
        # No baseline snapshot -> we cannot tell engine-origin from user skills.
        # Do NOT delete anything; just capture a fresh baseline so future bumps
        # have a reference. (First-ever provision path also lands here.)
        report["reason"] = "no-baseline-snapshot — capture only, no removal"
        new_names = _new_engine_names(bundled_p, lean=lean)
        if new_names and not dry_run:
            _write_baseline(home_p, new_names)
        report["new_baseline"] = len(new_names)
        return report

    new_names = _new_engine_names(bundled_p, lean=lean)
    if not new_names:
        report["reason"] = "new engine pack empty/unreadable — aborting (no-op)"
        log.warning("reconcile: %s (%s)", report["reason"], bundled_p)
        return report

    removed: List[str] = []
    kept_user: List[str] = []
    kept_engine = 0

    for skill_dir, name in _scan_skill_md(skills_root):
        is_engine_origin = name in old_baseline or skill_dir.name in old_baseline
        in_new_engine = name in new_names
        if is_engine_origin and not in_new_engine:
            # Engine shipped this before; the new engine dropped/demoted it.
            removed.append(name)
            if not dry_run:
                try:
                    shutil.rmtree(skill_dir)
                except Exception as exc:
                    log.warning("reconcile: rmtree %s failed: %s", skill_dir, exc)
        elif is_engine_origin:
            kept_engine += 1
        else:
            # NOT in the old baseline => user-authored / marketplace. Never touch.
            kept_user.append(name)

    # Re-capture the baseline as the NEW engine-origin set so RESET follows the
    # new version. (User/marketplace skills are still excluded by construction —
    # they were never in new_names.)
    if not dry_run:
        _write_baseline(home_p, new_names)

    report.update(
        ran=True,
        removed=sorted(removed),
        kept_user=sorted(kept_user),
        kept_engine=kept_engine,
        new_baseline=len(new_names),
        reason="reconciled" if not dry_run else "dry-run",
    )
    return report


def _write_baseline(home: Path, names: Set[str]) -> None:
    path = home / "skills" / _BASELINE_FILE
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(sorted(names), ensure_ascii=False), encoding="utf-8")
        log.info("reconcile: re-captured builtin baseline (%d engine skills)", len(names))
    except Exception as exc:
        log.warning("reconcile: write baseline failed: %s", exc)


if __name__ == "__main__":
    import argparse

    logging.basicConfig(level=os.environ.get("LOG_LEVEL", "INFO"),
                        format="%(levelname)s %(name)s %(message)s")
    ap = argparse.ArgumentParser()
    ap.add_argument("--home", default=os.environ.get("HERMES_HOME", "/home/hermes/.hermes"))
    ap.add_argument("--bundled", default=os.environ.get("BUNDLED_SKILLS_DIR", "/opt/hermes-bundled-skills"))
    ap.add_argument("--lean", default=(os.environ.get("AGENTBUFF_LEAN_ENGINE", "true").lower() in {"1", "true", "yes", "on"}), action="store_true")
    ap.add_argument("--no-lean", dest="lean", action="store_false")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    rep = reconcile(args.home, args.bundled, lean=args.lean, dry_run=args.dry_run)
    print(json.dumps(rep, ensure_ascii=False, indent=2))
