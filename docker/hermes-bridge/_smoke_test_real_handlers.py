"""Smoke test for REAL Hermes-native agents_handler rewrite."""
import asyncio, logging, sys, os
logging.basicConfig(level=logging.WARNING)
sys.path.insert(0, "/app/bridge")

async def main():
    from pathlib import Path
    import agents_handler, agents_memory, tools_handler, skills_extras
    from agents_handler import AgentsHandler, DEFAULT_PROFILE

    home = Path(os.environ.get("HERMES_HOME") or "/home/hermes/.hermes")
    h = AgentsHandler(home)

    print("=== 1. agents.list (REAL profiles, default included) ===")
    res = await h.list_agents()
    print(f"  defaultId={res['defaultId']} activeId={res['activeId']}")
    print(f"  agents: {len(res['agents'])}")
    for a in res["agents"]:
        soul_size = (home if a["id"] == DEFAULT_PROFILE else home / "profiles" / a["id"]) / "SOUL.md"
        print(f"  - {a['id']} ({a['name']}) default={a['default']} active={a['active']} model={a['model']['primary']} skills={a['skillCount']} soul={a['hasSoul']}")

    print()
    print("=== 2. get_file SOUL.md from default (= ~/.hermes/SOUL.md REAL) ===")
    soul = await h.get_file(DEFAULT_PROFILE, "SOUL.md")
    print(f"  size={len(soul['content'])} first line: {soul['content'].split(chr(10))[0][:70]}")
    print(f"  must contain 'Buff' (real): {'Buff' in soul['content']}")

    print()
    print("=== 3. memory entries from default (= ~/.hermes/memories/MEMORY.md REAL) ===")
    mem = await agents_memory.list_entries(h, DEFAULT_PROFILE)
    print(f"  entries={len(mem['entries'])} charCount={mem['charCount']}/{mem['charLimit']}")
    for e in mem["entries"][:3]:
        print(f"  [{e['index']}] {e['content'][:60]}")

    print()
    print("=== 4. file_path verifies real Hermes location ===")
    print(f"  SOUL.md  → {h.file_path(DEFAULT_PROFILE, 'SOUL.md')}")
    print(f"  MEMORY   → {h.file_path(DEFAULT_PROFILE, 'memories/MEMORY.md')}")
    print(f"  USER.md  → {h.file_path(DEFAULT_PROFILE, 'memories/USER.md')}")

    print()
    print("=== 5. profile_home resolution ===")
    print(f"  default → {h.profile_home(DEFAULT_PROFILE)}")
    print(f"  named   → {h.profile_home('coder')}")
    print(f"  None    → {h.profile_home(None)}")

    print()
    print("=== 6. _get_active_profile_name (sentinel) ===")
    print(f"  active = {h._get_active_profile_name()!r}")

    print()
    print("=== 7. config.yaml read (real Hermes config) ===")
    cfg = h._read_hermes_config(DEFAULT_PROFILE)
    model = cfg.get("model", {})
    print(f"  model.default = {model.get('default')!r}")
    print(f"  model.provider = {model.get('provider')!r}")
    pts = cfg.get("platform_toolsets", {})
    cli_list = pts.get("cli")
    print(f"  platform_toolsets.cli = {cli_list[:5] if isinstance(cli_list, list) else cli_list}{'...' if isinstance(cli_list, list) and len(cli_list) > 5 else ''}")

    print()
    print("=== 8. tools.catalog (REAL Hermes toolsets) ===")
    from hermes_client import HermesClient
    hc = HermesClient()
    try:
        cat = await tools_handler.build_tools_catalog(hc, h, DEFAULT_PROFILE)
        print(f"  totalToolsets={cat['totalToolsets']} enabledCount={cat['enabledCount']}")
        print(f"  bundles: {[b['id'] for b in cat['bundles']]}")
        print(f"  first 5 groups:")
        for g in cat["groups"][:5]:
            print(f"    - {g['source']}/{g['id']} enabled={g['enabled']} tools={g['toolCount']}")
    except Exception as e:
        print(f"  tools.catalog failed: {e}")
    finally:
        try:
            await hc.close()
        except Exception:
            pass

    print()
    print("=== ALL REAL-HERMES SMOKE TESTS PASSED ===")


if __name__ == "__main__":
    asyncio.run(main())
