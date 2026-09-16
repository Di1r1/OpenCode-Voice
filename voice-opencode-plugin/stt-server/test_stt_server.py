#!/usr/bin/env python3
"""
Тесты STT сервера OpenCode Voice.

Запуск:
    # сервер уже запущен на :8765
    python3 test_stt_server.py
    # или свой порт:
    python3 test_stt_server.py --port 8770

Проверяет все маршруты:
    GET  /health
    POST /transcribe
    POST /record/start
    GET  /record/status
    POST /record/stop
+ граничные случаи (stop без start, двойной start).
"""

import argparse
import io
import sys
import time
import wave

import requests

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"
SKIP = "\033[93mSKIP\033[0m"

results = {"pass": 0, "fail": 0, "skip": 0}


def check(name, ok, detail=""):
    if ok:
        results["pass"] += 1
        print(f"  [{PASS}] {name}" + (f"  ({detail})" if detail else ""))
    else:
        results["fail"] += 1
        print(f"  [{FAIL}] {name}" + (f"  ({detail})" if detail else ""))
    return ok


def skip(name, detail=""):
    results["skip"] += 1
    print(f"  [{SKIP}] {name}" + (f"  ({detail})" if detail else ""))


def make_wav(seconds=1.0, rate=16000, freq=0):
    """Сгенерировать WAV (тишина или тон)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(int(rate * seconds)):
            import math
            val = int(3000 * math.sin(2 * math.pi * freq * i / rate)) if freq else 0
            frames += val.to_bytes(2, "little", signed=True)
        w.writeframes(bytes(frames))
    buf.seek(0)
    return buf


# ---------------------------------------------------------------------------

def test_health(base):
    print("\n[ health ]")
    r = requests.get(f"{base}/health", timeout=10)
    check("GET /health -> 200", r.status_code == 200, f"HTTP {r.status_code}")
    if r.status_code == 200:
        j = r.json()
        check("health.status == ok", j.get("status") == "ok")
        check("health.model задан", bool(j.get("model")), str(j.get("model")))
        check("health.recorder задан", bool(j.get("recorder")), str(j.get("recorder")))
        print(f"        recorder={j.get('recorder')} pulse={j.get('pulse_server')}")
        return j
    return {}


def test_transcribe(base, wav_path=None):
    print("\n[ transcribe ]")
    if wav_path:
        with open(wav_path, "rb") as f:
            data = f.read()
    else:
        data = make_wav(1.0).read()

    r = requests.post(
        f"{base}/transcribe",
        files={"audio": ("test.wav", data, "audio/wav")},
        timeout=120,
    )
    check("POST /transcribe -> 200", r.status_code == 200, f"HTTP {r.status_code}")
    if r.status_code == 200:
        j = r.json()
        check("ответ содержит 'text'", "text" in j)
        check("ответ содержит 'language'", "language" in j)
        print(f"        text={j.get('text')!r} lang={j.get('language')}")
    else:
        print(f"        body: {r.text[:200]}")

    # Без файла -> 400
    r2 = requests.post(f"{base}/transcribe", timeout=10)
    check("POST /transcribe без файла -> 400", r2.status_code == 400, f"HTTP {r2.status_code}")


def test_record_missing_stop(base):
    print("\n[ record: stop без start ]")
    r = requests.post(f"{base}/record/stop", timeout=10)
    check("POST /record/stop без start -> 409", r.status_code == 409, f"HTTP {r.status_code}")


def test_record_cycle(base):
    print("\n[ record: полный цикл ]")
    r = requests.post(f"{base}/record/start", timeout=15)
    if r.status_code != 200:
        skip("Запись недоступна (микрофон/PulseAudio)", f"HTTP {r.status_code}: {r.text[:120]}")
        return False

    check("POST /record/start -> 200", True)

    # Двойной старт -> 409
    r2 = requests.post(f"{base}/record/start", timeout=10)
    check("повторный /record/start -> 409", r2.status_code == 409, f"HTTP {r2.status_code}")

    time.sleep(2)

    r3 = requests.get(f"{base}/record/status", timeout=10)
    ok = r3.status_code == 200 and r3.json().get("recording") is True
    check("GET /record/status -> recording=true", ok, r3.text[:100])
    if ok:
        print(f"        seconds={r3.json().get('seconds')}")

    r4 = requests.post(f"{base}/record/stop", timeout=180)
    check("POST /record/stop -> 200", r4.status_code == 200, f"HTTP {r4.status_code}")
    if r4.status_code == 200:
        j = r4.json()
        check("stop вернул 'text'", "text" in j)
        print(f"        text={j.get('text')!r}")

    # После стопа — уже не пишет
    r5 = requests.post(f"{base}/record/stop", timeout=10)
    check("повторный /record/stop -> 409", r5.status_code == 409, f"HTTP {r5.status_code}")
    return True


# ---------------------------------------------------------------------------

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--wav", default="/tmp/test-voice.wav", help="реальный WAV для transcribe")
    args = ap.parse_args()

    base = f"http://{args.host}:{args.port}"
    print(f"Тестирую STT сервер: {base}")

    # Доступность
    try:
        requests.get(f"{base}/health", timeout=5)
    except Exception as e:
        print(f"\n{FAIL} Сервер недоступен: {e}")
        sys.exit(2)

    import os
    wav = args.wav if os.path.exists(args.wav) else None
    if wav:
        print(f"Использую реальный WAV: {wav}")
    else:
        print("Реальный WAV не найден, генерирую тишину")

    test_health(base)
    test_transcribe(base, wav)
    test_record_missing_stop(base)
    test_record_cycle(base)

    print("\n" + "=" * 50)
    print(f"Итог: {results['pass']} pass, {results['fail']} fail, {results['skip']} skip")
    sys.exit(1 if results["fail"] else 0)


if __name__ == "__main__":
    main()
