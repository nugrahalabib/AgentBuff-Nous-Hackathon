# AgentBuff Hermes Bridge

**Purpose:** Python service that runs inside each user's Hermes container and translates between AgentBuff portal's wire protocol (OpenClaw-style frame format) and Hermes Agent's native JSON-RPC 2.0 protocol.

**Why this exists:** AgentBuff portal was built against OpenClaw's wire contract. Hermes Agent uses a different RPC method naming + event format. Rather than rewrite the entire portal `/app` UI to speak Hermes natively, this bridge translates so:

- Portal stays unchanged (almost — minor adapter layer in `src/lib/hermes/`)
- Hermes stays unchanged (no source modification — hard constraint)
- Bridge handles all the translation, custom logic, and GAPs

## Architecture

```
Browser (AgentBuff /app)
    │
    │ WebSocket {type: "req"/"res"/"event"} frames (OpenClaw style)
    ▼
Portal ws-proxy.ts  →  port 18789 of container
                              │
                              ▼
                    ┌─────────────────────┐
                    │  agentbuff_bridge   │  ← THIS PACKAGE
                    │  (Python asyncio)    │
                    │                     │
                    │  - Auth gate         │
                    │  - RPC dispatch       │
                    │  - Event translation  │
                    │  - Custom handlers    │
                    │    (channels, agents, │
                    │     config, energy)   │
                    └─────────────────────┘
                              │
                              │ JSON-RPC 2.0 over stdio (NDJSON)
                              ▼
                    ┌─────────────────────┐
                    │  Hermes TUI Gateway │  (subprocess)
                    │  python -m tui_gate...│
                    │                     │
                    │  - AIAgent runtime  │
                    │  - SessionDB        │
                    │  - Tool execution   │
                    └─────────────────────┘
                              │
                              ▼
                    ┌─────────────────────┐
                    │  Hermes Gateway     │  (separate subprocess)
                    │  hermes gateway start │
                    │                     │
                    │  - Telegram adapter  │
                    │  - WhatsApp adapter  │
                    │  - Discord, Slack ... │
                    └─────────────────────┘
```

## File Layout

```
docker/hermes-bridge/
├── README.md                    # This file
├── requirements.txt              # Pinned dependencies
├── agentbuff_bridge.py           # Main entry point (orchestrator)
├── auth.py                       # bridgeToken validation
├── hermes_client.py              # JSON-RPC client to Hermes (subprocess pipe)
├── event_translator.py           # Hermes event → portal event format
├── rpc_router.py                 # Method dispatch + translation map
├── config_handler.py             # RFC 7396 merge-patch wrapper
├── agents_handler.py             # Multi-agent profile layer
├── channels_handler.py           # Custom channels.status/pair/logout RPC
├── energy_gate.py                # Pre-flight energy balance check
└── tests/                        # Unit tests (added per Step 1.11)
    ├── test_auth.py
    ├── test_event_translator.py
    ├── test_rpc_router.py
    ├── test_config_handler.py
    └── test_agents_handler.py
```

## Wire Protocol — Browser Side (OpenClaw-style)

The browser/portal speaks OpenClaw-style frames:

```json
// Request
{"type": "req", "id": "req-001", "method": "chat.send", "params": {"sessionKey": "...", "message": "halo"}}

// Response
{"type": "res", "id": "req-001", "ok": true, "payload": {...}}

// Error response
{"type": "res", "id": "req-001", "ok": false, "error": {"code": "ENERGY_EXHAUSTED", "message": "..."}}

// Unsolicited event (chat streaming, tool calls, etc.)
{"type": "event", "event": "chat", "payload": {"state": "delta", "sessionKey": "...", "message": {...}}}
```

## Wire Protocol — Hermes Side (JSON-RPC 2.0)

Bridge talks to Hermes TUI Gateway via stdin/stdout NDJSON in JSON-RPC 2.0:

```json
// Request
{"jsonrpc": "2.0", "id": 1, "method": "prompt.submit", "params": {...}}

// Response
{"jsonrpc": "2.0", "id": 1, "result": {...}}

// Error response
{"jsonrpc": "2.0", "id": 1, "error": {"code": -32600, "message": "..."}}

// Notification (unsolicited)
{"jsonrpc": "2.0", "method": "prompt.streamed", "params": {...}}
```

## Auth Model

1. Browser/portal connects to `ws://<container-host>:18789/`
2. First frame MUST be:
   ```json
   {
     "type": "req",
     "id": "connect-1",
     "method": "connect",
     "params": {
       "auth": {"token": "<bridgeToken>"},
       "client": {"id": "agentbuff-portal", "version": "1", "platform": "node"},
       "role": "operator"
     }
   }
   ```
