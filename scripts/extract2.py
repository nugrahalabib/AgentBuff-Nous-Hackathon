import io, re, json
v = io.open(r"C:\Users\nugra\Documents\Project\Agentic-AgentBuff\LandingPage\src\components\app\agents\vocab.ts", encoding="utf-8").read()
single = re.findall(r'provider:\s*"([a-z0-9_-]+)"', v)
arrays = re.findall(r'providersAny:\s*\[([^\]]*)\]', v)
arrtokens = []
for a in arrays:
    arrtokens += re.findall(r'"([a-z0-9_-]+)"', a)
allset = sorted(set(single) | set(arrtokens))
engine = {"google","openai","anthropic","openrouter","groq","deepseek","xai","mistral","kimi","qwen","minimax","zhipu","cerebras","fireworks","together","deepgram"}
mismatch = [t for t in allset if t not in engine]
result = {"all_vocab_tokens": allset, "mismatch_need_alias": mismatch}
io.open(r"C:\Users\nugra\Documents\Project\Agentic-AgentBuff\LandingPage\scripts\ptokens.json","w",encoding="utf-8").write(json.dumps(result))
print("RESULT_ONELINE " + json.dumps(result))
