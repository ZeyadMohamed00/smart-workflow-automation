"""Optional HMAC signing for inbound webhooks.

Each workflow has its own signing key, derived from the server secret and the workflow token, so
nothing extra is stored. A sender signs `"<unix timestamp>.<raw body>"` with HMAC-SHA256 and sends:

    X-Webhook-Timestamp: 1767225600
    X-Webhook-Signature: sha256=<hex digest>

The timestamp must be within 5 minutes, which blocks replay of a captured request. If a signature
is sent it must be valid. Set WEBHOOK_REQUIRE_SIGNATURE=1 to reject unsigned calls as well (the
public demo leaves it off so the "Send test webhook" button works).
"""

import hashlib
import hmac
import os
import time

from .auth import _secret

TOLERANCE_S = 300


def signing_key(token: str) -> str:
    return hmac.new(_secret().encode(), b"webhook:" + token.encode(), hashlib.sha256).hexdigest()


def sign(token: str, timestamp: int, body: bytes) -> str:
    msg = str(timestamp).encode() + b"." + body
    digest = hmac.new(signing_key(token).encode(), msg, hashlib.sha256).hexdigest()
    return "sha256=" + digest


def required() -> bool:
    return os.getenv("WEBHOOK_REQUIRE_SIGNATURE", "") in ("1", "true", "yes")


def check(token: str, timestamp: str, signature: str, body: bytes, now: float | None = None) -> bool:
    """True if the signature matches and the timestamp is fresh."""
    try:
        ts = int(timestamp)
    except (TypeError, ValueError):
        return False
    if abs((now if now is not None else time.time()) - ts) > TOLERANCE_S:
        return False
    return hmac.compare_digest(sign(token, ts, body), signature or "")
