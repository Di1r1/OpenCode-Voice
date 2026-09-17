"""Hermetic pytest suite for the STT server (no microphone, no model download).

The server module is loaded directly (not via HTTP), so nothing binds a port and
transcription is monkeypatched. faster-whisper is imported lazily by the server,
so it is not required here.

Run:
    cd voice-opencode-plugin && pytest
"""

import importlib.util
import io
import math
import wave
from pathlib import Path

import pytest

SERVER_DIR = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location("stt_server", SERVER_DIR / "stt_server.py")
srv = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(srv)


def make_wav(seconds=0.3, rate=16000, freq=0):
    """Return an in-memory mono 16-bit WAV (silence or a tone)."""
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        frames = bytearray()
        for i in range(int(rate * seconds)):
            val = int(3000 * math.sin(2 * math.pi * freq * i / rate)) if freq else 0
            frames += val.to_bytes(2, "little", signed=True)
        w.writeframes(bytes(frames))
    buf.seek(0)
    return buf


@pytest.fixture()
def client():
    srv.app.config.update(TESTING=True)
    return srv.app.test_client()


@pytest.fixture(autouse=True)
def _reset_state(monkeypatch):
    """No stray recorders/timers and no 5-minute delete timers during tests."""
    monkeypatch.setattr(srv, "RETAIN_SECONDS", 0.0)
    srv._rec_proc = None
    srv._rec_file = None
    srv._cancel_watchdog()
    yield
    srv._rec_proc = None
    srv._rec_file = None
    srv._cancel_watchdog()


# ---------------------------------------------------------------------------


def test_health(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.get_json()
    assert body["status"] == "ok"
    assert body["backend"]
    assert "model" in body
    # Recorder depends on the host: arecord/ffmpeg/sox or None in a bare CI image.
    assert "recorder" in body
    if body["recorder"] is not None:
        assert body["recorder"] in {"arecord", "ffmpeg", "sox"}


@pytest.mark.parametrize(
    "present,expected",
    [
        ({}, None),
        ({"arecord": "/usr/bin/arecord"}, "arecord"),
        ({"ffmpeg": "/usr/bin/ffmpeg", "sox": "/usr/bin/sox"}, "ffmpeg"),
        ({"sox": "/usr/bin/sox"}, "sox"),
    ],
)
def test_record_probe_cmd(monkeypatch, present, expected):
    monkeypatch.setattr(srv.shutil, "which", lambda name: present.get(name))
    assert srv._record_probe_cmd() == expected


def test_cors_allows_local_origin(client):
    r = client.get("/health", headers={"Origin": "http://127.0.0.1:4096"})
    assert r.headers.get("Access-Control-Allow-Origin") == "http://127.0.0.1:4096"


def test_cors_rejects_foreign_origin(client):
    r = client.get("/health", headers={"Origin": "https://evil.example"})
    assert "Access-Control-Allow-Origin" not in r.headers


def test_beep_zero_freq_only_logs(client, monkeypatch):
    played = []
    monkeypatch.setattr(srv, "_play_beep", lambda *a, **k: played.append(a))
    r = client.get("/beep?freq=0")
    assert r.status_code == 200
    assert r.get_json() == {"status": "ok", "freq": 0}
    assert played == []


def test_beep_bad_freq_defaults(client, monkeypatch):
    monkeypatch.setattr(srv, "_play_beep", lambda *a, **k: None)
    r = client.get("/beep?freq=abc")
    assert r.status_code == 200
    assert r.get_json()["freq"] == 880


def test_transcribe_without_file_is_400(client):
    r = client.post("/transcribe")
    assert r.status_code == 400


def test_transcribe_returns_text(client, monkeypatch):
    monkeypatch.setattr(
        srv, "transcribe_file",
        lambda path: {"text": "привет", "language": "ru", "language_probability": 1.0},
    )
    r = client.post(
        "/transcribe",
        data={"audio": (make_wav(0.2), "t.wav")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 200
    assert r.get_json()["text"] == "привет"


def test_transcribe_failure_is_500(client, monkeypatch):
    def boom(path):
        raise RuntimeError("nope")

    monkeypatch.setattr(srv, "transcribe_file", boom)
    r = client.post(
        "/transcribe",
        data={"audio": (make_wav(0.2), "t.wav")},
        content_type="multipart/form-data",
    )
    assert r.status_code == 500


def test_record_stop_without_start_is_409(client):
    assert client.post("/record/stop").status_code == 409


def test_record_status_idle(client):
    r = client.get("/record/status")
    assert r.status_code == 200
    assert r.get_json()["recording"] is False


def test_fake_record_cycle(client, monkeypatch, tmp_path):
    """FAKE_AUDIO lets the whole record pipeline run without a microphone."""
    fixture = tmp_path / "fixture.wav"
    fixture.write_bytes(make_wav(0.5).read())
    monkeypatch.setattr(srv, "FAKE_AUDIO", str(fixture))
    monkeypatch.setattr(
        srv, "transcribe_file",
        lambda path: {"text": "ok", "language": "ru", "language_probability": 1.0},
    )

    start = client.post("/record/start")
    assert start.status_code == 200
    assert start.get_json().get("fake") is True

    assert client.post("/record/start").status_code == 409
    assert client.get("/record/status").get_json()["recording"] is True

    stop = client.post("/record/stop")
    assert stop.status_code == 200
    assert stop.get_json()["text"] == "ok"

    assert client.post("/record/stop").status_code == 409


# --- Access token (OPENCODE_VOICE_TOKEN) ---


def test_health_reports_python_and_auth(client, monkeypatch):
    monkeypatch.delenv("OPENCODE_VOICE_TOKEN", raising=False)
    body = client.get("/health").get_json()
    assert body["python"]
    assert body["auth"] is False


def test_token_disabled_by_default(client, monkeypatch):
    monkeypatch.delenv("OPENCODE_VOICE_TOKEN", raising=False)
    monkeypatch.setattr(srv, "_play_beep", lambda *a, **k: None)
    assert client.get("/beep?freq=0").status_code == 200


def test_token_required_when_set(client, monkeypatch):
    monkeypatch.setenv("OPENCODE_VOICE_TOKEN", "secret")
    monkeypatch.setattr(srv, "_play_beep", lambda *a, **k: None)
    assert client.get("/beep?freq=0").status_code == 401
    assert client.get("/beep?freq=0", headers={"X-Voice-Token": "wrong"}).status_code == 401
    assert client.get("/beep?freq=0", headers={"X-Voice-Token": "secret"}).status_code == 200
    assert client.get(
        "/beep?freq=0", headers={"Authorization": "Bearer " + "secret"}
    ).status_code == 200


def test_token_exempts_health(client, monkeypatch):
    monkeypatch.setenv("OPENCODE_VOICE_TOKEN", "secret")
    r = client.get("/health")
    assert r.status_code == 200
    assert r.get_json()["auth"] is True


def test_runtime_checks_smoke(monkeypatch):
    monkeypatch.delenv("PULSE_SERVER", raising=False)
    srv._runtime_checks()  # must not raise


def test_cuda_driver_version_type():
    v = srv._cuda_driver_version()
    assert v is None or isinstance(v, str)
