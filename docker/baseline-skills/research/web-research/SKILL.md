---
name: web-research
description: "Effective strategies for web research, person investigation (OSINT), and overcoming subagent search failures."
version: 1.0.0
author: Hermes Agent
---

# Web Research & Identity Investigation

This skill provides strategies for thorough web research, specifically focused on identifying individuals (OSINT) and overcoming common failure modes in AI-driven search (like empty summaries from subagents).

## Core Strategies

### 1. Investigating People (OSINT)
When searching for an individual with a potentially common name or limited public footprint:
- **Site-Specific Queries:** Use `site:linkedin.com "Name"`, `site:instagram.com "Name"`, or `site:github.com "Name"` in the search goal to force the agent to look at specific professional or social hubs.
- **Location & Context:** Combine the name with suspected locations, universities, or employers (e.g., `"Nugraha Labib" Bandung`, `"Nugraha Labib" ITB`).
- **Handle Discovery:** Look for consistent handles (e.g., `@nugrahalabib`) across platforms.

### 2. Overcoming Subagent Failures
If a `delegate_task` with the `web` toolset returns an `(empty)` summary:
- **Drill Down:** The subagent may be failing because the goal is too broad or the results are "noisy." Break the task into specific platform searches (e.g., "Find the LinkedIn profile of X" instead of "Who is X").
- **Direct Link Extraction:** Ask the subagent to "Return the top 3 URLs and their snippets" rather than a synthesized summary.
- **PTY/Terminal Fallback:** If the `web` toolset is blocked or failing, use `terminal` with `curl` to fetch specific pages or search engine results (note: raw `curl` to Google/DuckDuckGo may hit bot detection).

## Pitfalls
- **Definitive Summary Bias:** Subagents often return an empty summary if they cannot find a "definitive" single answer. Instruct them to "provide any relevant leads or partial matches" if no single answer is found.
- **Common Names:** Always cross-reference multiple data points (e.g., "Does the person on LinkedIn match the university mention found on a blog?") to avoid identity confusion.

## Verification
- Cross-check findings across at least two independent sources (e.g., a university directory and a social media profile).
- Check the "about" sections or "bio" snippets for mentions of secondary identities or projects.
