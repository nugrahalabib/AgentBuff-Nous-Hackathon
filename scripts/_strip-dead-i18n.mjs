// Remove confirmed-dead top-level i18n namespaces from a dictionary/type file.
// Brace-counts each `  <key>:` block (2-space indent = top level) and removes it.
// Run: node scripts/_strip-dead-i18n.mjs <file...>
import { readFileSync, writeFileSync } from "fs";

const DEAD = [
  "tutorialMode", "finalCta", "socialProof", "painPoints", "howItWorks",
  "features", "whatsappShowcase", "useCases", "buffhub", "pricing",
  "testimonials", "trust", "cta",
];

for (const file of process.argv.slice(2)) {
  let lines = readFileSync(file, "utf8").split("\n");
  for (const key of DEAD) {
    const startRe = new RegExp("^  " + key + ":\\s");
    const start = lines.findIndex((l) => startRe.test(l));
    if (start === -1) continue;
    let depth = 0, seen = false, end = -1;
    for (let i = start; i < lines.length; i++) {
      for (const ch of lines[i]) {
        if (ch === "{") { depth++; seen = true; }
        else if (ch === "}") { depth--; }
      }
      if (seen && depth === 0) { end = i; break; }
    }
    if (end === -1) { console.log(`${file}: ${key} — no matching close, SKIPPED`); continue; }
    lines.splice(start, end - start + 1);
    console.log(`${file}: removed ${key} (was lines ${start + 1}..${end + 1})`);
  }
  writeFileSync(file, lines.join("\n"));
}
