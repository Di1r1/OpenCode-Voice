#!/usr/bin/env python3
"""
OpenCode Voice STT Server
Flask + faster-whisper for local speech-to-text.

Recording is done SERVER-SIDE via WSL PulseAudio (arecord/ffmpeg) because
the Windows browser cannot see the WSL microphone. This mirrors /voice behaviour.

Run:
    export PULSE_SERVER=/mnt/wslg/PulseServer
    python3 stt_server.py
"""

import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import logging
from pathlib import Path
from flask import Flask, request, jsonify
from faster_whisper import WhisperModel

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)


@app.after_request
def _cors(resp):
    # Разрешаем запросы из OpenCode Web UI (другой порт = другой origin)
    resp.headers["Access-Control-Allow-Origin"] = "*"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


# Auto-detect WSLg PulseAudio socket (needed for server-side recording)
if not os.getenv("PULSE_SERVER") and os.path.exists("/mnt/wslg/PulseServer"):
    os.environ["PULSE_SERVER"] = "unix:/mnt/wslg/PulseServer"

# Model will be loaded in main()
model = None
MODEL_SIZE = "small"
DEVICE = "cpu"
COMPUTE_TYPE = "int8"

# Подсказка для пунктуации/контекста (bias для Whisper)
INITIAL_PROMPT = os.getenv(
    "WHISPER_INITIAL_PROMPT",
    "Расшифровка русской речи. Пиши с заглавных букв и знаками препинания.",
)
LANGUAGE = os.getenv("OPENCODE_VOICE_LANGUAGE", "") or None  # "" → авто

# Качество авто-определения языка (используется только когда LANGUAGE is None).
# Больше сегментов → точнее, но чуть медленнее; threshold отсекает неуверенные.
LANG_DETECT_SEGMENTS = int(os.getenv("WHISPER_LANG_DETECT_SEGMENTS", "3"))
LANG_DETECT_THRESHOLD = float(os.getenv("WHISPER_LANG_DETECT_THRESHOLD", "0.6"))

# Скорость распознавания: beam_size=1 (greedy) заметно быстрее beam=5.
BEAM_SIZE = int(os.getenv("WHISPER_BEAM_SIZE", "1"))
VAD_FILTER = os.getenv("WHISPER_VAD", "1").lower() not in ("0", "false", "no", "off", "")

# Recording state
_rec_lock = threading.Lock()
_rec_proc = None
_rec_file = None
_rec_start = 0.0
_rec_timer = None

SAMPLE_RATE = 16000
CHANNELS = 1
MAX_SECONDS = int(os.getenv("OPENCODE_VOICE_MAX_SECONDS", "120"))
# Сколько ждать реальных данных от рекордера при старте (заголовок WAV пишется
# сразу, поэтому одного роста файла недостаточно — см. _wait_for_audio).
START_AUDIO_TIMEOUT = float(os.getenv("OPENCODE_VOICE_START_AUDIO_TIMEOUT", "2.5"))
MIN_AUDIO_BYTES = 4000

# Авто-восстановление аудиоканала WSLg при «молчащем» источнике (мёртвый
# канал audin / зависший PulseAudio). Перезапускает weston+pulseaudio через
# interop; GUI WSLg при этом перезапускается. Отключается:
#   OPENCODE_VOICE_AUTO_RECOVER=0
AUTO_RECOVER = os.getenv("OPENCODE_VOICE_AUTO_RECOVER", "1").lower() not in (
    "0", "false", "no", "off", "",
)
RECOVER_COOLDOWN = float(os.getenv("OPENCODE_VOICE_AUTO_RECOVER_COOLDOWN", "90"))
WSL_EXE = os.getenv("WSL_EXE", "/mnt/c/Windows/System32/wsl.exe")
_last_recover = 0.0

