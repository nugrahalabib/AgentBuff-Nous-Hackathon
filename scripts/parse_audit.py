import io
lines = io.open(r"C:\Users\nugra\AppData\Local\Temp\audit-real.txt", encoding="utf-8").read().split("\n")
locks, readys, llmkey_tools = [], [], []
for l in lines:
    s = l.strip()
    if s.startswith("LOCK") and "enabled=" in s:
        locks.append(s)
    elif s.startswith("ready") and "enabled=" in s:
        readys.append(s)
    if "llm-key" in s and "enabled=" in s:
        llmkey_tools.append(s)
out = []
out.append("=== LOCKED TOOLSETS (%d) ===" % len(locks))
out.extend(locks)
out.append("")
out.append("=== READY TOOLSETS (%d) ===" % len(readys))
out.extend(readys)
out.append("")
out.append("=== ALL llm-key TOOLSETS (%d) — these depend on a model key ===" % len(llmkey_tools))
out.extend(llmkey_tools)
io.open(r"C:\Users\nugra\Documents\Project\Agentic-AgentBuff\LandingPage\scripts\audit_parsed.txt",
        "w", encoding="utf-8").write("\n".join(out))
print("locks=%d readys=%d llmkey=%d" % (len(locks), len(readys), len(llmkey_tools)))
