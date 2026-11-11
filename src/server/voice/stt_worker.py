"""Keeps a speech recognition model loaded and turns one sound file into text per request.

Reads JSON lines on stdin: {"id": 1, "path": "clip.webm", "language": "en", "prompt": "Celery Man, Tayne"}
Writes JSON lines on stdout: {"id": 1, "text": "..."} or {"id": 1, "error": "..."}.
Arguments: model name, device, compute type.
"""
import json
import sys
import wave


def read_wav(path):
    """The app hands over 16 kHz mono 16-bit WAV files, so no extra audio library is needed."""
    import numpy as np

    with wave.open(path, "rb") as audio:
        frames = audio.readframes(audio.getnframes())
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def main():
    model_name = sys.argv[1] if len(sys.argv) > 1 else "large-v3"
    device = sys.argv[2] if len(sys.argv) > 2 else "cuda"
    compute_type = sys.argv[3] if len(sys.argv) > 3 else "int8_float16"
    try:
        import torch  # noqa: F401  (on Windows this makes the graphics card libraries findable)
    except Exception:
        pass
    from faster_whisper import WhisperModel

    try:
        model = WhisperModel(model_name, device=device, compute_type=compute_type)
    except Exception as exc:  # no graphics card available: fall back to the processor
        if device == "cpu":
            raise
        print(f"falling back to cpu: {exc}", file=sys.stderr, flush=True)
        model = WhisperModel(model_name, device="cpu", compute_type="int8")

    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            segments, _info = model.transcribe(
                read_wav(request["path"]),
                language=request.get("language") or None,
                initial_prompt=request.get("prompt") or None,
                beam_size=5,
                vad_filter=True,
                condition_on_previous_text=False,
            )
            text = " ".join(segment.text.strip() for segment in segments).strip()
            print(json.dumps({"id": request.get("id"), "text": text}), flush=True)
        except Exception as exc:
            print(json.dumps({"id": request.get("id"), "error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
