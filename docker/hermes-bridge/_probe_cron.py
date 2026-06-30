import sys, asyncio, json
sys.path.insert(0, '/app/bridge')
from hermes_client import HermesClient

async def main():
    hc = HermesClient()
    r = await hc.call('cron.manage', {'action': 'list'})
    print(json.dumps(r, indent=2, ensure_ascii=False)[:3000])
    await hc.close()

asyncio.run(main())
