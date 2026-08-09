"""
test_security.py
H14: the render server used to trust a client-supplied path (only checking
the file extension, never containment), allow CORS from any origin, and
enforce zero authentication or resource bounds. These tests pin the new
pure-logic helpers in app.py directly — no VTK rendering, no running server,
no network — since those are the pieces that are meaningfully unit-testable
without a live FastAPI/VTK stack.
"""

import os
import tempfile

import pytest

import app


# ── resolve_registered_path ───────────────────────────────────────────────

def test_resolve_registered_path_returns_none_for_unknown_dataset(monkeypatch):
    monkeypatch.setattr(app, "DATASETS", {})
    assert app.resolve_registered_path("does-not-exist") is None


def test_resolve_registered_path_only_ever_returns_the_servers_own_scanned_path(monkeypatch):
    monkeypatch.setattr(
        app, "DATASETS", {"demo": {"id": "demo", "path": "/app/datasets/demo.vtp"}}
    )
    # No client-path parameter exists on this function at all — the only
    # input is the id, so there is nothing an attacker could smuggle a path
    # through even if they controlled every other field of the request.
    assert app.resolve_registered_path("demo") == "/app/datasets/demo.vtp"


# ── _token_valid / require_render_token ───────────────────────────────────

def test_token_check_open_when_unconfigured(monkeypatch):
    monkeypatch.setattr(app, "RENDER_SERVER_TOKEN", "")
    assert app._token_valid(None) is True
    assert app._token_valid("literally-anything") is True


def test_token_check_enforces_exact_match_when_configured(monkeypatch):
    monkeypatch.setattr(app, "RENDER_SERVER_TOKEN", "secret-123")
    assert app._token_valid("secret-123") is True
    assert app._token_valid("wrong") is False
    assert app._token_valid(None) is False


# ── check_dataset_size ─────────────────────────────────────────────────────

def test_check_dataset_size_passes_under_limit(monkeypatch, tmp_path):
    monkeypatch.setattr(app, "MAX_DATASET_SIZE_MB", 1)
    small = tmp_path / "small.vtp"
    small.write_bytes(b"x" * 1024)  # 1KB, well under 1MB
    app.check_dataset_size(str(small))  # must not raise


def test_check_dataset_size_raises_over_limit(monkeypatch, tmp_path):
    monkeypatch.setattr(app, "MAX_DATASET_SIZE_MB", 1)
    big = tmp_path / "big.vtp"
    big.write_bytes(b"x" * (2 * 1024 * 1024))  # 2MB > 1MB limit
    with pytest.raises(ValueError, match="exceeds size limit"):
        app.check_dataset_size(str(big))


# ── check_rate_limit ─────────────────────────────────────────────────────

def test_check_rate_limit_allows_up_to_the_configured_count(monkeypatch):
    monkeypatch.setattr(app, "RATE_LIMIT_MAX_LOADS_PER_MIN", 3)
    monkeypatch.setattr(app, "_load_times_by_ip", app.defaultdict(app.deque))
    fake_now = [1000.0]
    monkeypatch.setattr(app.time, "time", lambda: fake_now[0])

    for _ in range(3):
        app.check_rate_limit("1.2.3.4")  # must not raise


def test_check_rate_limit_raises_past_the_configured_count(monkeypatch):
    monkeypatch.setattr(app, "RATE_LIMIT_MAX_LOADS_PER_MIN", 3)
    monkeypatch.setattr(app, "_load_times_by_ip", app.defaultdict(app.deque))
    fake_now = [1000.0]
    monkeypatch.setattr(app.time, "time", lambda: fake_now[0])

    for _ in range(3):
        app.check_rate_limit("1.2.3.4")

    with pytest.raises(ValueError, match="Rate limit exceeded"):
        app.check_rate_limit("1.2.3.4")


def test_check_rate_limit_resets_after_the_window_elapses(monkeypatch):
    monkeypatch.setattr(app, "RATE_LIMIT_MAX_LOADS_PER_MIN", 2)
    monkeypatch.setattr(app, "_load_times_by_ip", app.defaultdict(app.deque))
    fake_now = [1000.0]
    monkeypatch.setattr(app.time, "time", lambda: fake_now[0])

    app.check_rate_limit("1.2.3.4")
    app.check_rate_limit("1.2.3.4")
    with pytest.raises(ValueError, match="Rate limit exceeded"):
        app.check_rate_limit("1.2.3.4")

    fake_now[0] += 61  # past the 60s window
    app.check_rate_limit("1.2.3.4")  # must not raise — old entries expired


def test_check_rate_limit_tracks_ips_independently(monkeypatch):
    monkeypatch.setattr(app, "RATE_LIMIT_MAX_LOADS_PER_MIN", 1)
    monkeypatch.setattr(app, "_load_times_by_ip", app.defaultdict(app.deque))
    fake_now = [1000.0]
    monkeypatch.setattr(app.time, "time", lambda: fake_now[0])

    app.check_rate_limit("1.2.3.4")
    app.check_rate_limit("5.6.7.8")  # different IP — must not raise