# Test mode: use a fixture WAV instead of a real microphone.
# Позволяет проверить весь пайплайн без аудиоустройства.
FAKE_AUDIO = os.getenv("OPENCODE_VOICE_FAKE_AUDIO", "")
_FAKE = object()  # sentinel for "recording" in fake mode


def load_model(size, device, compute_type):
    global model, MODEL_SIZE, DEVICE, COMPUTE_TYPE
    MODEL_SIZE = size
    DEVICE = device
    COMPUTE_TYPE = compute_type
    logger.info(f"Loading faster-whisper model: {MODEL_SIZE} on {DEVICE} ({COMPUTE_TYPE})")
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    logger.info("Model loaded successfully")


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------

def transcribe_file(path: str) -> dict:
    segments, info = model.transcribe(
        path,
        language=LANGUAGE,          # None → авто, либо ru/en из env
        beam_size=BEAM_SIZE,
        vad_filter=VAD_FILTER,
        vad_parameters=dict(min_silence_duration_ms=300),
        initial_prompt=INITIAL_PROMPT,
        condition_on_previous_text=False,
        temperature=0.0,
        language_detection_segments=LANG_DETECT_SEGMENTS,
        language_detection_threshold=LANG_DETECT_THRESHOLD,
    )
    text = " ".join(seg.text for seg in segments).strip()
    logger.info(f"Transcribed ({info.language}, {info.language_probability:.2f}): {text[:120]}")
    return {"text": text, "language": info.language, "language_probability": info.language_probability}


# ---------------------------------------------------------------------------
# Server-side recording (WSL PulseAudio)
# ---------------------------------------------------------------------------

def _record_cmd(out_path: str):
    """Pick a recording backend available in this environment."""
    if shutil.which("arecord"):
        return ["arecord", "-D", "pulse", "-f", "cd",
                "-r", str(SAMPLE_RATE), "-c", str(CHANNELS),
                "-t", "wav", "-d", str(MAX_SECONDS), out_path]
    if shutil.which("ffmpeg"):
        return ["ffmpeg", "-y", "-f", "pulse", "-ar", str(SAMPLE_RATE),
                "-ac", str(CHANNELS), "-t", str(MAX_SECONDS), out_path]
    if shutil.which("sox"):
        return ["sox", "-r", str(SAMPLE_RATE), "-c", str(CHANNELS),
                "-t", "wav", out_path, "trim", "0", str(MAX_SECONDS)]
    return None


def _record_probe_cmd():
    """Return which recorder would be used (without a real output path)."""
    if shutil.which("arecord"):
        return "arecord"
    if shutil.which("ffmpeg"):
        return "ffmpeg"
    if shutil.which("sox"):
        return "sox"
    return None


def _friendly_rec_error(raw: str) -> str:
    """Преобразовать сырую ошибку рекордера в понятную подсказку."""
    low = raw.lower()
    if "connection refused" in low or "unable to connect" in low:
        return (
            "Нет доступа к микрофону: PulseAudio не отвечает. "
            "WSLg передаёт звук через канал audin — похоже, он отвалился. "
            "Проверь доступ приложения к микрофону в Windows "
            "(Параметры → Конфиденциальность → Микрофон); в RDP-сессии включи "
            "«Запись с этого компьютера». Если не помогло — перезапусти WSL: "
            "wsl --shutdown. "
            "Проверка: arecord -D pulse -f cd -d 2 /tmp/t.wav"
        )
    if "no such file" in low or "cannot open" in low:
        return "Рекордер не может открыть устройство. Проверь PULSE_SERVER и наличие источника."
    return raw


def _kill_recorder(proc):
    """Жёстко завершить процесс рекордера (вместе с группой)."""
    if proc is None or proc is _FAKE:
        return
    try:
        if proc.poll() is None:
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
            except Exception:
                proc.kill()
        try:
            proc.wait(timeout=2)
        except Exception:
            pass
    except Exception:
        pass


