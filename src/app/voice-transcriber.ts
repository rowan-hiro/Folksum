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
