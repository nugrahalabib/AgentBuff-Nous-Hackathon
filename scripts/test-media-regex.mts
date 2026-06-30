// Quick unit test for the media-prefix regex patterns.
// Run: pnpm tsx scripts/test-media-regex.mts

import { extractMediaPrefixes } from "../src/lib/app/strip-inbound-meta";

const samples = [
  {
    name: "VN — EXACT format from screenshot 2026-05-23 15:14",
    input: `[The user sent a voice message~ Here's what they said: "Tes tes 1 2 3 masuk enggak?"]`,
    expectKinds: ["audio"],
    expectCleanText: "",
  },
  {
    name: "VN — exact bridge output (ASCII apostrophe + ASCII quotes)",
    input: `[The user sent a voice message~ Here's what they said: "Cek cek cek sekali lagi ya."]`,
    expectKinds: ["audio"],
  },
  {
    name: "Video — exact bridge output",
    input: `[The user sent a video. Here's what's in it: "A cat playing piano."]`,
    expectKinds: ["video"],
  },
  {
    name: "Document extracted (PDF)",
    input: `[The user sent a document: 'proposal.pdf' (PDF). Extracted content below — original file at /cache/x.pdf.]\n\n--- BEGIN proposal.pdf ---\nHello world content here\n--- END proposal.pdf ---`,
    expectKinds: ["document"],
  },
  {
    name: "Document binary fallback",
    input: `[The user sent a document: 'report.xlsx' (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet). It is saved at: /cache/r.xlsx. Read from this path...]`,
    expectKinds: ["document"],
  },
  {
    name: "VN + user text mixed",
    input: `[The user sent a voice message~ Here's what they said: "Halo Buff"]\n\nGimana kabarnya?`,
    expectKinds: ["audio"],
    expectCleanText: "Gimana kabarnya?",
  },
];

let failed = 0;
for (const s of samples) {
  const result = extractMediaPrefixes(s.input);
  const kinds = result.summaries.map((x) => x.kind);
  const ok =
    JSON.stringify(kinds) === JSON.stringify(s.expectKinds) &&
    (s.expectCleanText === undefined || result.stripped === s.expectCleanText);
  console.log(`${ok ? "PASS" : "FAIL"}: ${s.name}`);
  if (!ok) {
    failed++;
    console.log(`  expected kinds: ${JSON.stringify(s.expectKinds)}`);
    console.log(`  actual kinds:   ${JSON.stringify(kinds)}`);
    console.log(`  summaries:      ${JSON.stringify(result.summaries, null, 2)}`);
    console.log(`  stripped:       ${JSON.stringify(result.stripped)}`);
  }
}
process.exit(failed > 0 ? 1 : 0);
