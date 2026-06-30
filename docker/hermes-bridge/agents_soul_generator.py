"""
agents_soul_generator.py — LLM-driven SOUL.md synthesis for the wizard.

Wizard step 2 ("Persona & SOUL") lets the user describe their agent in 1-3
sentences then click "Generate". This module turns that brief into a
comprehensive SOUL.md following AgentBuff brand + structure conventions.

Pattern mirrors `agents_describer.py` — uses the same Hermes auxiliary
LLM client (`agent.auxiliary_client.get_text_auxiliary_client`) so the
user doesn't need to pre-configure another model just for SOUL gen.

RPC surface:
    agents.soulGenerate(name, brief, channelTargets?, persona?, tone?)
        → { ok: true, soul: str, model: str }
        OR { ok: false, reason: str }

The generated SOUL ALWAYS includes the AgentBuff brand-leak prevention
block (LARANGAN KERAS section) regardless of what the user typed — that
is a non-negotiable system invariant.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

log = logging.getLogger("bridge.agents_soul_generator")


# System prompt that forces the LLM to produce SOUL.md conforming to
# AgentBuff house style: Bahasa Indonesia, Buff brand, anti-leak block,
# sectioned (Identity / Tone / Expertise / Larangan / Output rules).
_SYSTEM_PROMPT = """\
Kamu adalah generator SOUL.md untuk platform AgentBuff. SOUL.md adalah
system prompt yang Hermes engine baca pada setiap sesi chat untuk
membentuk persona dan perilaku agen.

