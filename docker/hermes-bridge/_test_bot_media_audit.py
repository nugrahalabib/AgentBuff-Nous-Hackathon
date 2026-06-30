"""One-off audit script — run inside chief's container via docker exec to
verify bot_media_extractor produces correct output for synthetic agent
responses. NOT shipped in production paths."""

import os
import sys

sys.path.insert(0, "/app/bridge")
os.environ.setdefault("BRIDGE_PUBLIC_HOST", "127.0.0.1")
os.environ.setdefault("BRIDGE_PUBLIC_HEALTH_PORT", "18801")

from bot_media_extractor import extract_bot_media

AGENT_TEXT = """Halo Chief! Ini gambar kucing yang gua bikin: MEDIA:/home/hermes/.hermes/cache/images/cat.png

Plus suara untuk lo: [[audio_as_voice]]
MEDIA:/home/hermes/.hermes/cache/audio/hello.mp3

Dan ada juga laporan PDF: MEDIA:/home/hermes/.hermes/cache/documents/report.pdf

Semoga membantu!"""

cleaned, attachments = extract_bot_media(AGENT_TEXT)
print("=== CLEANED TEXT ===")
print(cleaned)
print()
print(f"=== {len(attachments)} ATTACHMENTS EXTRACTED ===")
for i, a in enumerate(attachments, 1):
    kind = a["kind"]
    name = a["name"]
    size = a.get("sizeBytes")
    mime = a.get("mimeType")
    url = a["displayUrl"]
    print(f"{i}. kind={kind} name={name} size={size} mime={mime}")
    print(f"   url={url}")
print()
print("=== VALIDATION ===")
expected_kinds = {"image", "audio", "document"}
got_kinds = {a["kind"] for a in attachments}
print(f"Expected kinds: {sorted(expected_kinds)}")
print(f"Got kinds:      {sorted(got_kinds)}")
print(f"Match: {expected_kinds == got_kinds}")
print(f"MEDIA tags stripped from cleaned text: {'MEDIA:' not in cleaned}")
print(f"audio_as_voice stripped: {'[[audio_as_voice]]' not in cleaned}")
