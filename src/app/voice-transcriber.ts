export const VOICE_TRANSCRIPTION_MODES = ["off", "openrouter"] as const;

export const DEFAULT_VOICE_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
export const DEFAULT_VOICE_MODEL = "google/gemini-2.5-flash";
export const DEFAULT_VOICE_COMMAND = "python3";

/**
 * How the application obtains text for an inbound voice message.
 *
 * `off` keeps the alpha behavior: audio is never downloaded. `openrouter`
 * downloads the allow-listed audio and sends it to a configured OpenRouter
 * endpoint through the out-of-process transcription script.
 */
export type VoiceTranscriptionMode = (typeof VOICE_TRANSCRIPTION_MODES)[number];

export function isVoiceTranscriptionMode(value: string): value is VoiceTranscriptionMode {
	return VOICE_TRANSCRIPTION_MODES.some((mode) => mode === value);
}

export interface VoiceTranscriptionInput {
	audio: Uint8Array;
	mimeType?: string;
	language?: string;
}

export interface VoiceTranscriptionResult {
	text: string;
	language?: string;
}

export interface VoiceTranscriber {
	transcribe(input: VoiceTranscriptionInput, signal?: AbortSignal): Promise<VoiceTranscriptionResult>;
}
