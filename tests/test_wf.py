from fastapi.testclient import TestClient

from wf import engine as E
from wf.main import app

c = TestClient(app)
H = lambda n="wfclient-0001": {"X-Client-Id": n}


def wfs(n):
    return {w["name"]: w for w in c.get("/workflows", headers=H(n)).json()}


def execs(n, wid):
    return [e for e in c.get("/executions", headers=H(n)).json() if e["workflow_id"] == wid]


def run_tick(n):
    r = c.post("/worker/tick", headers=H(n))
    assert r.status_code == 200
    return r.json()


def test_condition_logic():
    assert E.matches([{"field": "amount", "op": "gt", "value": 500}], {"amount": 700})
    assert not E.matches([{"field": "amount", "op": "gt", "value": 500}], {"amount": 10})
    assert not E.matches([{"field": "amount", "op": "gt", "value": 500}], {})
    assert not E.matches([{"field": "amount", "op": "gt", "value": 500}], {"amount": "abc"})
    assert E.matches([{"field": "t", "op": "contains", "value": "BUG"}], {"t": "found a bug"})


def test_classifier():
    assert E.classify_text("I was charged twice on my invoice")[0] == "billing"
    assert E.classify_text("the app crashes with an error")[0] == "bug"
    assert E.classify_text("please add dark mode, would be nice")[0] == "feature_request"
    assert E.classify_text("hello there")[0] == "other"


def test_webhook_to_execution_history_with_classification():
    n = "hook-client-0001"
    w = wfs(n)["Triage support tickets (AI classification)"]
    r = c.post(w["webhook_path"], json={"text": "I was charged twice, need a refund"})
    assert r.status_code == 202
    run_tick(n)
    ex = execs(n, w["id"])[0]
    assert (
        ex["status"] == "succeeded"
        and ex["payload"]["category"] == "billing"
        and len(ex["steps"]) == 2
    )


def test_condition_skips_and_matches():
    n = "cond-client-0001"
    w = wfs(n)["Flag high-value orders"]
    c.post(w["webhook_path"], json={"amount": 20})
    c.post(w["webhook_path"], json={"amount": 900})
    run_tick(n)
    ex = execs(n, w["id"])
    assert {e["status"] for e in ex} == {"skipped", "succeeded"}
    assert [e for e in ex if e["status"] == "succeeded"][0]["payload"]["priority"] == "high"


def test_retry_with_backoff_then_success(monkeypatch):
    monkeypatch.setenv("RETRY_BASE_DELAY", "0")
    n = "retry-client-001"
    w = wfs(n)["Flaky partner API (retry test)"]
    assert c.post(f"/workflows/{w['id']}/run", headers=H(n)).status_code == 202
    run_tick(n)
    ex = execs(n, w["id"])[0]
    assert ex["status"] == "succeeded"
    flaky = [s for s in ex["steps"] if s["step"].endswith("flaky")]
    assert [s["ok"] for s in flaky] == [False, False, True] and flaky[-1]["attempt"] == 3


def test_permanent_failure_after_max_attempts(monkeypatch):
    monkeypatch.setenv("RETRY_BASE_DELAY", "0")
    n = "fail-client-0001"
    r = c.post(
        "/workflows",
        headers=H(n),
        json={
            "name": "always fails",
            "trigger_type": "manual",
            "actions": [{"type": "flaky", "fail_times": 5}, {"type": "log", "message": "x"}],
        },
    )
    c.post(f"/workflows/{r.json()['id']}/run", headers=H(n))
    run_tick(n)
    ex = c.get("/executions", headers=H(n)).json()[0]
    assert (
        ex["status"] == "failed" and "503" in ex["error"] and len(ex["steps"]) == 3
    )  # 3 attempts, second action never ran


def test_schedule_enqueues_once_per_interval():
    n = "sched-client-001"
    wfs(n)
    assert run_tick(n)["scheduled"] == 1
    assert run_tick(n)["scheduled"] == 0
    assert any(
        e["trigger"] == "schedule" and e["status"] == "succeeded"
        for e in c.get("/executions", headers=H(n)).json()
    )


def test_disabled_and_unknown_webhooks_and_validation():
    n = "val-client-0001"
    w = wfs(n)["Flag high-value orders"]
    c.patch(f"/workflows/{w['id']}", params={"enabled": False}, headers=H(n))
    assert c.post(w["webhook_path"], json={"amount": 900}).status_code == 404
    assert c.post("/hooks/nope", json={}).status_code == 404
    assert (
        c.post(
            "/workflows",
            headers=H(n),
            json={"name": "x", "trigger_type": "schedule", "actions": [{"type": "log"}]},
        ).status_code
        == 422
    )
    assert (
        c.post(
            "/workflows",
            headers=H(n),
            json={"name": "x", "trigger_type": "manual", "actions": [{"type": "rm -rf"}]},
        ).status_code
        == 422
    )


def test_isolation_and_cron_secret(monkeypatch):
    w = wfs("iso-client-0001")["Flag high-value orders"]
    assert c.post(f"/workflows/{w['id']}/run", headers=H("iso-client-0002")).status_code == 404
    monkeypatch.setenv("CRON_SECRET", "s3cret")
    assert c.get("/cron/tick").status_code == 401
    assert c.get("/cron/tick", headers={"Authorization": "Bearer s3cret"}).status_code == 200


def _webhook_workflow(n):
    return next(w for w in wfs(n).values() if w["trigger_type"] == "webhook")


def _signed_headers(w, body: bytes, ts=None):
    import time

    from wf import signing

    ts = int(time.time()) if ts is None else ts
    token = w["webhook_path"].rsplit("/", 1)[1]
    return {
        "X-Webhook-Timestamp": str(ts),
        "X-Webhook-Signature": signing.sign(token, ts, body),
        "Content-Type": "application/json",
    }


def test_signed_webhook_accepted_and_tampering_rejected():
    n = "wfclient-sign-01"
    w = _webhook_workflow(n)
    body = b'{"text": "charged twice"}'
    ok = c.post(w["webhook_path"], content=body, headers=_signed_headers(w, body))
    assert ok.status_code == 202
    tampered = c.post(w["webhook_path"], content=b'{"text": "other"}', headers=_signed_headers(w, body))
    assert tampered.status_code == 401
    bad = {**_signed_headers(w, body), "X-Webhook-Signature": "sha256=" + "0" * 64}
    assert c.post(w["webhook_path"], content=body, headers=bad).status_code == 401


def test_stale_timestamp_is_rejected_as_replay():
    import time

    n = "wfclient-sign-02"
    w = _webhook_workflow(n)
    body = b'{"x": 1}'
    old = int(time.time()) - 3600
    r = c.post(w["webhook_path"], content=body, headers=_signed_headers(w, body, ts=old))
    assert r.status_code == 401


def test_unsigned_allowed_by_default_and_blocked_when_required(monkeypatch):
    n = "wfclient-sign-03"
    w = _webhook_workflow(n)
    assert c.post(w["webhook_path"], json={"a": 1}).status_code == 202
    monkeypatch.setenv("WEBHOOK_REQUIRE_SIGNATURE", "1")
    assert c.post(w["webhook_path"], json={"a": 1}).status_code == 401
