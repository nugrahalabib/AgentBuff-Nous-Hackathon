import sys, json
sys.path.insert(0, '/app/bridge')
from rpc_router import _transform_cron_job
raw = {
    'id': 'abc',
    'name': 'test',
    'prompt': 'halo',
    'schedule': {'kind': 'cron', 'expr': '0 0 1 1 *'},
    'enabled': True,
    'state': 'scheduled',
    'next_run_at': '2027-01-01T00:00:00+00:00',
    'created_at': '2026-05-23T17:03:04.069744+00:00',
    'deliver': 'local',
}
print(json.dumps(_transform_cron_job(raw), indent=2))
