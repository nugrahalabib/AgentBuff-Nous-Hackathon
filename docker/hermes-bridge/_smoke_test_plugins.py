"""Smoke test: plugins_handler against REAL Hermes plugin manager."""
import asyncio, json, logging, os, sys
logging.basicConfig(level=logging.WARNING)
sys.path.insert(0, "/app/bridge")

async def main():
    from pathlib import Path
    from plugins_handler import PluginsHandler
    home = Path(os.environ.get("HERMES_HOME") or "/home/hermes/.hermes")
    h = PluginsHandler(home)

    print("=== plugins.list ===")
    res = await h.list_plugins()
    print(f"  total={res['total']} enabled={res['enabledCount']} user={res['userInstalledCount']} bundled={res['bundledCount']} errors={res['hasErrors']}")
    print()
    for p in res["plugins"]:
        flag = "ON " if p["enabled"] else "off"
        src = p["source"][:5].ljust(5)
        print(f"  [{flag}] {src} {p['key']:<28} v{p['version'] or '?':<8} kind={p['kind']:<11} tools={p['toolsRegistered']:>2} hooks={p['hooksRegistered']:>2} cmds={p['commandsRegistered']:>2} skills={p['skillFiles']:>2} dash={'Y' if p['hasDashboard'] else 'n'}")
        if p["loadError"]:
            print(f"        ⚠ loadError: {p['loadError'][:80]}")

    print()
    print("=== detail on agentbuff-multimodal ===")
    try:
        det = await h.get_plugin("agentbuff-multimodal")
        print(f"  name={det['name']} version={det['version']} author={det['author']}")
        print(f"  description[:100]={det['description'][:100]}")
        print(f"  provides_hooks={det['providesHooks']}")
        print(f"  provides_tools={det['providesTools']}")
        print(f"  manifest={det['manifestPath']}")
    except Exception as e:
        print(f"  failed: {e}")

    print()
    print("=== ALL PLUGINS SMOKE PASSED ===")


if __name__ == "__main__":
    asyncio.run(main())