OUTPUT WAJIB:
1. Tulis dalam Bahasa Indonesia santai-profesional (vibe gaming/hustler).
2. Mulai dengan baris definisi identitas: "Kamu adalah **<Nama>**, ..."
3. Sertakan section terstruktur (gunakan ## sebagai header):
   - **IDENTITAS & TUJUAN** — siapa agen ini, apa fungsi utama, untuk
     audiens siapa
   - **TONE & GAYA** — cara bicara, formal vs santai, jenis humor,
     panjang jawaban default
   - **KEAHLIAN INTI** — 3-7 keahlian utama yang agen kuasai, dengan
     contoh tugas konkret
   - **LARANGAN KERAS** — JANGAN sebutkan "Hermes", "Hermes Agent",
     "Nous Research", "OpenClaw", "Claw", atau nama engine/backend
     apa pun. Engine adalah rahasia perusahaan. Kalau user nanya
     "kamu pake engine apa?", jawab: "Aku <Nama> dari AgentBuff.
     Detail teknis engine bukan urusan publik."
   - **OUTPUT RULES** — format jawaban (markdown, MEDIA: untuk
     gambar/audio/video), kapan pakai tool, etika tool call

OUTPUT TIDAK BOLEH:
- Mengandung kata "Hermes", "Nous", "OpenClaw", "Claw".
- Plain text saja tanpa section header.
- Singkat satu paragraf saja — minimum 250 kata supaya komprehensif.
- Pakai bahasa Inggris kecuali untuk istilah teknis (API, tool, dll.).
- Sertakan markdown code-fence di sekeliling output (output plain markdown).

CONTOH STRUKTUR (jangan persis ditiru, sesuaikan dengan brief):

    Kamu adalah **<Nama>**, <satu kalimat siapa kamu>.

    ## IDENTITAS & TUJUAN
    <2-4 kalimat>

    ## TONE & GAYA
    - <poin tone 1>
    - <poin tone 2>
    - <poin gaya bicara>

    ## KEAHLIAN INTI
    - **<Keahlian 1>**: <contoh konkret>
    - **<Keahlian 2>**: <contoh konkret>
    - ...

    ## LARANGAN KERAS
    1. JANGAN sebut "Hermes", "Hermes Agent", "Nous Research",
       "OpenClaw", "Claw", atau nama engine apa pun.
    2. ...

    ## OUTPUT RULES
    - <format default>
    - <kapan pakai tool>
    - ...

Kalau user kasih brief tipis (cuma nama), kembangkan jadi versi
komprehensif sendiri pakai inferensi yang masuk akal untuk role itu.
"""

_USER_TEMPLATE = """\
Nama agen: {name}

Persona/expertise (one-liner): {persona}

Channel target (opsional, kosong = web saja): {channels}

Brief detail dari user (mungkin kosong — kembangkan sendiri):
{brief}

Tone preference (opsional): {tone}

Tugas kamu: tulis SOUL.md komprehensif sesuai instruksi di system prompt.
"""


_MAX_SOUL_BYTES = 64 * 1024  # 64 KB — matches Hermes prompt_builder cap


async def generate_soul(
    *,
    name: str,
    brief: str = "",
    persona: str = "",
    channel_targets: Optional[list[str]] = None,
    tone: str = "",
) -> dict:
    """Synthesize a SOUL.md from a brief. Returns dict with `ok` flag."""
    name_clean = (name or "").strip() or "Agent"
    brief_clean = (brief or "").strip()
    persona_clean = (persona or "").strip()
    tone_clean = (tone or "").strip()
    channels_clean = ", ".join(channel_targets or []) or "web saja"

    # Inputs are user-supplied — sanity cap to prevent prompt injection bloat
    if len(brief_clean) > 4000:
        brief_clean = brief_clean[:4000] + "…"
    if len(persona_clean) > 500:
        persona_clean = persona_clean[:500] + "…"

    user_msg = _USER_TEMPLATE.format(
        name=name_clean,
        persona=persona_clean or "(tidak disebutkan — infer dari nama + brief)",
        channels=channels_clean,
        brief=brief_clean or "(tidak ada — buat versi general yang fokus pada nama)",
        tone=tone_clean or "(default — santai profesional, vibe gaming/hustler Indonesia)",
    )

    # Resolve auxiliary LLM client (same pattern as agents_describer.py)
    try:
        from agent.auxiliary_client import (  # type: ignore
            get_text_auxiliary_client,
            get_auxiliary_extra_body,
        )
    except ImportError as e:
        log.warning("auxiliary_client import failed: %s", e)
        return {"ok": False, "reason": "llm_unavailable"}

    try:
        client, model_id = get_text_auxiliary_client("agentbuff_soul_generator")
    except Exception as e:
        log.warning("get_text_auxiliary_client failed: %s", e)
        return {"ok": False, "reason": "llm_unavailable"}

    if client is None or not model_id:
        return {"ok": False, "reason": "no_llm_provider"}

    try:
        extra = get_auxiliary_extra_body() or None
        resp = client.chat.completions.create(
            model=model_id,
            messages=[
                {"role": "system", "content": _SYSTEM_PROMPT},
                {"role": "user", "content": user_msg},
            ],
            temperature=0.7,
            max_tokens=2400,
            timeout=60,
            extra_body=extra,
        )
        text = (resp.choices[0].message.content or "").strip()
    except Exception as e:
        log.warning("llm SOUL generate call failed: %s", e)
        return {"ok": False, "reason": f"llm_call_failed: {type(e).__name__}"}

    if not text:
        return {"ok": False, "reason": "llm_empty_response"}

    # Strip wrapping code fences if model added them (common LLM tic)
    if text.startswith("```"):
        # Drop the first fence line + optional language tag
        text = text.split("\n", 1)[1] if "\n" in text else text
        # Drop trailing fence
        if text.rstrip().endswith("```"):
            text = text.rstrip()[:-3].rstrip()

    # Defensive brand scrub — even though system prompt forbids brand
    # leaks, the model occasionally slips. Hard-replace common brand
    # tokens before returning. Same pattern as event_translator.scrub_brand
    # but applied here too as a safety net.
    for old, new in (
        ("Hermes Agent", "Buff"),
        ("Hermes-Agent", "Buff"),
        ("hermes-agent", "buff"),
        ("Nous Research", "AgentBuff"),
        ("Hermes", "AgentBuff"),
        ("hermes", "agentbuff"),
        ("OpenClaw", "AgentBuff"),
        ("openclaw", "agentbuff"),
    ):
        text = text.replace(old, new)

    # Cap size to Hermes prompt_builder limit
    if len(text.encode("utf-8")) > _MAX_SOUL_BYTES:
        # Truncate at last paragraph boundary that fits
        while len(text.encode("utf-8")) > _MAX_SOUL_BYTES:
            text = text.rsplit("\n\n", 1)[0]
        text += "\n\n_(SOUL truncated — over 64 KB)_"

    return {
        "ok": True,
        "soul": text,
        "model": model_id,
    }
