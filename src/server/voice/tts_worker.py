"""Keeps the Voder voice loaded and turns one line of text into one WAV file per request.

Reads JSON lines on stdin: {"id": 1, "text": "...", "out": "file.wav", "pitch": 104, "rate": 1.0,
"expression": 0.6, "mode": "clear", "lexicon": {"tayne": "T EY N"}}
Writes JSON lines on stdout: {"id": 1, "duration": 1.2} or {"id": 1, "error": "..."}.
"""
import json
import sys


def main():
    voder_path = sys.argv[1] if len(sys.argv) > 1 else None
    if voder_path:
        sys.path.insert(0, voder_path)
    from voder.engine import Voice, synthesize  # noqa: E402

    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            voice = Voice(
                float(request.get("pitch", 104)),
                float(request.get("rate", 1.0)),
                float(request.get("expression", 0.6)),
                float(request.get("breath", 0.02)),
                int(request.get("sampleRate", 22050)),
                int(request.get("seed", 1939)),
                request.get("mode", "clear"),
            )
            utterance = synthesize(request["text"], voice, pronunciations=request.get("lexicon") or None)
            utterance.save(request["out"])
            print(json.dumps({"id": request.get("id"), "duration": utterance.duration}), flush=True)
        except Exception as exc:  # one bad sentence must not stop the voice
            print(json.dumps({"id": request.get("id"), "error": str(exc)}), flush=True)


if __name__ == "__main__":
    main()
