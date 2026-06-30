---
name: observability-and-audit-mode
description: "Configure and maintain high-transparency operating modes (Audit Mode) for users who want to observe the agent's internal tool calls, terminal commands, and reasoning."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [observability, audit, transparency, verbose, config, logging]
    category: software-development
---

# Observability and Audit Mode

This skill governs the "High Transparency" or "Audit" operating mode. Use this when a user expresses a desire to see "the machine working," "what's happening in the terminal," or wants to audit the agent's tool calls and reasoning in real-time.

## Triggers

- User asks: "How do you do that?", "Show me the terminal", "I want to audit your work", "Show me your reasoning".
- User expresses frustration with "black box" behavior or "silent" tool execution.

## Configuration Commands

To enable high transparency, run the following commands (most effective in the same turn or via the CLI):

### Persistent Config (Affects config.yaml)
- `hermes config set display.tool_progress true` — Shows real-time tool progress indicators.
- `hermes config set display.show_cost true` — Displays token/cost info (if available).
- `hermes config set display.show_reasoning all` — Shows the full chain-of-thought/reasoning blocks.

### Session Commands (Slash Commands)
- `/verbose all` — Ensures all tool calls and outputs are visible in the chat.
- `/footer on` — Displays metadata (session ID, model, provider) at the end of each response.
- `/usage` — Periodically run this if the user wants to see current session costs.

## Workflow for Audit-Loving Users

1.  **Transparency First**: Before executing a complex sequence of terminal commands, summarize the plan.
2.  **Raw Output Access**: If the user asks "what happened", don't just summarize; offer to show the raw terminal output using `read_file` or `terminal` if it wasn't already visible.
3.  **Visible Tooling**: Even if a task could be done silently with `execute_code`, prefer individual `terminal` or `file` calls if the user is in Audit Mode so they can see each step.
4.  **Avoid Silencing**: Do not use `2>/dev/null` or `> /dev/null` unless the output is truly massive noise that would crash the UI. Let the user see the stderr.

## Pitfalls

- **UI Noise**: In some messaging platforms (like Telegram), very high verbosity can trigger rate limits or make the chat hard to read. Use `/footer on` and `display.tool_progress` as the primary signals before going full `/verbose all`.
- **Secret Redaction**: Even in Audit Mode, ensure `security.redact_secrets` is respected if enabled. Do not reveal raw API keys just for "transparency."
