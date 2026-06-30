#!/usr/bin/env python3
"""Seed Hermes bundled + optional skill packs into ~/.hermes/skills/.

WHY THIS EXISTS
---------------
`pip install hermes-agent` does NOT ship the skills/ data tree (the wheel RECORD
has no SKILL.md). Hermes' own design seeds `~/.hermes/skills/` from a bundled
`skills/` dir on install — but that dir is absent from the pip package, so a
fresh container's skills list was permanently EMPTY (the create-agent wizard's
"Skill Khusus" showed nothing). The Dockerfile vendors the bundled (89) +
optional (81) packs out of the version-matched Hermes git checkout into
``/opt/hermes-bundled-skills/{skills,optional-skills}`` at build time; this
script copies them into the user's volume on first boot.

CONTRACT
--------
- Source root: argv[1], else $BUNDLED_SKILLS_DIR, else /opt/hermes-bundled-skills.
  It contains two subtrees: ``skills/<category>/<skill>/SKILL.md`` and
  ``optional-skills/<category>/<skill>/SKILL.md``.
- Dest: ``$HERMES_HOME/skills/<category>/<skill>`` (category structure preserved
  RELATIVE TO EACH subtree, mirroring the engine's own _compute_relative_dest, so
  bundled + optional merge into one flat category tree the engine scans).
- Marker-gated: writes ``.agentbuff_seeded_v1`` after the first successful seed
  and no-ops if it already exists. This respects later user deletions (the engine
  is the source of truth once seeded) and avoids re-copying on every boot.
  Bump the marker suffix (_v2, ...) to force a re-seed after adding new packs.
- skip-if-exists per leaf so a same-name skill in both subtrees keeps the first
  (bundled wins — bundled is iterated first) and a user-customised skill is never
  clobbered.
- Defensive: never raises to the caller in a way that should abort boot. The
  entrypoint calls it with ``|| true``; this script also exits 0 on soft-skip.

Idempotent. Runs as the unprivileged ``hermes`` user (the only user that can
write the 0700 hermes-owned volume — root cannot, the container drops CAP_DAC_OVERRIDE).
"""
import os
import shutil
import sys
from pathlib import Path

SRC_ROOT = Path(
    sys.argv[1]
    if len(sys.argv) > 1
    else os.environ.get("BUNDLED_SKILLS_DIR", "/opt/hermes-bundled-skills")
)
HOME = Path(os.environ.get("HERMES_HOME") or (Path.home() / ".hermes"))
DEST = HOME / "skills"
MARKER = DEST / ".agentbuff_seeded_v1"
_EXCLUDE = ("/.git/", "/.github/", "/.hub/", "/.archive/")


def main() -> int:
    if MARKER.exists():
        print("skill-seed: marker present — already seeded, skipping")
        return 0
    if not SRC_ROOT.is_dir():
        print(f"skill-seed: source {SRC_ROOT} missing — skipping (no bundled skills baked)")
        return 0

    try:
        DEST.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        print(f"skill-seed: cannot create {DEST}: {e} — skipping")
        return 0

    copied = 0
    skipped = 0
    # LEAN_ENGINE: seed only the core bundled packs, skip the optional packs
    # (AI-research / niche skills) so the agent's skill set matches a stock
    # vanilla Hermes install instead of being flooded with rarely-used skills.
    _lean = (os.environ.get("AGENTBUFF_LEAN_ENGINE", "") or "").strip().lower() in {"1", "true", "yes", "on"}
    _subs = ("skills",) if _lean else ("skills", "optional-skills")
    if _lean:
        print("skill-seed: LEAN_ENGINE=on — seeding core bundled packs only (skipping optional-skills)")
    for sub in _subs:
        root = SRC_ROOT / sub
        if not root.is_dir():
            continue
        for skill_md in root.rglob("SKILL.md"):
            if any(x in str(skill_md) for x in _EXCLUDE):
                continue
            src_dir = skill_md.parent
            dest = DEST / src_dir.relative_to(root)
            if dest.exists():
                skipped += 1
                continue
            try:
                dest.parent.mkdir(parents=True, exist_ok=True)
                shutil.copytree(src_dir, dest)
                copied += 1
            except OSError as e:
                print(f"skill-seed: failed {src_dir.name}: {e}")

    if copied:
        try:
            MARKER.write_text("seeded\n", encoding="utf-8")
        except OSError:
            pass

    total = sum(1 for _ in DEST.rglob("SKILL.md"))
    print(f"skill-seed: copied={copied} skipped={skipped} total_on_disk={total}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:  # never abort container boot over skill seeding
        print(f"skill-seed: unexpected error {e!r} — skipping (non-fatal)")
        sys.exit(0)
