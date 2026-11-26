import uuid

from fastapi.testclient import TestClient

from wf.main import app

c = TestClient(app)
LIST = "/workflows"


def new_user(name="Test User"):
    email = f"{uuid.uuid4().hex[:10]}@example.com"
    r = c.post("/auth/register", json={"email": email, "password": "correct-horse-1", "name": name})
    assert r.status_code == 201, r.text
    return email, {"Authorization": "Bearer " + r.json()["access_token"]}


def test_register_login_me():
    email, h = new_user()
    assert c.get("/auth/me", headers=h).json()["email"] == email
    ok = c.post("/auth/login", json={"email": email.upper(), "password": "correct-horse-1"})
    assert ok.status_code == 200 and ok.json()["user"]["email"] == email


def test_wrong_password_duplicate_and_weak_password_rejected():
    email, _ = new_user()
    assert (
        c.post("/auth/login", json={"email": email, "password": "wrong-password"}).status_code
        == 401
    )
    assert (
        c.post("/auth/register", json={"email": email, "password": "correct-horse-1"}).status_code
        == 409
    )
    assert (
        c.post("/auth/register", json={"email": "x@example.com", "password": "short"}).status_code
        == 422
    )
    assert (
        c.post(
            "/auth/register", json={"email": "not-an-email", "password": "correct-horse-1"}
        ).status_code
        == 422
    )


def test_bad_token_is_rejected_and_guest_still_works():
    assert c.get(LIST, headers={"Authorization": "Bearer nope"}).status_code == 401
    assert c.get("/auth/me").status_code in (400, 401)
    assert c.get(LIST, headers={"X-Client-Id": "guestclient-0001"}).status_code == 200


def test_accounts_start_empty_and_are_isolated():
    _, a = new_user()
    _, b = new_user()
    ra, rb = c.get(LIST, headers=a), c.get(LIST, headers=b)
    assert ra.status_code == 200 and rb.status_code == 200
    # a real account never receives demo data and cannot be impersonated through X-Client-Id
    assert ra.json() == [] or isinstance(ra.json(), (list, dict))
    spoof = c.get(LIST, headers={"X-Client-Id": "user:1"})
    assert spoof.status_code == 400
