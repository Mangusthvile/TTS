export type TtsProvider = "google" | "openai";

const OPENAI_PREFIX = "openai:";
const DEFAULT_GOOGLE_VOICE = "en-US-Standard-C";

export function parseTtsVoiceId(raw?: string | null): { provider: TtsProvider; id: string; raw: string } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { provider: "google", id: DEFAULT_GOOGLE_VOICE, raw: DEFAULT_GOOGLE_VOICE };
  }
  if (trimmed.toLowerCase().startsWith(OPENAI_PREFIX)) {
    return { provider: "openai", id: trimmed.slice(OPENAI_PREFIX.length), raw: trimmed };
  }
  return { provider: "google", id: trimmed, raw: trimmed };
}

export function isOpenAiVoiceId(raw?: string | null): boolean {
  return (raw ?? "").trim().toLowerCase().startsWith(OPENAI_PREFIX);
}

export function toStoredVoiceId(provider: TtsProvider, id: string): string {
  if (provider === "openai") return `${OPENAI_PREFIX}${id}`;
  return id;
}
