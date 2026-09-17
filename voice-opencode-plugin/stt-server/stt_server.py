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
import re
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import logging
from pathlib import Path
from flask import Flask, request, jsonify

# Configure logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)


# CORS: разрешаем только локальные origin (OpenCode UI, расширение), а не "*".
# Иначе любая веб-страница в браузере могла бы дёргать локальный сервер.
_ALLOWED_ORIGIN = re.compile(
    r"^(https?://(127\.0\.0\.1|localhost|10\.\d+\.\d+\.\d+|"
    r"172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|192\.168\.\d+\.\d+)(:\d+)?"
    r"|chrome-extension://[a-p]{32})$",
    re.IGNORECASE,
)


@app.after_request
def _cors(resp):
    origin = request.headers.get("Origin", "")
    if origin and _ALLOWED_ORIGIN.match(origin):
        resp.headers["Access-Control-Allow-Origin"] = origin
        resp.headers["Vary"] = "Origin"
    resp.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
    resp.headers["Access-Control-Allow-Headers"] = "Content-Type"
    return resp


# Auto-detect WSLg PulseAudio socket (needed for server-side recording)
if not os.getenv("PULSE_SERVER") and os.path.exists("/mnt/wslg/PulseServer"):
    os.environ["PULSE_SERVER"] = "unix:/mnt/wslg/PulseServer"

# Аудио пишем в RAM (tmpfs), а не на диск; удаляем через RETAIN_SECONDS секунд.
TMP_DIR = os.getenv("OPENCODE_VOICE_TMP_DIR", "/dev/shm/opencode-voice")
try:
    RETAIN_SECONDS = float(os.getenv("OPENCODE_VOICE_RETAIN_SECONDS", "300"))
except ValueError:
    RETAIN_SECONDS = 300.0

# Model will be loaded in main()
model = None
MODEL_SIZE = "medium"
DEVICE = "cpu"
COMPUTE_TYPE = "int8"

# Параметры faster-whisper для ленивой загрузки при откате whisper.cpp → CPU.
FT_MODEL = "medium"
FT_DEVICE = "cpu"
FT_COMPUTE = "int8"

# Подсказка для пунктуации/контекста (bias для Whisper). По умолчанию пусто:
# жёсткий русский prompt ухудшал распознавание отдельных слов (проверка → прайберка).
INITIAL_PROMPT = os.getenv("WHISPER_INITIAL_PROMPT", "")
LANGUAGE = os.getenv("OPENCODE_VOICE_LANGUAGE", "") or None  # "" → авто

# Качество авто-определения языка (используется только когда LANGUAGE is None).
# Больше сегментов → точнее, но чуть медленнее; threshold отсекает неуверенные.
LANG_DETECT_SEGMENTS = int(os.getenv("WHISPER_LANG_DETECT_SEGMENTS", "3"))
LANG_DETECT_THRESHOLD = float(os.getenv("WHISPER_LANG_DETECT_THRESHOLD", "0.6"))

# Скорость распознавания: beam_size=1 (greedy) заметно быстрее beam=5.
BEAM_SIZE = int(os.getenv("WHISPER_BEAM_SIZE", "1"))
VAD_FILTER = os.getenv("WHISPER_VAD", "1").lower() not in ("0", "false", "no", "off", "")

# Отладка: если задан каталог — сохранять туда каждый записанный/принятый WAV.
KEEP_AUDIO_DIR = os.getenv("OPENCODE_VOICE_KEEP_AUDIO", "")

# Бэкенд распознавания: "whispercpp" (GPU через whisper.cpp CLI) или
# "faster-whisper" (CPU). Пусто = авто: whispercpp, если найден бинарник и модель.
STT_BACKEND = os.getenv("OPENCODE_VOICE_STT_BACKEND", "").lower()
WHISPER_CPP_BIN = os.getenv(
    "WHISPER_CPP_BIN",
    os.path.expanduser("~/.local/share/opencode-voice/whisper/bin/whisper-cli"),
)
WHISPER_CPP_MODEL = os.getenv(
    "WHISPER_CPP_MODEL",
    os.path.expanduser("~/.local/share/opencode-voice/whisper/ggml-medium.bin"),
)
WHISPER_CPP_LIB_DIR = os.getenv(
    "WHISPER_CPP_LIB_DIR",
    os.path.expanduser("~/.local/share/opencode-voice/whisper/bin"),
)
# Дополнительные каталоги для LD_LIBRARY_PATH (CUDA-рантайм + драйвер WSL).
WHISPER_CPP_EXTRA_LIBS = os.getenv(
    "WHISPER_CPP_EXTRA_LIBS",
    ":".join([os.path.expanduser("~/cuda-12.6/lib64"), "/usr/lib/wsl/lib"]),
)

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
    # Ленивый импорт: в GPU-режиме (whisper.cpp) faster-whisper не обязателен.
    try:
        from faster_whisper import WhisperModel
    except ImportError as e:
        raise RuntimeError(
            "faster-whisper не установлен (pip install faster-whisper). "
            "Для GPU-режима он не нужен — используется whisper.cpp."
        ) from e
    logger.info(f"Loading faster-whisper model: {MODEL_SIZE} on {DEVICE} ({COMPUTE_TYPE})")
    model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
    logger.info("Model loaded successfully")


