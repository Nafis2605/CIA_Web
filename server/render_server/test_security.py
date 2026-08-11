"""
test_security.py
H14: the render server used to trust a client-supplied path (only checking
the file extension, never containment), allow CORS from any origin, and
enforce zero authentication or resource bounds. These tests pin the new
pure-logic helpers in app.py directly — no VTK rendering, no running server,
no network — since those are the pieces that are meaningfully unit-testable
without a live FastAPI/VTK stack.
"""

import base64
import hashlib
import hmac
import json
import os
import tempfile
import time

import pytest

import app


def _make_token(secret, sub="user-1", dataset_id=None, exp=None):
    """Mirror server/src/routes/renderToken.js's token construction, so
    these tests exercise the exact wire format the real minting endpoint
    produces (and app.py must accept)."""
    if exp is None:
        exp = (time.time() + 3600) * 1000  # 1 hour from now, in ms
    payload = json.dumps({"sub": sub, "datasetId": dataset_id, "exp": exp}).encode("utf-8")
    payload_b64 = base64.urlsafe_b64encode(payload).decode("utf-8").rstrip("=")
    sig = hmac.new(secret.encode("utf-8"), payload_b64.encode("utf-8"), hashlib.sha256).digest()
    sig_b64 = base64.urlsafe_b64encode(sig).decode("utf-8").rstrip("=")
    return f"{payload_b64}.{sig_b64}"


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


# ── _token_valid / _verify_scoped_token / require_render_token ────────────
# H14 originally gated access behind a single shared static secret compared
# with plain string equality (RENDER_SERVER_TOKEN). That was replaced by
# short-lived, scoped, HMAC-signed credentials minted by the main API
# (server/src/routes/renderToken.js) and verified here by signature +
# expiry (+ dataset scope, checked separately at loadDataset time — see
# the WS handler, not _token_valid).

def test_token_check_open_when_unconfigured(monkeypatch):
    monkeypatch.setattr(app, "RENDER_TOKEN_SECRET", "")
    assert app._token_valid(None) is True
    assert app._token_valid("literally-anything") is True


def test_token_check_accepts_a_correctly_signed_unexpired_token(monkeypatch):
    monkeypatch.setattr(app, "RENDER_TOKEN_SECRET", "secret-123")
    token = _make_token("secret-123")
    assert app._token_valid(token) is True


def test_token_check_rejects_a_token_signed_with_the_wrong_secret(monkeypatch):
    monkeypatch.setattr(app, "RENDER_TOKEN_SECRET", "secret-123")
    token = _make_token("some-other-secret")
    assert app._token_valid(token) is False


def test_token_check_rejects_a_tampered_payload(monkeypatch):
    monkeypatch.setattr(app, "RENDER_TOKEN_SECRET", "secret-123")
    token = _make_token("secret-123", sub="user-1")
    payload_b64, _, sig_b64 = token.partition(".")
    # Swap in a different (still validly-formed) payload without re-signing
    # — the signature must no longer match.
    tampered_payload = _make_token("secret-123", sub="attacker").partition(".")[0]
    assert app._token_valid(f"{tampered_payload}.{sig_b64}") is False


def test_token_check_rejects_an_expired_token(monkeypatch):
    monkeypatch.setattr(app, "RENDER_TOKEN_SECRET", "secret-123")
    expired = _make_token("secret-123", exp=(time.time() - 60) * 1000)  # 1 min ago
    assert app._token_valid(expired) is False


def test_token_check_rejects_malformed_or_missing_tokens(monkeypatch):
    monkeypatch.setattr(app, "RENDER_TOKEN_SECRET", "secret-123")
    assert app._token_valid(None) is False
    assert app._token_valid("not-a-real-token") is False
    assert app._token_valid("") is False


def test_verify_scoped_token_returns_the_decoded_payload_for_dataset_scope_checks(monkeypatch):
    monkeypatch.setattr(app, "RENDER_TOKEN_SECRET", "secret-123")
    token = _make_token("secret-123", sub="user-1", dataset_id="ds-42")
    payload = app._verify_scoped_token(token)
    assert payload is not None
    assert payload["sub"] == "user-1"
    assert payload["datasetId"] == "ds-42"


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
