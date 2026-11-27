"""Accounts: register, login, current user. Passwords are PBKDF2-SHA256 hashed, sessions are signed JWTs.

Signed-in requests send `Authorization: Bearer <token>` and own their data under the owner key
`user:<id>`. Requests without a token fall back to the anonymous guest demo (`X-Client-Id`).
"""

import hashlib
import hmac
import logging
import os
import re
import secrets
import time
from collections import deque
from datetime import datetime, timedelta, timezone

import jwt
from fastapi import APIRouter, Depends, Header, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import DateTime, String, func, select
from sqlalchemy.orm import Mapped, mapped_column

from . import db as D

ALGO = "HS256"
ITERATIONS = 200_000
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
_warned: list[int] = []

log = logging.getLogger(__name__)
MAX_FAILS = int(os.getenv("LOGIN_MAX_FAILS", "5"))
FAIL_WINDOW_S = int(os.getenv("LOGIN_FAIL_WINDOW_S", "300"))
_fails: dict[str, deque] = {}


def throttle_check(key: str) -> None:
    """Block a login key (the email) after MAX_FAILS wrong passwords inside FAIL_WINDOW_S.

    State is in process memory: it stops guessing against one server instance. On a multi-instance or
    serverless deployment each instance counts separately, so put a shared limiter (Redis, gateway) in
    front for hard guarantees.
    """
    now = time.monotonic()
    q = _fails.get(key)
    if not q:
        return
    while q and now - q[0] > FAIL_WINDOW_S:
        q.popleft()
    if len(q) >= MAX_FAILS:
        wait = int(FAIL_WINDOW_S - (now - q[0])) + 1
        raise HTTPException(
            429, "Too many failed attempts. Try again in a few minutes.", headers={"Retry-After": str(wait)}
        )


def throttle_fail(key: str) -> None:
    if len(_fails) > 10_000:
        _fails.clear()
    _fails.setdefault(key, deque()).append(time.monotonic())


def throttle_reset(key: str) -> None:
    _fails.pop(key, None)



def _secret() -> str:
    explicit = os.getenv("JWT_SECRET")
    if explicit:
        return explicit
    if os.getenv("APP_ENV") == "production":
        raise RuntimeError("JWT_SECRET must be set when APP_ENV=production")
    # No separate secret configured: derive one from the database URL, which is already a secret in deployment.
    # Set JWT_SECRET explicitly for anything beyond a demo.
    if not _warned:
        log.warning("JWT_SECRET is not set; deriving the signing key from DATABASE_URL (demo only)")
        _warned.append(1)
    seed = os.getenv("DATABASE_URL", "local-dev-only")
    return hashlib.sha256(("jwt:" + seed).encode()).hexdigest()


class User(D.Base):
    __tablename__ = "wf_users"
    id: Mapped[int] = mapped_column(primary_key=True)
    email: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(120), default="")
    password_hash: Mapped[str] = mapped_column(String(200))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


def hash_password(password: str) -> str:
    salt = secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), salt, ITERATIONS)
    return f"{salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    salt_hex, dk_hex = stored.split("$")
    dk = hashlib.pbkdf2_hmac("sha256", password.encode(), bytes.fromhex(salt_hex), ITERATIONS)
    return hmac.compare_digest(dk.hex(), dk_hex)


def create_token(user_id: int, minutes: int = 60 * 24 * 7) -> str:
    exp = datetime.now(timezone.utc) + timedelta(minutes=minutes)
    return jwt.encode({"sub": str(user_id), "exp": exp}, _secret(), algorithm=ALGO)


def user_id_from_token(token: str) -> int:
    return int(jwt.decode(token, _secret(), algorithms=[ALGO])["sub"])


def identity(authorization: str, x_client_id: str) -> str:
    """Owner key for a request: a signed-in account, or an anonymous guest id."""
    if authorization:
        scheme, _, token = authorization.partition(" ")
        if scheme.lower() != "bearer" or not token:
            raise HTTPException(401, "Invalid Authorization header")
        try:
            return f"user:{user_id_from_token(token)}"
        except (jwt.PyJWTError, ValueError):
            raise HTTPException(401, "Session expired or invalid, please log in again") from None
    if not (8 <= len(x_client_id) <= 64) or not x_client_id.replace("-", "").isalnum():
        raise HTTPException(400, "Missing or invalid X-Client-Id header")
    return x_client_id


class Credentials(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(min_length=8, max_length=128)
    name: str = Field(default="", max_length=120)


class LoginIn(BaseModel):
    email: str = Field(max_length=200)
    password: str = Field(max_length=128)


def _get_db():
    with D.Session() as s:
        yield s


router = APIRouter(prefix="/auth", tags=["auth"])


def _out(user: User) -> dict:
    return {
        "access_token": create_token(user.id),
        "token_type": "bearer",
        "user": {"id": user.id, "email": user.email, "name": user.name},
    }


@router.post("/register", status_code=201)
def register(body: Credentials, db=Depends(_get_db)):
    email = body.email.strip().lower()
    if not EMAIL_RE.match(email):
        raise HTTPException(422, "Enter a valid email address")
    if db.scalar(select(User).where(User.email == email)):
        raise HTTPException(409, "Email already registered")
    user = User(email=email, name=body.name.strip(), password_hash=hash_password(body.password))
    db.add(user)
    db.commit()
    return _out(user)


@router.post("/login")
def login(body: LoginIn, db=Depends(_get_db)):
    key = body.email.strip().lower()
    throttle_check(key)
    user = db.scalar(select(User).where(User.email == key))
    if not user or not verify_password(body.password, user.password_hash):
        throttle_fail(key)
        raise HTTPException(401, "Wrong email or password")
    throttle_reset(key)
    return _out(user)


@router.get("/me")
def me(
    authorization: str = Header(default=""),
    x_client_id: str = Header(default=""),
    db=Depends(_get_db),
):
    owner = identity(authorization, x_client_id)
    if not owner.startswith("user:"):
        raise HTTPException(401, "Not signed in")
    user = db.get(User, int(owner.split(":")[1]))
    if not user:
        raise HTTPException(401, "Account not found")
    return {"id": user.id, "email": user.email, "name": user.name}
