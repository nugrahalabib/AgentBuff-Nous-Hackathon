---
name: buffhub-marketplace
description: Search & buy skills/apps in the AgentBuff marketplace (BuffHub / Item Shop)
version: 3.0.0
author: AgentBuff
---

# BuffHub Marketplace — Search & Buy Skills in the AgentBuff Item Shop

Use this skill WHENEVER the user mentions: "marketplace", "BuffHub", "Item Shop",
"skill store", "find a skill", "buy a skill", "what apps are available", "POS",
"cashier", "a skill for <need>".

This is the **AgentBuff BuffHub** product catalog (NOT the skills already installed on
your Buff). TWO ready-to-use commands exist inside the container (already on PATH). Each
prints ONE fenced code block that the portal AUTOMATICALLY turns into a beautiful VISUAL
CARD.

## OUTPUT RULES (REQUIRED — read this)

Run the command EXACTLY as written, then **paste its stdout output EXACTLY AS IS** into
your reply — including the opening & closing triple backticks. Do NOT change the content,
do NOT summarize it into a text list, do NOT wrap it in another fence. You may add ONE
friendly sentence OUTSIDE the block (before or after), never inside.

## SEARCHING FOR A SKILL

STEP 1 — Determine the CORE KEYWORD from the user's request (lowercase); do NOT guess or
substitute your own:
- user looks for "**POS**" → keyword `pos`
- user looks for "**cashier**" → keyword `pos`
- user wants "**store / selling**" → keyword `store`
- user asks "what apps are available" / "show everything" → no keyword (empty)

STEP 2 — Run this command (replace ONLY `pos` with the user's keyword; for "show
everything" run with no argument):

```bash
buffhub-search pos
```

The server filters by keyword automatically, so results are always relevant (e.g. `pos`
only returns the POS UMKM Cashier). After pasting the block, ask briefly OUTSIDE the
block: "Which one would you like? Click a card to see the details."

## BUYING A SKILL

Confirm once, verbally, with the user ("Want me to buy **<Name>** for Rp <price>?").
After the user agrees, run this (replace `pos-umkm` with the slug chosen from the search
results):

```bash
buffhub-buy pos-umkm
```

Paste the output block EXACTLY AS IS. If the status is `purchased`, add ONE sentence
OUTSIDE the block: "It's active now — ready to use!". Then, if the user wants, use the
newly-bought skill right away.

## Style

Friendly, concise, confident. **Always respond in English.**
