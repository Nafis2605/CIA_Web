// server/src/routes/renderToken.js
// Mints short-lived, scoped credentials for the Python render server —
// replaces the single static RENDER_SERVER_TOKEN that used to be shared by
// every client (baked into the frontend bundle via webpack DefinePlugin,
// visible to anyone who opened devtools) with no per-user scoping or
// expiry. This endpoint requires the caller to already be authenticated
// (same middleware every other authorization-sensitive route uses), and
// signs a compact payload the render server verifies by signature +
// expiry + dataset scope instead of a plain string-equality check.

const express = require("express");
const crypto = require("crypto");
const router = express.Router();
const { authenticate } = require("../middleware/auth");
const { createLogger } = require("../utils/logger");

const log = createLogger("renderToken");

// 1 hour — comfortably longer than a single render session, so this is a
// rare re-fetch, not a per-request cost.
const TOKEN_TTL_MS = 60 * 60 * 1000;

function base64url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function sign(payloadB64) {
  const secret = process.env.RENDER_TOKEN_SECRET;
  if (!secret) {
    throw new Error("RENDER_TOKEN_SECRET is not configured");
  }
  return base64url(crypto.createHmac("sha256", secret).update(payloadB64).digest());
}

/**
 * POST /api/render/token
 * Body: { datasetId?: string }
 * Returns: { token: string, expiresAt: number }
 *
 * Token format: `${payloadB64}.${signatureB64}`, where payloadB64 is the
 * base64url-encoded JSON `{ sub, datasetId, exp }`. Deliberately not a full
 * JWT library (jsonwebtoken exists on the Node side, but the Python render
 * server has no JWT dependency today) — a raw HMAC keeps this a lightweight
 * first hardening pass rather than adding a new dependency for one route.
 */
router.post("/token", authenticate, async (req, res) => {
  try {
    const datasetId = typeof req.body?.datasetId === "string" ? req.body.datasetId : null;
    const payload = {
      sub: req.user.id,
      datasetId,
      exp: Date.now() + TOKEN_TTL_MS,
    };
    const payloadB64 = base64url(Buffer.from(JSON.stringify(payload)));
    const signatureB64 = sign(payloadB64);
    const token = `${payloadB64}.${signatureB64}`;

    res.json({ token, expiresAt: payload.exp });
  } catch (error) {
    log.error("Failed to mint render token:", error);
    res.status(500).json({ error: "Failed to mint render token" });
  }
});

module.exports = router;