def _wait_for_audio(path: str, proc, timeout: float):
    """Дождаться, пока рекордер реально начнёт писать звук.

    arecord/ffmpeg создают WAV-заголовок сразу, даже если данные не идут,
    поэтому проверки «файл существует и не пустой» недостаточно. Ждём, пока
    размер превысит MIN_AUDIO_BYTES, либо истечения timeout. Возвращает
    (ok, last_size).
    """
    deadline = time.time() + max(0.0, timeout)
    size = 0
    while True:
        if proc.poll() is not None:
            return False, size
        try:
            size = os.path.getsize(path)
        except OSError:
            size = 0
        if size >= MIN_AUDIO_BYTES:
            return True, size
        if time.time() >= deadline:
            return False, size
        time.sleep(0.1)


def _cancel_watchdog():
    global _rec_timer
    if _rec_timer is not None:
        _rec_timer.cancel()
        _rec_timer = None


def _watchdog_fire(expected_proc):
    """Рекордер не завершился сам за отведённое время — убить и сбросить состояние.

    `arecord -d` через pulse-плагин ALSA ненадёжен и может быть проигнорирован,
    поэтому длительность записи страхуется таймером на стороне сервера.
    """
    global _rec_proc, _rec_file, _rec_timer
    with _rec_lock:
        if _rec_proc is None or _rec_proc is not expected_proc:
            return
        logger.warning(
            "Watchdog: запись превысила лимит %ss — останавливаю принудительно",
            MAX_SECONDS + 5,
        )
        proc = _rec_proc
        path = _rec_file
        _rec_proc = None
        _rec_file = None
        _rec_timer = None
    _kill_recorder(proc)
    if path and os.path.exists(path):
        try:
            os.unlink(path)
        except Exception:
            pass


def _arm_watchdog(proc):
    global _rec_timer
    _cancel_watchdog()
    _rec_timer = threading.Timer(MAX_SECONDS + 5, _watchdog_fire, args=(proc,))
    _rec_timer.daemon = True
    _rec_timer.start()


