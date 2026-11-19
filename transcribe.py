"""Create locally generated WebVTT captions with faster-whisper."""
import os
import sys
import json
import time
import wave
from pathlib import Path


def timestamp(seconds):
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, millis = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{whole_seconds:02}.{millis:03}"


def main():
    if len(sys.argv) < 4:
        raise RuntimeError("Usage: transcribe.py input.wav output.vtt language-mode [source-language]")
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise RuntimeError("Install caption support in the VS Code terminal with: pip install -r requirements.txt") from error

    audio_path, output_path = map(Path, sys.argv[1:3])
    language_mode = sys.argv[3]
    source_language = "en" if language_mode == "english" else (sys.argv[4] if len(sys.argv) > 4 and sys.argv[4] != "auto" else None)
    # Multilingual models keep processing local; accuracy can be selected by the user.
    def report(**data):
        print(json.dumps(data), flush=True)

    model_name = sys.argv[5] if len(sys.argv) > 5 and sys.argv[5] in {"tiny", "base", "small"} else os.environ.get("HIGHLIGHTCLIPS_WHISPER_MODEL", "base")
    report(stage="loading", model=model_name, percent=0, remainingSeconds={"tiny":30,"base":60,"small":120}[model_name])
    model = WhisperModel(model_name, device="cpu", compute_type="int8")
    with wave.open(str(audio_path), "rb") as audio:
        duration = audio.getnframes() / audio.getframerate()
    started = time.monotonic()
    last_report = 0.0
    report(stage="transcribing", percent=0, remainingSeconds=round(duration * 0.8), model=model_name)
    task = "translate" if language_mode == "translated" else "transcribe"
    segments, info = model.transcribe(str(audio_path), beam_size=1, vad_filter=True, condition_on_previous_text=False, task=task, language=source_language)
    report(stage="transcribing", percent=0, remainingSeconds=round(duration * 0.8), model=model_name, detectedLanguage=info.language, languageProbability=round(info.language_probability, 3))
    cues = []
    for segment in segments:
        text = segment.text.strip()
        if text and segment.end > segment.start:
            cues.append(f"{timestamp(segment.start)} --> {timestamp(segment.end)}\n{text}")
        now = time.monotonic()
        fraction = min(0.99, max(0.0, segment.end / duration)) if duration else 0.0
        if now - last_report >= 1.5:
            elapsed = now - started
            remaining = round(max(0, elapsed * (1 - fraction) / fraction)) if fraction > 0.01 else None
            report(stage="transcribing", percent=round(fraction * 100), remainingSeconds=remaining, model=model_name)
            last_report = now
    output_path.write_text("WEBVTT\n\n" + "\n\n".join(cues) + ("\n" if cues else ""), encoding="utf-8")
    if not cues:
        raise RuntimeError("No speech was detected in this video.")
    report(stage="complete", percent=100, remainingSeconds=0, model=model_name, detectedLanguage=info.language, languageProbability=round(info.language_probability, 3))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
