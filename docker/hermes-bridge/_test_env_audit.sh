#!/bin/sh
# Audit script — check HERMES_PLATFORM env on every running process
echo "=== Running processes ==="
for pid_dir in /proc/[0-9]*; do
  pid=$(basename "$pid_dir")
  comm=$(cat "$pid_dir/comm" 2>/dev/null)
  if [ -z "$comm" ]; then continue; fi
  echo "PID=$pid comm=$comm"
  if grep -a "HERMES_PLATFORM" "$pid_dir/environ" 2>/dev/null; then
    echo "  ^ HAS HERMES_PLATFORM"
  fi
done
