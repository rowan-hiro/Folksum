#!/usr/bin/env python3
"""Transcribe one audio payload through an OpenRouter chat-completions endpoint.

The script is deliberately isolated from the Folksum application:

* the audio arrives as raw bytes on stdin and never touches the filesystem
  unless an explicit format conversion requires a private temporary file;
* the API key arrives only through the ``FOLKSUM_VOICE_API_KEY`` environment
  variable, so it never appears in a process argument list;
* exactly one JSON object is written to stdout, so the caller never has to
  parse free-form text;
* stdout carries no diagnostics and stderr carries no secret material.

Only the Python standard library is used, so no virtual environment or package
installation is required.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path

MAXIMUM_AUDIO_BYTES = 25 * 1024 * 1024
MAXIMUM_RESPONSE_BYTES = 4 * 1024 * 1024
DEFAULT_TIMEOUT_SECONDS = 60.0
CONVERSION_TIMEOUT_SECONDS = 60.0
DIRECT_FORMATS = ("wav", "mp3")
CONVERSION_SAMPLE_RATE = "16000"

SYSTEM_INSTRUCTION = (
    "You are a speech-to-text engine. Return only the verbatim transcript of "
    "the supplied audio. Never translate, summarize, answer, or explain. "
    "Return an empty string when the audio contains no intelligible speech."
)


class TranscriptionError(Exception):
    """A failure that must be reported to the caller as a JSON result."""


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="folksum_transcribe",
        description="Transcribe audio from stdin through an OpenRouter endpoint.",
    )
    parser.add_argument("--endpoint", required=True, help="OpenRouter chat-completions URL")
    parser.add_argument("--model", required=True, help="OpenRouter model identifier")
    parser.add_argument("--mime", default="", help="Declared audio MIME type")
    parser.add_argument("--language", default="", help="Optional BCP 47 language hint")
    parser.add_argument(
        "--timeout",
        type=float,
        default=DEFAULT_TIMEOUT_SECONDS,
        help="Request timeout in seconds",
    )
    arguments = parser.parse_args(argv)

    api_key = os.environ.get("FOLKSUM_VOICE_API_KEY", "").strip()
    try:
        result = transcribe(
            audio=read_stdin(),
            endpoint=arguments.endpoint,
            model=arguments.model,
            api_key=api_key,
            mime_type=arguments.mime,
            language=arguments.language,
            timeout=arguments.timeout,
        )
    except TranscriptionError as error:
        write_result({"ok": False, "error": redact(str(error), api_key)})
        return 0
    except Exception as error:  # noqa: BLE001 - the caller only ever sees JSON.
        write_result({"ok": False, "error": redact(f"Unexpected transcription failure: {error}", api_key)})
        return 0

    write_result(result)
    return 0


def transcribe(
    *,
    audio: bytes,
    endpoint: str,
    model: str,
    api_key: str,
    mime_type: str,
    language: str,
    timeout: float,
) -> dict[str, object]:
    if not api_key:
        raise TranscriptionError("FOLKSUM_VOICE_API_KEY is required for voice transcription.")
    if not endpoint.lower().startswith("https://"):
        raise TranscriptionError("The voice transcription endpoint must use HTTPS.")
    if not audio:
        raise TranscriptionError("The audio payload was empty.")
    if len(audio) > MAXIMUM_AUDIO_BYTES:
        raise TranscriptionError("The audio payload is larger than the 25 MB transcription limit.")
    if timeout <= 0 or timeout > 600:
        raise TranscriptionError("The transcription timeout must be between 0 and 600 seconds.")

    payload, audio_format = prepare_audio(audio, mime_type)
    request_body = build_request_body(
        model=model,
        audio=payload,
        audio_format=audio_format,
        language=language.strip(),
    )
    response = post_json(endpoint, request_body, api_key, timeout)
    text = extract_text(response)
    result: dict[str, object] = {"ok": True, "text": text}
    if language.strip():
        result["language"] = language.strip()
    return result


def prepare_audio(audio: bytes, mime_type: str) -> tuple[bytes, str]:
    """Return audio in a format the endpoint accepts, converting when required."""

    detected = detect_format(audio, mime_type)
    if detected in DIRECT_FORMATS:
        return audio, detected
    return convert_to_wav(audio), "wav"


def detect_format(audio: bytes, mime_type: str) -> str:
    normalized = mime_type.split(";", 1)[0].strip().lower()
    by_mime = {
        "audio/wav": "wav",
        "audio/wave": "wav",
        "audio/x-wav": "wav",
        "audio/vnd.wave": "wav",
        "audio/mpeg": "mp3",
        "audio/mp3": "mp3",
        "audio/mpeg3": "mp3",
        "audio/x-mpeg-3": "mp3",
    }
    if normalized in by_mime:
        return by_mime[normalized]

    sniffed = sniff_format(audio)
    if sniffed:
        return sniffed
    return normalized or "unknown"


def sniff_format(audio: bytes) -> str:
    """Detect a directly supported container from the leading magic bytes."""

    if audio[:4] == b"RIFF" and audio[8:12] == b"WAVE":
        return "wav"
    if audio[:3] == b"ID3" or (len(audio) >= 2 and audio[0] == 0xFF and (audio[1] & 0xE0) == 0xE0):
        return "mp3"
    return ""


def convert_to_wav(audio: bytes) -> bytes:
    """Convert an arbitrary payload to mono 16 kHz WAV using ffmpeg."""

    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise TranscriptionError(
            "This audio format needs conversion to WAV, but ffmpeg was not found on PATH. "
            "Install ffmpeg to enable voice transcription."
        )

    with tempfile.TemporaryDirectory(prefix="folksum-voice-") as directory:
        root = Path(directory)
        source = root / "source"
        target = root / "converted.wav"
        source.write_bytes(audio)
        source.chmod(0o600)
        try:
            completed = subprocess.run(  # noqa: S603 - the executable is resolved from PATH.
                [
                    ffmpeg,
                    "-nostdin",
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-i",
                    str(source),
                    "-vn",
                    "-map",
                    "0:a:0",
                    "-ac",
                    "1",
                    "-ar",
                    CONVERSION_SAMPLE_RATE,
                    "-f",
                    "wav",
                    str(target),
                ],
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=CONVERSION_TIMEOUT_SECONDS,
                check=False,
            )
        except subprocess.TimeoutExpired as error:
            raise TranscriptionError("Audio conversion timed out.") from error

        if completed.returncode != 0 or not target.exists():
            detail = completed.stderr.decode("utf8", "replace").strip().splitlines()
            reason = detail[-1] if detail else f"ffmpeg exited with code {completed.returncode}"
            raise TranscriptionError(f"Audio conversion failed: {reason}")

        converted = target.read_bytes()

    if not converted:
        raise TranscriptionError("Audio conversion produced an empty file.")
    if len(converted) > MAXIMUM_AUDIO_BYTES:
        raise TranscriptionError("The converted audio is larger than the 25 MB transcription limit.")
    return converted


def build_request_body(*, model: str, audio: bytes, audio_format: str, language: str) -> dict[str, object]:
    instruction = "Transcribe this audio recording."
    if language:
        instruction = f"Transcribe this audio recording. The expected language is {language}."
    return {
        "model": model,
        "modalities": ["text"],
        "temperature": 0,
        "messages": [
            {"role": "system", "content": SYSTEM_INSTRUCTION},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": instruction},
                    {
                        "type": "input_audio",
                        "input_audio": {
                            "data": base64.b64encode(audio).decode("ascii"),
                            "format": audio_format,
                        },
                    },
                ],
            },
        ],
    }


def post_json(endpoint: str, body: dict[str, object], api_key: str, timeout: float) -> dict[str, object]:
    request = urllib.request.Request(
        endpoint,
        data=json.dumps(body).encode("utf8"),
        method="POST",
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "folksum-voice/1",
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:  # noqa: S310 - HTTPS is enforced above.
            raw = response.read(MAXIMUM_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        detail = error.read(MAXIMUM_RESPONSE_BYTES).decode("utf8", "replace")
        raise TranscriptionError(
            f"The transcription endpoint returned HTTP {error.code}: {summarize_error(detail)}"
        ) from error
    except urllib.error.URLError as error:
        raise TranscriptionError(f"Could not reach the transcription endpoint: {error.reason}") from error
    except TimeoutError as error:
        raise TranscriptionError("The transcription request timed out.") from error

    if len(raw) > MAXIMUM_RESPONSE_BYTES:
        raise TranscriptionError("The transcription response was too large.")
    try:
        parsed = json.loads(raw.decode("utf8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise TranscriptionError("The transcription endpoint returned a malformed response.") from error
    if not isinstance(parsed, dict):
        raise TranscriptionError("The transcription endpoint returned an unexpected response shape.")
    return parsed


def extract_text(response: dict[str, object]) -> str:
    error = response.get("error")
    if isinstance(error, dict):
        raise TranscriptionError(f"The transcription model reported an error: {summarize_error(error.get('message'))}")
    if isinstance(error, str) and error.strip():
        raise TranscriptionError(f"The transcription model reported an error: {summarize_error(error)}")

    choices = response.get("choices")
    if not isinstance(choices, list) or not choices:
        raise TranscriptionError("The transcription response contained no choices.")
    first = choices[0]
    if not isinstance(first, dict):
        raise TranscriptionError("The transcription response contained an unexpected choice.")
    message = first.get("message")
    if not isinstance(message, dict):
        raise TranscriptionError("The transcription response contained no message.")

    content = message.get("content")
    if isinstance(content, str):
        return clean_transcript(content)
    if isinstance(content, list):
        parts = [part.get("text", "") for part in content if isinstance(part, dict) and part.get("type") == "text"]
        return clean_transcript("".join(piece for piece in parts if isinstance(piece, str)))
    raise TranscriptionError("The transcription response contained no textual content.")


def clean_transcript(value: str) -> str:
    text = value.strip()
    fenced = re.fullmatch(r"```(?:[A-Za-z0-9_-]*)\n(.*?)\n?```", text, re.DOTALL)
    if fenced:
        text = fenced.group(1).strip()
    return re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", text)


def summarize_error(value: object, limit: int = 300) -> str:
    text = re.sub(r"\s+", " ", str(value if value is not None else "")).strip()
    if not text:
        return "no detail was provided"
    return text if len(text) <= limit else f"{text[:limit]}…"


def redact(message: str, api_key: str) -> str:
    if api_key and api_key in message:
        return message.replace(api_key, "[redacted]")
    return message


def read_stdin() -> bytes:
    buffer = getattr(sys.stdin, "buffer", None)
    if buffer is None:
        raise TranscriptionError("Standard input is not available for binary audio.")
    return buffer.read(MAXIMUM_AUDIO_BYTES + 1)


def write_result(result: dict[str, object]) -> None:
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    sys.stdout.write("\n")
    sys.stdout.flush()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
