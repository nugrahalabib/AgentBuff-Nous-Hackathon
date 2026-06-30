"""Direct end-to-end test of handle_cron_list via dispatch() in the running bridge."""
import asyncio, json, sys, os
sys.path.insert(0, '/app/bridge')

async def main():
    # Mirror what rpc_router does — connect to the live bridge via WS.
    import websockets, json as _j
    port = int(os.environ.get("BRIDGE_PORT", "18789"))
    token = os.environ.get("BRIDGE_TOKEN", "")
    uri = f"ws://127.0.0.1:{port}/ws"
    async with websockets.connect(uri, origin=f"http://127.0.0.1:{port}") as ws:
        await ws.send(_j.dumps({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "connect",
            "params": {
                "auth": {"token": token},
                "clientInfo": {"name": "probe-cronlist", "version": "0.0.1"},
            },
        }))
        first = await asyncio.wait_for(ws.recv(), timeout=5)
        print("connect resp:", first[:200])
        await ws.send(_j.dumps({
            "jsonrpc": "2.0",
            "id": 2,
            "method": "cron.list",
            "params": {"enabled": "all", "sortBy": "nextRunAtMs", "sortDir": "asc", "limit": 100},
        }))
        for _ in range(5):
            raw = await asyncio.wait_for(ws.recv(), timeout=5)
            msg = _j.loads(raw)
            if msg.get("id") == 2:
                print("=== cron.list response ===")
                print(_j.dumps(msg, indent=2, ensure_ascii=False)[:3000])
                break

asyncio.run(main())
