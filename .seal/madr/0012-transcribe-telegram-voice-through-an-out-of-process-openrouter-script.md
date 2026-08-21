# 12. Transcribe Telegram voice through an out-of-process OpenRouter script

Date: 2026-08-15

## Status

Accepted

## Context and Problem Statement

Decision 0008 shipped the Telegram alpha with voice transcription deferred: voice updates were acknowledged without calling getFile, so audio never left Telegram, and the household had to retype spoken capture requests. Enabling transcription requires either an on-device speech model or a third-party audio endpoint, and either choice touches the documented privacy boundary that voice payloads do not leave Telegram. The runtime must also keep a second provider credential out of SQLite, out of both JSON configuration files, and out of the model conversation, and must not let a transcript acquire more financial authority than a typed message.

## Decision Drivers

* Voice is the household's most natural capture mode and retyping defeats the alpha's purpose.
* The audio disclosure must be an explicit local decision, never a silent default.
* A second provider credential must not enter SQLite, JSON configuration, the process argument list, or the model conversation.
* A transcript must gain no financial authority that typed text does not already have.
* The transcription provider must be replaceable without touching the finance domain.

## Considered Options

* Out-of-process Python script posting to a configured OpenRouter endpoint.
* In-process Node HTTP client calling the same endpoint.
* Local on-device speech recognition such as a bundled Whisper build.
* Reusing the configured Pi chat provider for audio input.
* Keeping voice transcription deferred.

## Decision Outcome

Add an opt-in voiceTranscription mode that stays off by default. When a household sets openrouter, the Telegram adapter downloads the allow-listed audio, enforces duration and size ceilings first, and hands the bytes to a channel-neutral VoiceTranscriber. The runtime implementation spawns the bundled standard-library Python script python/folksum_transcribe.py, which posts base64 audio to the configured HTTPS OpenRouter chat-completions endpoint and writes exactly one JSON result to standard output. The key is accepted only through FOLKSUM_VOICE_API_KEY. The application reads it into memory to start the child and passes it through the child environment; it is never persisted to a JSON file or database row, never placed in an argument list that other local users can read from the process table, and never exposed to the model. The transcript is echoed to the chat and then re-enters through the ordinary coordinator prompt, so the credential-shaped-input check, confirmation policy, and Finance IR boundary are unchanged. Ogg/Opus is converted to WAV with ffmpeg; a missing converter fails closed with a plain message instead of uploading unusable audio.

## Consequences

* Enabled households send voice audio to a third party, so the documented privacy boundary now depends on configuration rather than on the adapter never downloading audio.
* Transcription needs Python 3 and ffmpeg on the host, and reports a clear failure when either is missing.
* The transcription provider is swappable through endpoint and model settings without changing the finance domain.
* Process isolation is narrower than it may appear. The application still downloads the audio into its own memory and still holds the key in memory to start the child, so isolation buys only that the provider upload, the base64 encoding, and the ffmpeg conversion happen outside the application process, at the cost of one child process per voice message.
* A local speech model remains a deferred extension that would restore the original boundary.

## Decision History

<!-- driftseal-reconciliation: be66cfb8-ef27-4ccd-ae27-c5ee214aa4ea -->
### 2026-08-15T08:18:56.402Z — Intent `2026-08-15-004`

Status: Accepted → Accepted

Confirmed after the PR 4 review with four hardening changes that do not alter the decision: the transcription script now refuses redirects so the Bearer key is never resent to another host or to plain HTTP, the runtime keeps its SIGKILL fallback until the child exits, the Telegram controller owns a shutdown-scoped AbortController that cancels an in-flight download or transcription, and the provider-supplied transcript is bounded to 2000 characters before it is echoed or sent to the model.

<!-- driftseal-reconciliation: 387d7607-df7c-494c-b487-2f0d57df5357 -->
### 2026-08-15T08:55:17.334Z — Intent `2026-08-15-005`

Status: Accepted → Accepted

Corrected an overstated boundary claim after the second PR 4 review. The application downloads the audio into its own memory and reads the key from the environment to start the child, so process isolation is not a memory boundary; it only moves the provider upload, base64 encoding, and ffmpeg conversion out of the application process. The durable credential guarantees are unchanged: no persistence to JSON or SQLite, no argument list, no model exposure. Also recorded that termination now reaches the whole child process group and that a shutdown-cancelled turn fails its receipt closed without answering the channel.