# ---------------------------------------------------------------------------
# Transcription
# ---------------------------------------------------------------------------

def whispercpp_available() -> bool:
    return os.path.exists(WHISPER_CPP_BIN) and os.path.exists(WHISPER_CPP_MODEL)


def _is_wav(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            head = f.read(12)
        return head[:4] == b"RIFF" and head[8:12] == b"WAVE"
    except Exception:
        return False


def _new_wav_path() -> str:
    """Путь для аудио в RAM-каталоге (tmpfs), а не на диске."""
    try:
        os.makedirs(TMP_DIR, exist_ok=True)
    except Exception:
        pass
    return tempfile.mktemp(suffix=".wav", dir=TMP_DIR)


def _schedule_delete(path: str):
    """Удалить файл через RETAIN_SECONDS (для отладки/тестов файлы живут 5 минут)."""
    if os.getenv("OPENCODE_VOICE_KEEP_AUDIO"):
        return
    if RETAIN_SECONDS <= 0:
        return

    def _rm():
        try:
            if path and os.path.exists(path):
                os.unlink(path)
        except Exception:
            pass

    t = threading.Timer(RETAIN_SECONDS, _rm)
    t.daemon = True
    t.start()


def _purge_old_files():
    """Удалить аудио старше RETAIN_SECONDS (после перезапуска сервера)."""
    try:
        now = time.time()
        for name in os.listdir(TMP_DIR):
            p = os.path.join(TMP_DIR, name)
            if name.startswith("beep-"):
                continue
            try:
                if os.path.isfile(p) and (now - os.path.getmtime(p)) > RETAIN_SECONDS:
                    os.unlink(p)
            except Exception:
                pass
    except Exception:
        pass


def _beep_wav(freq: int, ms: int = 120, rate: int = 44100) -> str:
    """Сгенерировать (и закэшировать) WAV-сигнал в RAM-каталоге."""
    path = os.path.join(TMP_DIR, f"beep-{freq}-{ms}.wav")
    if os.path.exists(path):
        return path
    try:
        import math
        import struct
        import wave

        os.makedirs(TMP_DIR, exist_ok=True)
        n = int(rate * ms / 1000)
        fade = max(1, int(rate * 0.005))
        frames = bytearray()
        for i in range(n):
            env = min(1.0, i / fade, (n - i) / (fade * 2))
            val = int(12000 * math.sin(2 * math.pi * freq * i / rate) * env)
            frames += struct.pack("<h", val)
        with wave.open(path, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(rate)
            w.writeframes(bytes(frames))
    except Exception as e:
        logger.warning(f"beep wav failed: {e}")
    return path


def _play_beep(freq: int = 880, ms: int = 120):
    """Проиграть сигнал через PulseAudio (WSL) — best-effort."""
    try:
        path = _beep_wav(freq, ms)
        if not os.path.exists(path):
            return
        for cmd in (["aplay", "-D", "pulse", "-q", path],
                    ["paplay", path],
                    ["ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path]):
            if shutil.which(cmd[0]):
                try:
                    subprocess.run(cmd, timeout=5, check=False,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                    return
                except Exception:
                    pass
    except Exception:
        pass


def _to_wav(path: str):
    """Конвертация в 16 кГц моно WAV через ffmpeg. Возвращает (путь, временный?)."""
    if _is_wav(path) or not shutil.which("ffmpeg"):
        return path, False
    out = _new_wav_path()
    proc = subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", path,
         "-ar", str(SAMPLE_RATE), "-ac", "1", out],
        capture_output=True, text=True,
    )
    if proc.returncode != 0 or not os.path.exists(out):
        logger.warning(f"ffmpeg convert failed: {(proc.stderr or '').strip()[:200]}")
        return path, False
    _schedule_delete(out)
    return out, True


# Служебные пометки Whisper на музыке/шуме: [музыка], (смех), ♪, *music* и т.п.
_NON_SPEECH = re.compile(
    r"^(музык|music|аплодисмент|applause|смех|laugh|тишин|silence|шум|noise|"
    r"звук|sound|свист|whistl|кашел|кашл|cough|вздох|sigh|шёпот|шепот|whisper|"
    r"неразборчив|inaudible|пауза|paus|гудок|сигнал|signal|звон|ring|стук|knock|"
    r"хлопок|clap|помех|static|инструментал|instrumental|мужской голос|женский голос)",
    re.IGNORECASE,
)


def _strip_non_speech(text: str) -> str:
    """Вырезает служебные пометки ([музыка], (смех), ♪ …) из результата распознавания."""
    t = re.sub(r"\[[^\]]*\]", " ", text)          # [музыка], [Music]
    t = re.sub(r"\*[^*]*\*", " ", t)              # *music*
    t = re.sub(
        r"\(([^)]*)\)",
        lambda m: " " if _NON_SPEECH.match(m.group(1).strip()) else m.group(0),
        t,
    )                                             # (смех), но не (то есть)
    t = re.sub(r"[♪♫♬♩♭♮#]+", " ", t)             # ноты
    t = re.sub(r"\s{2,}", " ", t)
    t = re.sub(r"\s+([,.!?;:])", r"\1", t)
    return t.strip()


def _transcribe_whispercpp(path: str) -> dict:
    lang = LANGUAGE or "auto"
    env = dict(os.environ)
    libs = ":".join(d for d in (WHISPER_CPP_LIB_DIR, WHISPER_CPP_EXTRA_LIBS) if d)
    if env.get("LD_LIBRARY_PATH"):
        libs = f"{libs}:{env['LD_LIBRARY_PATH']}"
    env["LD_LIBRARY_PATH"] = libs
    # whisper.cpp/miniaudio не читает WebM/Opus (это путь браузерного микрофона),
    # поэтому не-WAV вход конвертируем через ffmpeg.
    audio, is_temp = _to_wav(path)
    try:
        cmd = [WHISPER_CPP_BIN, "-m", WHISPER_CPP_MODEL, "-f", audio, "-l", lang, "-nt", "-np"]
        logger.info(f"whisper.cpp -> {' '.join(cmd)}")
        start = time.time()
        proc = subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=180)
        if proc.returncode != 0:
            raise RuntimeError(f"whisper.cpp failed: {(proc.stderr or '').strip()[:300]}")
        text = _strip_non_speech(proc.stdout.strip())
        logger.info(f"Transcribed via whisper.cpp ({lang}, {time.time() - start:.1f}s): {text[:120]}")
        return {"text": text, "language": lang, "language_probability": 1.0}
    finally:
        if is_temp:
            try:
                os.unlink(audio)
            except Exception:
                pass


def transcribe_file(path: str) -> dict:
    if STT_BACKEND == "whispercpp":
        try:
            return _transcribe_whispercpp(path)
        except Exception as e:
            # GPU недоступна / CLI не запустился — автоматический откат на CPU.
            logger.warning(
                "whisper.cpp недоступен (%s) — откат на faster-whisper (CPU)",
                str(e)[:200],
            )
            try:
                _ensure_faster_whisper()
            except Exception as fe:
                # faster-whisper не установлен — не скрываем исходную ошибку GPU.
                logger.error("faster-whisper недоступен для отката: %s", fe)
                raise e
            return _transcribe_faster_whisper(path)
    return _transcribe_faster_whisper(path)


def _cuda_available() -> bool:
    """Есть ли CUDA-драйвер (WSL2 или системный)."""
    return any(os.path.exists(p) for p in (
        "/usr/lib/wsl/lib/libcuda.so.1",
        "/usr/lib/wsl/lib/libcuda.so",
        "/usr/lib/x86_64-linux-gnu/libcuda.so.1",
        "/usr/local/cuda/lib64/libcuda.so.1",
    ))


def _ensure_faster_whisper():
    """Ленивая загрузка CPU-модели (используется при откате с whisper.cpp)."""
    global model
    if model is None:
        load_model(FT_MODEL, FT_DEVICE, FT_COMPUTE)
    return model


def _transcribe_faster_whisper(path: str) -> dict:
    segments, info = model.transcribe(
        path,
        language=LANGUAGE,          # None → авто, либо ru/en из env
        beam_size=BEAM_SIZE,
        vad_filter=VAD_FILTER,
        vad_parameters=dict(min_silence_duration_ms=300),
        initial_prompt=INITIAL_PROMPT or None,
        condition_on_previous_text=False,
        temperature=0.0,
        language_detection_segments=LANG_DETECT_SEGMENTS,
        language_detection_threshold=LANG_DETECT_THRESHOLD,
    )
    text = _strip_non_speech(" ".join(seg.text for seg in segments).strip())
    logger.info(f"Transcribed ({info.language}, {info.language_probability:.2f}): {text[:120]}")
    return {"text": text, "language": info.language, "language_probability": info.language_probability}


# ---------------------------------------------------------------------------
# Server-side recording (WSL PulseAudio)
# ---------------------------------------------------------------------------

def _record_cmd(out_path: str):
    """Pick a recording backend available in this environment."""
    if shutil.which("arecord"):
        return ["arecord", "-D", "pulse", "-f", "S16_LE",
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
    _schedule_delete(path)


def _arm_watchdog(proc):
    global _rec_timer
    _cancel_watchdog()
    _rec_timer = threading.Timer(MAX_SECONDS + 5, _watchdog_fire, args=(proc,))
    _rec_timer.daemon = True
    _rec_timer.start()


def _keep_audio(path, tag="rec"):
    """Отладочно сохранить WAV в KEEP_AUDIO_DIR (если задан)."""
    if not KEEP_AUDIO_DIR or not path or not os.path.exists(path):
        return
    try:
        os.makedirs(KEEP_AUDIO_DIR, exist_ok=True)
        dst = os.path.join(KEEP_AUDIO_DIR, f"{tag}-{time.strftime('%Y%m%d-%H%M%S')}.wav")
        shutil.copyfile(path, dst)
        logger.info(f"kept audio -> {dst}")
    except Exception as e:
        logger.warning(f"keep audio failed: {e}")


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
        # Вернуть default source на микрофон (иначе запись уйдёт в monitor).
        try:
            subprocess.run(
                ["pactl", "set-default-source",
                 os.getenv("OPENCODE_VOICE_SOURCE", "RDPSource")],
                timeout=15, check=False,
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            )
        except Exception:
            pass
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
    _log_request("record/start")
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
            _rec_file = _new_wav_path()
            cmd = _record_cmd(_rec_file)
            if cmd is None:
                _rec_file = None
                return jsonify({"error": "no recorder (arecord/ffmpeg/sox) found"}), 500

            logger.info(f"Recording -> {' '.join(cmd)}")

            try:
                rec_env = dict(os.environ)
                # Явный микрофон: иначе default-source может съехать на RDPSink.monitor
                # после обрыва канала audin, и запись поймает системный звук.
                rec_env["PULSE_SOURCE"] = os.getenv("OPENCODE_VOICE_SOURCE", "RDPSource")
                _rec_proc = subprocess.Popen(
                    cmd, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
                    preexec_fn=os.setsid, env=rec_env,
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
            path = _new_wav_path()
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
    _keep_audio(path, "rec")
    if size < 2000:
        _schedule_delete(path)
        return jsonify({"text": "", "warning": "recording too short"})

    try:
        result = transcribe_file(path)
        return jsonify(result)
    except Exception as e:
        logger.exception("Transcription failed")
        return jsonify({"error": str(e)}), 500
    finally:
        _schedule_delete(path)


# ---------------------------------------------------------------------------
# Misc
# ---------------------------------------------------------------------------

@app.route("/health", methods=["GET"])
def health():
    return jsonify({
        "status": "ok",
        "backend": STT_BACKEND,
        "model": MODEL_SIZE,
        "device": "cuda" if (STT_BACKEND == "whispercpp" and _cuda_available()) else DEVICE,
        "recorder": _record_probe_cmd(),
        "pulse_server": os.getenv("PULSE_SERVER", ""),
        "fake_audio": FAKE_AUDIO or None,
    })


def _log_request(kind: str, extra: str = ""):
    """Диагностика: кто и когда дергает сервер (авто-старт пишет в никуда)."""
    try:
        with open("/tmp/opencode/voice-requests.log", "a") as f:
            ua = (request.headers.get("User-Agent") or "")[:40]
            org = (request.headers.get("Origin") or "")[:40]
            f.write(f"{time.strftime('%H:%M:%S')} {kind} {extra} origin={org} ua={ua}\n")
    except Exception:
        pass


@app.route("/beep", methods=["GET", "POST"])
def beep_route():
    """Проиграть звуковой сигнал из WSL (тот же путь, что у /voice)."""
    try:
        freq = int(request.args.get("freq", "880"))
    except (TypeError, ValueError):
        freq = 880
    _log_request("beep", f"freq={freq}")
    if freq > 0:
        threading.Thread(target=_play_beep, args=(freq,), daemon=True).start()
    return jsonify({"status": "ok", "freq": freq})


@app.route("/transcribe", methods=["POST"])
def transcribe():
    _log_request("transcribe")
    if "audio" not in request.files:
        return jsonify({"error": "No audio file provided"}), 400

    audio_file = request.files["audio"]
    if audio_file.filename == "":
        return jsonify({"error": "Empty filename"}), 400

    suffix = Path(audio_file.filename).suffix or ".webm"
    try:
        os.makedirs(TMP_DIR, exist_ok=True)
    except Exception:
        pass
    with tempfile.NamedTemporaryFile(suffix=suffix, dir=TMP_DIR, delete=False) as tmp:
        audio_file.save(tmp.name)
        tmp_path = tmp.name
    _keep_audio(tmp_path, "upload")

    try:
        return jsonify(transcribe_file(tmp_path))
    except Exception as e:
        logger.exception("Transcription failed")
        return jsonify({"error": str(e)}), 500
    finally:
        _schedule_delete(tmp_path)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="OpenCode Voice STT Server")
    parser.add_argument("--host", default=os.getenv("OPENCODE_VOICE_HOST", "127.0.0.1"),
                        help="Host to bind (default 127.0.0.1; use 0.0.0.0 to expose on the network)")
    parser.add_argument("--port", type=int, default=8765, help="Port to bind")
    parser.add_argument("--model", default="medium", help="Whisper model size (tiny, base, small, medium, large)")
    parser.add_argument("--device", default="cpu", help="Device (cpu, cuda)")
    parser.add_argument("--compute-type", default="int8", help="Compute type (int8, float16, float32)")
    args = parser.parse_args()

    # Убрать зависшие рекордеры прошлых запусков (держат микрофон)
    for pat in ("voice-ptt-", "arecord -D pulse", "ffmpeg -y -f alsa"):
        try:
            subprocess.run(["pkill", "-9", "-f", pat], check=False)
        except Exception:
            pass

    if not STT_BACKEND:
        STT_BACKEND = "whispercpp" if whispercpp_available() else "faster-whisper"

    # OPENCODE_VOICE_DEVICE=cpu — принудительно CPU (faster-whisper).
    if os.getenv("OPENCODE_VOICE_DEVICE", "").lower() == "cpu":
        STT_BACKEND = "faster-whisper"

    # CPU-параметры для ленивого отката whisper.cpp → faster-whisper.
    FT_MODEL = args.model
    FT_DEVICE = args.device
    FT_COMPUTE = args.compute_type

    if STT_BACKEND == "whispercpp":
        MODEL_SIZE = os.path.basename(WHISPER_CPP_MODEL)
        cuda = "CUDA" if _cuda_available() else "CPU"
        logger.info(f"STT backend: whisper.cpp ({cuda}), model={WHISPER_CPP_MODEL}")
        logger.info(f"CPU fallback: faster-whisper {FT_MODEL} ({FT_DEVICE}/{FT_COMPUTE})")
    else:
        load_model(args.model, args.device, args.compute_type)
        logger.info(f"STT backend: faster-whisper ({args.device}/{args.compute_type})")

    logger.info(f"Starting server on {args.host}:{args.port}")
    logger.info(f"PULSE_SERVER={os.getenv('PULSE_SERVER', '(not set)')}")
    logger.info(
        f"Language: {LANGUAGE or 'auto'} "
        f"(detect segments={LANG_DETECT_SEGMENTS}, threshold={LANG_DETECT_THRESHOLD})"
    )
    logger.info(f"STT: model={MODEL_SIZE} beam={BEAM_SIZE} vad={VAD_FILTER}")
    _purge_old_files()
    app.run(host=args.host, port=args.port, threaded=True)
