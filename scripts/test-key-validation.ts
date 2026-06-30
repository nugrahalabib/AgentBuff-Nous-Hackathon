// Live regression for portal-side BYOK key validation.
//   pnpm tsx scripts/test-key-validation.ts
//
// Hits the real provider endpoints with BOGUS keys. Expected:
//   - GEMINI/OPENAI bogus  -> ok=false reason=invalid_key (proves URL + reject)
//   - unknown provider     -> ok=true  reason=unsupported (never blocks)
// If a known provider returns reason=unverifiable, the URL is likely wrong OR
// outbound network is blocked in this environment (not a definitive reject).

import { validateProviderKey } from "@/lib/onboarding/provider-validate";

const CASES: Array<{ env: string; key: string; expect: string }> = [
  { env: "GEMINI_API_KEY", key: "AIzaSyBOGUS_invalid_key_000000000000000", expect: "REJECT invalid_key" },
  { env: "OPENAI_API_KEY", key: "sk-bogus_invalid_000000000000000000000000", expect: "REJECT invalid_key" },
  { env: "GROQ_API_KEY", key: "gsk_bogus_invalid_0000000000000000000000", expect: "REJECT invalid_key" },
  { env: "SOMECORP_API_KEY", key: "whatever-unknown", expect: "ACCEPT unsupported" },
];

async function main() {
  let pass = 0;
  for (const c of CASES) {
    const r = await validateProviderKey(c.env, c.key);
    const line = `${c.env.padEnd(20)} ok=${r.ok} verified=${r.verified} reason=${r.reason} models=${r.modelCount ?? "-"}  // expect ${c.expect}`;
    console.log(line);
    if (c.env === "SOMECORP_API_KEY") {
      if (r.ok && r.reason === "unsupported") pass++;
    } else if (!r.ok && r.reason === "invalid_key") {
      pass++;
    }
  }
  console.log(`\n${pass}/${CASES.length} cases matched expectation (known providers need outbound network).`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