def _wslg_restart():
    """Пересоздать аудиоканал WSLg: перезапустить weston и pulseaudio.

    Делается через interop в системном дистрибутиве WSLg (WSLGd поднимает
    процессы заново). GUI WSLg (Wayland-окна) при этом перезапустится.
    Возвращает True, если команды удалось выполнить (без гарантии, что
    микрофон заработал).
    """
    if not os.path.exists(WSL_EXE):
        logger.warning("Авто-восстановление: не найден %s", WSL_EXE)
        return False
    try:
        subprocess.run(
            [WSL_EXE, "--system", "-e", "sh", "-lc", "pkill -9 -x weston"],
            timeout=30, check=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        time.sleep(float(os.getenv("WSLG_RESTART_WESTON_WAIT", "8")))
        subprocess.run(
            [WSL_EXE, "--system", "-e", "sh", "-lc", "pkill -9 -x pulseaudio"],
            timeout=30, check=False,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        time.sleep(float(os.getenv("WSLG_RESTART_PULSE_WAIT", "5")))
        return True
    except Exception as e:
        logger.warning("Авто-восстановление WSLg не удалось: %s", e)
        return False


def _reap_if_done():
    """Если рекордер уже завершился сам (лимит -d, ошибка) — освободить состояние.

    Вызывается под _rec_lock. Без этого сервер навсегда застревает в
    «recording» и отвечает 409 на все последующие /record/start.
    """
    global _rec_proc, _rec_file
    if _rec_proc is not None and _rec_proc is not _FAKE and _rec_proc.poll() is not None:
        logger.info("Recorder процесс завершился сам — сбрасываю состояние записи")
        try:
            _rec_proc.wait(timeout=2)  # reap zombie
        except Exception:
            pass
        if _rec_file and os.path.exists(_rec_file):
            try:
                os.unlink(_rec_file)
            except Exception:
                pass
        _rec_proc = None
        _rec_file = None
        _cancel_watchdog()
        return True
    return False


@app.route("/record/start", methods=["POST"])
def record_start():
    global _rec_proc, _rec_file, _rec_start, _last_recover
    with _rec_lock:
        _reap_if_done()
        if _rec_proc is not None:
            return jsonify({"error": "already recording", "recording": True}), 409

        _rec_start = time.time()

        # Fake-audio test mode: no real microphone needed
        if FAKE_AUDIO:
            if not os.path.exists(FAKE_AUDIO):
                return jsonify({"error": f"FAKE_AUDIO not found: {FAKE_AUDIO}"}), 500
            _rec_proc = _FAKE
            logger.info(f"[fake] Recording started (fixture: {FAKE_AUDIO})")
            return jsonify({"status": "recording", "fake": True, "since": _rec_start})

        last_size = 0
        for attempt in range(2):
            _rec_file = tempfile.mktemp(suffix=".wav")
            cmd = _record_cmd(_rec_file)
            if cmd is None:
                _rec_file = None
                return jsonify({"error": "no recorder (arecord/ffmpeg/sox) found"}), 500

            logger.info(f"Recording -> {' '.join(cmd)}")

            try:
                _rec_proc = subprocess.Popen(
                    cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                    preexec_fn=os.setsid,
                )
            except Exception as e:
                _rec_proc = None
                _rec_file = None
                return jsonify({"error": str(e)}), 500

            # Дожидаемся реальных данных, а не только WAV-заголовка. Если рекордер
            # подключился, но звук не идёт (мёртвый канал audin / зависший
            # PulseAudio) — один раз пробуем пересоздать аудиоканал и повторить.
            ok, last_size = _wait_for_audio(_rec_file, _rec_proc, START_AUDIO_TIMEOUT)
            if ok:
                _arm_watchdog(_rec_proc)
                return jsonify({"status": "recording", "since": _rec_start})

            died = _rec_proc.poll() is not None
            raw = ""
            if died:
                try:
                    raw = (_rec_proc.stderr.read() or b"").decode("utf-8", "replace").strip()
                except Exception:
                    pass

            can_recover = (
                attempt == 0
                and AUTO_RECOVER
                and not died
                and not raw
                and (time.time() - _last_recover) >= RECOVER_COOLDOWN
            )
            _kill_recorder(_rec_proc)
            _rec_proc = None
            _rec_file = None

            if can_recover:
                logger.warning(
                    "Аудиоисточник молчит — пересоздаю WSLg-аудиоканал "
                    "(weston+pulseaudio) и повторяю попытку"
                )
                _last_recover = time.time()
                if _wslg_restart():
                    continue

            if raw:
                msg = _friendly_rec_error(raw)
            elif died:
                msg = (
                    "Микрофон недоступен (PulseAudio не отвечает). "
                    "Проверь PULSE_SERVER=/mnt/wslg/PulseServer и что WSLg-аудио активно."
                )
            else:
                msg = (
                    "Аудиоисточник молчит: рекордер подключился, но данных нет "
                    f"(получено {last_size} байт). WSLg передаёт микрофон через канал "
                    "audin — похоже, он отвалился. Проверь доступ приложения к "
                    "микрофону в Windows (Параметры → Конфиденциальность → "
                    "Микрофон); в RDP-сессии включи «Запись с этого компьютера». "
                    "Если не помогло — перезапусти WSL: wsl --shutdown. "
                    "Проверка: arecord -D pulse -f cd -d 2 /tmp/t.wav"
                )
            logger.error(f"Recorder failed: {msg}")
            return jsonify({"error": msg}), 500

    return jsonify({"error": "recorder failed"}), 500


@app.route("/record/status", methods=["GET"])
def record_status():
    with _rec_lock:
        _reap_if_done()
        if _rec_proc is None:
            return jsonify({"recording": False})
        return jsonify({"recording": True, "seconds": round(time.time() - _rec_start, 1)})


@app.route("/record/stop", methods=["POST"])
def record_stop():
    global _rec_proc, _rec_file, _rec_start
    with _rec_lock:
        if _rec_proc is None:
            return jsonify({"error": "not recording"}), 409

        proc = _rec_proc
        path = _rec_file
        _rec_proc = None
        _rec_file = None
        _cancel_watchdog()

        # Fake-audio test mode: copy the fixture, skip the real process
        if proc is _FAKE:
            path = tempfile.mktemp(suffix=".wav")
            shutil.copyfile(FAKE_AUDIO, path)
            logger.info(f"[fake] Recording stopped, using fixture -> {path}")
        elif proc.poll() is not None:
            # Рекордер уже завершился сам — просто забираем его файл
            logger.info("Recorder завершился сам; транскрибирую оставшийся файл")
        else:
            # Stop the recorder gracefully so the WAV header is finalized
            try:
                os.killpg(os.getpgid(proc.pid), signal.SIGINT)
            except Exception:
                proc.terminate()
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(os.getpgid(proc.pid), signal.SIGKILL)
                except Exception:
                    proc.kill()

    if not path or not os.path.exists(path):
        return jsonify({"error": "recording file missing"}), 500

    size = os.path.getsize(path)
    logger.info(f"Recording stopped: {path} ({size} bytes)")
    if size < 2000:
        try:
            os.unlink(path)
        except Exception:
            pass
        return jsonify({"text": "", "warning": "recording too short"})

    try:
        result = transcribe_file(path)
        return jsonify(result)
    except Exception as e:
        logger.exception("Transcription failed")
        return jsonify({"error": str(e)}), 500
    finally:
        try:
            os.unlink(path)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "model": MODEL_SIZE,
        "device": DEVICE,
        "recorder": _record_probe_cmd(),
        "pulse_server": os.getenv("PULSE_SERVER", ""),
        "fake_audio": FAKE_AUDIO or None,
    })


