---
name: system-audit-and-introspection
description: "Techniques for providing system transparency, hardware/OS auditing, and configuring 'Audit Mode' for users."
version: 1.0.0
author: Hermes Agent
license: MIT
platforms: [linux, macos, windows]
metadata:
  hermes:
    tags: [audit, introspection, hardware, os, configuration, transparency, wsl, docker]
    category: software-development
---

# System Audit & Introspection

Use this skill when a user wants to "audit" the system, see "under the hood," or understand the hardware/software environment where Hermes is running. This is common for technical users, developers, or those curious about the agent's internal state.

## Audit Mode (User Preference)

When a user asks to "see what you're doing" or "audit the chat," enable **Audit Mode** by setting the following configuration flags. This provides maximum transparency in the messaging platform (e.g., Telegram, Discord).

### Configuration Commands
```bash
hermes config set display.tool_progress true
hermes config set display.show_cost true
hermes config set display.show_reasoning all
```

### In-Session Toggles
- `/verbose all`: Displays all tool call logs.
- `/footer on`: Displays runtime metadata (tokens, cost, latency) at the end of each message.
- `/usage`: Shows current session token consumption.

## Hardware & Environment Auditing

Use a sequence of probes to provide a comprehensive report. Note that some commands might be missing in minimal container environments; always provide fallbacks.

### 1. CPU & Architecture
- `lscpu`: Comprehensive CPU info.
- `cat /proc/cpuinfo | grep "model name" | head -n 1`: Fallback if `lscpu` is missing.

### 2. Memory (RAM)
- `free -h`: Standard human-readable memory info.
- `cat /proc/meminfo | head -n 4`: Reliable fallback in minimal containers (shows MemTotal, MemFree, MemAvailable).

### 3. Storage (Disk)
- `df -h /`: Shows disk usage for the root filesystem.
- `lsblk`: Shows block devices (if available/permitted).

### 4. OS & Environment
- `cat /etc/os-release`: Shows the Linux distribution (e.g., Debian, Ubuntu).
- `uname -a`: Kernel and host info.
- `env`: Lists environment variables (check for `WSL_DISTRO_NAME` or `DOCKER_CONTAINER`).

### 5. Graphics (GPU)
- `nvidia-smi`: Check for NVIDIA GPUs.
- `ls -l /dev/nvidia*`: Low-level check for GPU device nodes.

## Workflow

1.  **Acknowledge Intent**: Confirm the user wants a transparent/audit experience.
2.  **Enable Flags**: Run the `config set` commands immediately.
3.  **Run Probes**: Execute the hardware/OS commands in a single `terminal` call.
4.  **Synthesize**: Present the data in a clear, labeled list (CPU, RAM, Disk, OS, GPU).
5.  **Explain the "Why"**: Briefly describe how Hermes uses these tools (Thinking -> Call -> Result -> Reply).

## Pitfalls

- **Missing Binaries**: Commands like `uptime`, `free`, or `lscpu` might be missing in Alpine or minimal Debian containers. Always have a `cat /proc/...` fallback ready.
- **Permission Denied**: Some hardware probes (like `dmidecode` or `lsblk`) might require sudo or be blocked by the container runtime.
- **Redaction**: Be mindful of `security.redact_secrets`. If the user asks for an `env` dump, sensitive tokens might be masked if redaction is on.
