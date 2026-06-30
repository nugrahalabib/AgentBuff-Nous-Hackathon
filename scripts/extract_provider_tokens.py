import io, re
v = io.open(r"C:\Users\nugra\Documents\Project\Agentic-AgentBuff\LandingPage\src\components\app\agents\vocab.ts", encoding="utf-8").read()
# every provider: "x"
single = re.findall(r'provider:\s*"([a-z0-9_-]+)"', v)
# every providersAny: ["a","b",...]
arrays = re.findall(r'providersAny:\s*\[([^\]]*)\]', v)
arrtokens = []
for a in arrays:
    arrtokens += re.findall(r'"([a-z0-9_-]+)"', a)
from collections import Counter
out = []
out.append("provider: tokens => %s" % dict(Counter(single)))
out.append("providersAny tokens => %s" % dict(Counter(arrtokens)))
allset = sorted(set(single) | set(arrtokens))
out.append("ALL_DISTINCT_VOCAB_PROVIDER_TOKENS => %s" % allset)
# engine ids (from live authStatus)
engine = ["google","openai","anthropic","openrouter","groq","deepseek","xai","mistral","kimi","qwen","minimax","zhipu","cerebras","fireworks","together","deepgram"]
mismatch = [t for t in allset if t not in engine]
out.append("TOKENS_NOT_IN_ENGINE (mismatch => need alias) => %s" % mismatch)
io.open(r"C:\Users\nugra\Documents\Project\Agentic-AgentBuff\LandingPage\scripts\provider_tokens.txt","w",encoding="utf-8").write("\n".join(out))
print("\n".join(out))
