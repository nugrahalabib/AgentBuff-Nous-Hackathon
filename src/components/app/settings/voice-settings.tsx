"use client";

/**
 * VoiceSettings — the "Suara" category body for /app/pengaturan.
 *
 * Mirrors the Nous desktop "Voice" tab but reorganised into two friendly boxes
 * (TTS = AI speaks, STT = speech to text) with PROGRESSIVE DISCLOSURE: the
 * provider-specific voice/model rows only appear once that provider is picked,
 * so a non-developer sees 2-3 rows, not 25 at once.
 *
 * Every control maps to a REAL engine config field; every dropdown's options are
 * the canonical valid values from the engine's own config.py (verified live on
 * 0.16.0), never invented. Reads/writes go through the same curr()/setField()
 * staging the parent PengaturanTab owns, so the shared save bar applies them.
 *
 * Desktop-only fields (voice.record_key global hotkey, voice.max_recording_seconds)
 * are intentionally omitted — they do nothing in a web app (Chief decision
 * 2026-06-12: don't ship settings that silently no-op).
 */

import { Mic, Volume2 } from "lucide-react";
import { useI18n } from "@/lib/i18n/context";
import { SelectRow, SubGroup, TextRow, ToggleRow } from "./primitives";

type Curr = (path: string) => unknown;
type SetField = (path: string, value: unknown) => void;

// Canonical option lists — source: engine hermes_cli/config.py inline comments
// (tts.provider line 1547, stt.provider 1599, model/voice enums in-block).
const TTS_PROVIDER_IDS = [
  "gemini",
  "edge",
  "openai",
  "elevenlabs",
  "xai",
  "minimax",
  "mistral",
  "neutts",
  "kittentts",
  "piper",
] as const;
const STT_PROVIDER_IDS = ["local", "groq", "openai", "mistral", "elevenlabs"] as const;
const OPENAI_TTS_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const STT_LOCAL_MODELS = ["tiny", "base", "small", "medium", "large-v3"];
const OPENAI_STT_MODELS = ["whisper-1", "gpt-4o-mini-transcribe", "gpt-4o-transcribe"];
const MISTRAL_STT_MODELS = ["voxtral-mini-latest", "voxtral-mini-2602"];
const ELEVENLABS_STT_MODELS = ["scribe_v2", "scribe_v1"];

function toOptions(
  values: readonly string[],
  labels?: Record<string, string>,
): { value: string; label: string }[] {
  return values.map((v) => ({ value: v, label: labels?.[v] ?? v }));
}