@app.route("/transcribe", methods=["POST"])
def transcribe():
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]
    if audio_file.filename == "":
        return jsonify({"error": "Empty filename"}), 400

    suffix = Path(audio_file.filename).suffix or ".webm"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name

    try:
        return jsonify(transcribe_file(tmp_path))
    except Exception as e:
        logger.exception("Transcription failed")
        return jsonify({"error": str(e)}), 500
    finally:
        try:
            os.unlink(tmp_path)
        except Exception:
            pass


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="OpenCode Voice STT Server")
    parser.add_argument("--host", default="0.0.0.0", help="Host to bind")
    parser.add_argument("--port", type=int, default=8765, help="Port to bind")
    parser.add_argument("--model", default="base", help="Whisper model size (tiny, base, small, medium, large)")
    parser.add_argument("--device", default="cpu", help="Device (cpu, cuda)")
    parser.add_argument("--compute-type", default="int8", help="Compute type (int8, float16, float32)")
    args = parser.parse_args()

    # Убрать зависшие рекордеры прошлых запусков (держат микрофон)
    for pat in ("voice-ptt-", "arecord -D pulse", "ffmpeg -y -f alsa"):
        try:
            subprocess.run(["pkill", "-9", "-f", pat], check=False)
        except Exception:
            pass

    load_model(args.model, args.device, args.compute_type)

    logger.info(f"Starting server on {args.host}:{args.port}")
    logger.info(f"PULSE_SERVER={os.getenv('PULSE_SERVER', '(not set)')}")
    logger.info(
        f"Language: {LANGUAGE or 'auto'} "
        f"(detect segments={LANG_DETECT_SEGMENTS}, threshold={LANG_DETECT_THRESHOLD})"
    )
    logger.info(f"STT: model={MODEL_SIZE} beam={BEAM_SIZE} vad={VAD_FILTER}")
    app.run(host=args.host, port=args.port, threaded=True)
