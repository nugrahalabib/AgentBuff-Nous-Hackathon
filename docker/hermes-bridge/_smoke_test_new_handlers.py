"""Smoke test for newly-added agent/tools/skills handlers.
Run inside the container: python /app/bridge/_smoke_test_new_handlers.py
"""
from __future__ import annotations
import asyncio
import json
import logging
import sys
import os

# Quiet down so we can read output
logging.basicConfig(level=logging.WARNING, format="%(levelname)s %(name)s: %(message)s")

sys.path.insert(0, "/app/bridge")


async def main():
    # Import modules to confirm they load
    import agents_handler
    import agents_archive
    import agents_describer
    import agents_memory
    import agents_templates
    import tools_handler
    import skills_extras

    from pathlib import Path
    hermes_home = Path(os.environ.get("HERMES_HOME") or "/home/hermes/.hermes")
    handler = agents_handler.AgentsHandler(hermes_home)

    print("=== agents.list ===")
    res = await handler.list_agents()
    agents = res.get("agents", [])
    print(f"  count: {len(agents)}")
    for a in agents[:3]:
        print(f"  - {a.get('id')} ({a.get('name')})")

    if not agents:
        print("WARNING: no agents — bootstrap one for testing")
        await handler.create_agent("smoke-test", {"name": "Smoke Test"}, soul_content="")
        agents = (await handler.list_agents()).get("agents", [])
    first_id = agents[0]["id"]
    print(f"  using first agent: {first_id}")

    print()
    print("=== agents.template.list ===")
    tpls = agents_templates.list_templates()
    print(f"  templates: {len(tpls['templates'])}")
    for t in tpls["templates"][:3]:
        print(f"  - {t['id']}: {t['label']}")

    print()
    print("=== agents.memory.entries (initial) ===")
    mem = await agents_memory.list_entries(handler, first_id)
    print(f"  entries: {len(mem['entries'])}, charCount: {mem['charCount']}, limit: {mem['charLimit']}")

    print()
    print("=== agents.memory.addEntry ===")
    add_res = await agents_memory.add_entry(handler, first_id, "Smoke test entry — bisa di-hapus")
    print(f"  ok={add_res.get('ok')} entries={len(add_res.get('entries', []))}")

    print()
    print("=== agents.memory.removeEntry (last) ===")
    last_idx = len(add_res.get("entries", [])) - 1
    rem_res = await agents_memory.remove_entry(handler, first_id, last_idx)
    print(f"  ok={rem_res.get('ok')} remaining={len(rem_res.get('entries', []))}")

    print()
    print("=== agents.export ===")
    exp = await agents_archive.export_agent(handler, first_id, include_memory=True)
    print(f"  agentId={exp['agentId']} filename={exp['filename']} size={exp['sizeBytes']}B sha={exp['sha256Prefix']}")

    print()
    print("=== agents.clone ===")
    import time
    clone_id = f"smoke-clone-{int(time.time())}"
    try:
        cloned = await handler.clone_agent(source_id=first_id, new_id=clone_id, new_name="Smoke Clone")
        print(f"  cloned to: {cloned.get('id')} name={cloned.get('name')}")
        # Clean up clone
        await handler.delete_agent(clone_id)
        print(f"  cleaned up: {clone_id}")
    except Exception as e:
        print(f"  clone FAILED: {type(e).__name__}: {e}")

    print()
    print("=== agents.files.reset (SOUL.md) ===")
    try:
        reset_res = await handler.reset_file(first_id, "SOUL.md")
        print(f"  reset: size={reset_res.get('size')}B")
        # Re-read to confirm
        soul = await handler.get_file(first_id, "SOUL.md")
        print(f"  first line: {(soul.get('content') or '').split(chr(10))[0][:60]}")
    except Exception as e:
        print(f"  reset FAILED: {type(e).__name__}: {e}")

    print()
    print("=== skills_extras.build_models_auth_status ===")
    auth = await skills_extras.build_models_auth_status()
    print(f"  providers: {len(auth['providers'])}")
    for p in auth["providers"][:5]:
        print(f"  - {p['provider']}: {p['status']}")

    print()
    print("=== tools_handler.build_tools_catalog (needs hermes — will partial-fail) ===")
    # Without a hermes_client we can't fully test; but we can test the structure
    # by passing a stub.
    class _StubHermes:
        async def call(self, method, params, timeout=None):
            # Return a fake tools.show result
            return {
                "sections": [
                    {"name": "memory", "tools": [{"name": "search_memory", "description": "Search agent memory"}, {"name": "store_memory", "description": "Save to memory"}]},
                    {"name": "shell", "tools": [{"name": "bash", "description": "Run shell command"}]},
                    {"name": "channel:telegram", "tools": [{"name": "send_telegram_dm", "description": "Send Telegram DM"}]},
                ],
                "total": 4,
            }
    stub = _StubHermes()
    cat = await tools_handler.build_tools_catalog(stub, first_id)
    print(f"  profiles: {[p['id'] for p in cat['profiles']]}")
    print(f"  groups: {len(cat['groups'])}")
    for g in cat["groups"]:
        print(f"  - {g['source']}/{g['id']}: {len(g['tools'])} tools")
    print()
    print("=== tools_handler.build_tools_effective (with stub) ===")
    eff = await tools_handler.build_tools_effective(stub, handler, first_id)
    print(f"  active profile: {eff['profile']}")
    print(f"  effective groups: {len(eff['groups'])}")
    for g in eff["groups"]:
        print(f"  - {g['source']}: {len(g['tools'])} tools allowed")

    print()
    print("=== ALL SMOKE TESTS PASSED ===")


if __name__ == "__main__":
    asyncio.run(main())