export function VoiceSettings({ curr, setField }: { curr: Curr; setField: SetField }) {
  const { t } = useI18n();
  const vs = t.app.settings.voice;

  const str = (path: string, fallback: string): string => {
    const v = curr(path);
    return v == null ? fallback : String(v);
  };
  const bool = (path: string): boolean => Boolean(curr(path));

  const ttsProvider = str("tts.provider", "gemini");
  const sttEnabled = bool("stt.enabled");
  const sttProvider = str("stt.provider", "local");

  return (
    <div className="flex flex-col gap-3">
      {/* ── Box 1: TTS — AI speaks ────────────────────────────────────────── */}
      <SubGroup
        icon={<Volume2 className="size-4 text-fuchsia-300" />}
        title={vs.ttsGroup.title}
        desc={vs.ttsGroup.desc}
      >
        <ToggleRow
          label={vs.readAloud.label}
          help={vs.readAloud.help}
          checked={bool("voice.auto_tts")}
          onChange={(v) => setField("voice.auto_tts", v)}
        />
        <SelectRow
          label={vs.ttsProvider.label}
          help={vs.ttsProvider.help}
          value={ttsProvider}
          options={toOptions(TTS_PROVIDER_IDS, vs.ttsProviders)}
          onChange={(v) => setField("tts.provider", v)}
        />

        {ttsProvider === "gemini" && (
          <TextRow
            label={vs.geminiVoice.label}
            help={vs.geminiVoice.help}
            value={str("tts.gemini.voice", "Kore")}
            placeholder="Kore"
            onChange={(v) => setField("tts.gemini.voice", v)}
          />
        )}
        {ttsProvider === "edge" && (
          <TextRow
            label={vs.edgeVoice.label}
            help={vs.edgeVoice.help}
            value={str("tts.edge.voice", "")}
            placeholder="en-US-AriaNeural"
            onChange={(v) => setField("tts.edge.voice", v)}
          />
        )}
        {ttsProvider === "openai" && (
          <>
            <SelectRow
              label={vs.openaiVoice.label}
              value={str("tts.openai.voice", "alloy")}
              options={toOptions(OPENAI_TTS_VOICES)}
              onChange={(v) => setField("tts.openai.voice", v)}
            />
            <TextRow
              label={vs.openaiModel.label}
              value={str("tts.openai.model", "gpt-4o-mini-tts")}
              placeholder="gpt-4o-mini-tts"
              onChange={(v) => setField("tts.openai.model", v)}
            />
          </>
        )}
        {ttsProvider === "elevenlabs" && (
          <>
            <TextRow
              label={vs.elevenVoice.label}
              help={vs.elevenVoice.help}
              value={str("tts.elevenlabs.voice_id", "")}
              placeholder="pNInz6obpgDQGcFmaJgB"
              onChange={(v) => setField("tts.elevenlabs.voice_id", v)}
            />
            <TextRow
              label={vs.elevenModel.label}
              value={str("tts.elevenlabs.model_id", "eleven_multilingual_v2")}
              placeholder="eleven_multilingual_v2"
              onChange={(v) => setField("tts.elevenlabs.model_id", v)}
            />
          </>
        )}
        {ttsProvider === "xai" && (
          <>
            <TextRow
              label={vs.xaiVoice.label}
              help={vs.xaiVoice.help}
              value={str("tts.xai.voice_id", "")}
              placeholder="eve"
              onChange={(v) => setField("tts.xai.voice_id", v)}
            />
            <TextRow
              label={vs.xaiLang.label}
              help={vs.xaiLang.help}
              value={str("tts.xai.language", "")}
              placeholder="en"
              onChange={(v) => setField("tts.xai.language", v)}
            />
          </>
        )}
        {ttsProvider === "mistral" && (
          <>
            <TextRow
              label={vs.mistralVoice.label}
              value={str("tts.mistral.voice_id", "")}
              onChange={(v) => setField("tts.mistral.voice_id", v)}
            />
            <TextRow
              label={vs.mistralModel.label}
              value={str("tts.mistral.model", "")}
              placeholder="voxtral-mini-tts-2603"
              onChange={(v) => setField("tts.mistral.model", v)}
            />
          </>
        )}
        {ttsProvider === "neutts" && (
          <TextRow
            label={vs.neuttsModel.label}
            help={vs.neuttsModel.help}
            value={str("tts.neutts.model", "")}
            placeholder="neuphonic/neutts-air-q4-gguf"
            onChange={(v) => setField("tts.neutts.model", v)}
          />
        )}
        {ttsProvider === "piper" && (
          <TextRow
            label={vs.piperVoice.label}
            help={vs.piperVoice.help}
            value={str("tts.piper.voice", "")}
            placeholder="en_US-lessac-medium"
            onChange={(v) => setField("tts.piper.voice", v)}
          />
        )}
        {(ttsProvider === "minimax" || ttsProvider === "kittentts") && (
          <p className="py-2 text-xs leading-snug text-white/40">{vs.providerDefaultNote}</p>
        )}
      </SubGroup>

      {/* ── Box 2: STT — speech to text ───────────────────────────────────── */}
      <SubGroup
        icon={<Mic className="size-4 text-cyan-300" />}
        title={vs.sttGroup.title}
        desc={vs.sttGroup.desc}
      >
        <ToggleRow
          label={vs.sttEnabled.label}
          help={vs.sttEnabled.help}
          checked={sttEnabled}
          onChange={(v) => setField("stt.enabled", v)}
        />
        {sttEnabled && (
          <>
            <SelectRow
              label={vs.sttProvider.label}
              help={vs.sttProvider.help}
              value={sttProvider}
              options={toOptions(STT_PROVIDER_IDS, vs.sttProviders)}
              onChange={(v) => setField("stt.provider", v)}
            />
            {sttProvider === "local" && (
              <>
                <SelectRow
                  label={vs.localModel.label}
                  help={vs.localModel.help}
                  value={str("stt.local.model", "base")}
                  options={toOptions(STT_LOCAL_MODELS)}
                  onChange={(v) => setField("stt.local.model", v)}
                />
                <TextRow
                  label={vs.localLang.label}
                  help={vs.localLang.help}
                  value={str("stt.local.language", "")}
                  placeholder={vs.langAuto}
                  onChange={(v) => setField("stt.local.language", v)}
                />
              </>
            )}
            {sttProvider === "openai" && (
              <SelectRow
                label={vs.openaiStt.label}
                value={str("stt.openai.model", "whisper-1")}
                options={toOptions(OPENAI_STT_MODELS)}
                onChange={(v) => setField("stt.openai.model", v)}
              />
            )}
            {sttProvider === "mistral" && (
              <SelectRow
                label={vs.mistralStt.label}
                value={str("stt.mistral.model", "voxtral-mini-latest")}
                options={toOptions(MISTRAL_STT_MODELS)}
                onChange={(v) => setField("stt.mistral.model", v)}
              />
            )}
            {sttProvider === "elevenlabs" && (
              <>
                <SelectRow
                  label={vs.elevenStt.label}
                  value={str("stt.elevenlabs.model_id", "scribe_v2")}
                  options={toOptions(ELEVENLABS_STT_MODELS)}
                  onChange={(v) => setField("stt.elevenlabs.model_id", v)}
                />
                <TextRow
                  label={vs.elevenLang.label}
                  help={vs.elevenLang.help}
                  value={str("stt.elevenlabs.language_code", "")}
                  placeholder={vs.langAuto}
                  onChange={(v) => setField("stt.elevenlabs.language_code", v)}
                />
                <ToggleRow
                  label={vs.tagEvents.label}
                  help={vs.tagEvents.help}
                  checked={bool("stt.elevenlabs.tag_audio_events")}
                  onChange={(v) => setField("stt.elevenlabs.tag_audio_events", v)}
                />
                <ToggleRow
                  label={vs.diarize.label}
                  help={vs.diarize.help}
                  checked={bool("stt.elevenlabs.diarize")}
                  onChange={(v) => setField("stt.elevenlabs.diarize", v)}
                />
              </>
            )}
            {sttProvider === "groq" && (
              <p className="py-2 text-xs leading-snug text-white/40">{vs.providerDefaultNote}</p>
            )}
          </>
        )}
      </SubGroup>
    </div>
  );
}