3. Bridge validates token against env-injected `BRIDGE_TOKEN`. Rejects on mismatch (close code 4001).
4. On success, bridge replies with `proxy.ready` synthetic event containing engine snapshot.
5. All subsequent frames are RPC requests/responses/events.

## Energy Gating

Bridge intercepts `chat.send`, `sessions.send`, `chat.inject` methods. Pre-flight check:
- Query portal API `/api/users/me/energy` (HTTP, with bearer = `BRIDGE_TOKEN`)
- If `balance < MIN_ENERGY_TO_PROMPT` (default 1): return error `ENERGY_EXHAUSTED` without forwarding
- Else: forward to Hermes

## Event Translation Highlights

Critical gotchas preserved from OpenClaw contract:

- **G3 sessionKey canonicalization:** Bridge maintains `agent:<id>:<key>` namespace prefix
- **G4 single `event: "chat"`:** Bridge merges Hermes' `prompt.streamed`/`prompt.final`/`prompt.error`/`session.interrupted` into ONE event with `state` discriminator
- **G5 full merged text:** Bridge accumulates deltas per session, sends full text (not incremental chunk)
- **G6 error in `payload.errorMessage`:** Bridge translates Hermes error payload format
- **G7 WS close reason ≤123 bytes:** Bridge truncates reason strings

## Local Development

```bash
# From repo root
cd LandingPage/docker/hermes-bridge

# Create venv (Windows + Linux + macOS)
python -m venv .venv

# Activate
source .venv/bin/activate         # Linux/macOS/WSL
.venv\Scripts\activate.bat        # Windows native

# Install pinned deps
pip install -r requirements.txt

# Set env (Linux/macOS/WSL)
export BRIDGE_TOKEN="dev-token-only-for-local-test"
export HERMES_HOME="$HOME/.hermes-dev"

# Set env (Windows PowerShell)
$env:BRIDGE_TOKEN = "dev-token-only-for-local-test"
$env:HERMES_HOME = "$env:USERPROFILE\.hermes-dev"

# Run bridge
python agentbuff_bridge.py
```

In another terminal, test with `wscat` (install via `npm i -g wscat`):

```bash
wscat -c ws://localhost:18789/

# Then paste connect frame:
{"type":"req","id":"1","method":"connect","params":{"auth":{"token":"dev-token-only-for-local-test"},"client":{"id":"agentbuff-portal","version":"1","platform":"node"},"role":"operator"}}

# Should receive:
# {"type":"res","id":"1","ok":true,"payload":{...}}
# {"type":"event","event":"proxy.ready","payload":{...}}
```

## Production Deployment

This bridge is intended to run INSIDE the per-user Docker container (`hermes-agent:local`). The container's `entrypoint.sh` starts the bridge, which in turn spawns Hermes subprocesses.

See `LandingPage/docker/Dockerfile.hermes` for container image definition (Step 2 of migration plan).

## Testing

Unit tests in `tests/`. Run with:

```bash
pytest tests/ -v
```

Integration tests (require Hermes installed) in repo's `scripts/test-hermes-bridge.ts`.

## Environment Variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `BRIDGE_TOKEN` | YES | (none) | Auth token for portal connections |
| `BRIDGE_PORT` | NO | 18789 | WebSocket server port |
| `BRIDGE_HOST` | NO | 0.0.0.0 | Bind host (loopback published via Docker) |
| `BRIDGE_HEALTH_PORT` | NO | 18790 | HTTP health endpoint port |
| `HERMES_HOME` | NO | `~/.hermes` | Hermes config + state directory |
| `HERMES_DEFAULT_MODEL` | NO | google/gemini-2.5-flash | Default LLM |
| `HERMES_DEFAULT_API_KEY` | NO | (none) | Default provider API key |
| `PORTAL_BASE_URL` | NO | http://host.docker.internal:617 | Portal URL for energy balance lookup |
| `MIN_ENERGY_TO_PROMPT` | NO | 1 | Minimum energy required to send chat |
| `LOG_LEVEL` | NO | INFO | Python logging level (DEBUG/INFO/WARN/ERROR) |

## Maintenance Notes

- **Hermes version pin:** Container's `Dockerfile.hermes` pins `hermes-agent==0.14.0`. Before bumping, run `scripts/test-hermes-bridge.ts` regression test.
- **Bridge crash policy:** Container's entrypoint restarts bridge on crash (systemd-like supervisor). Bridge itself supervises Hermes subprocess and auto-respawns.
- **Log rotation:** Bridge logs to stdout (Docker captures). Container should mount log volume for persistence.
- **Memory profile:** Bridge target footprint < 50 MB resident. Hermes subprocess separate (300-500 MB typical).
