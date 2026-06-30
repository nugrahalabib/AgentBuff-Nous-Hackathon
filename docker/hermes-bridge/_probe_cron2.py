"""Probe transformed cron output via rpc_router directly (mimics RPC dispatch)."""
import asyncio, json, logging, os, sys
logging.basicConfig(level=logging.WARNING)
sys.path.insert(0, "/app/bridge")

async def main():
    import rpc_router
    from agents_handler import AgentsHandler
    from channels_handler import ChannelsHandler
    from config_handler import ConfigHandler
    from hermes_client import HermesClient
    from auth import AuthContext
    from pathlib import Path

    home = Path(os.environ.get("HERMES_HOME") or "/home/hermes/.hermes")
    hc = HermesClient()
    # Note: this bridge-internal HermesClient won't be subprocess-connected;
    # we need to call via the running bridge process's client. Use subprocess
    # to talk via the actual gateway WS — simpler: just direct hermes_client
    # singleton check.
    print("Calling cron.manage directly via fresh hermes client (will fail if subprocess not running)")
    try:
        raw = await hc.call("cron.manage", {"action": "list"})
        print(f"raw count: {len(raw.get('jobs', []))}")
        print(json.dumps(raw, indent=2)[:1500])
    except Exception as e:
        print(f"FAILED: {type(e).__name__}: {e}")
    finally:
        try:
            await hc.close()
        except Exception:
            pass

asyncio.run(main())
