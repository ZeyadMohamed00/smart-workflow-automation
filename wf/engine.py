"""Workflow engine: conditions, actions, retry with backoff, execution history, and a Postgres-backed job queue."""

import time
from datetime import timedelta

from sqlalchemy import select

from .db import Execution, Workflow, now

OPS = {
    "eq": lambda a, b: a == b,
    "neq": lambda a, b: a != b,
    "gt": lambda a, b: float(a) > float(b),
    "lt": lambda a, b: float(a) < float(b),
    "contains": lambda a, b: str(b).lower() in str(a).lower(),
}
MAX_ATTEMPTS = 3
CATEGORIES = {
    "billing": [
        "invoice",
        "charge",
        "charged",
        "payment",
        "refund",
        "billing",
        "price",
        "subscription",
    ],
    "bug": [
        "error",
        "crash",
        "bug",
        "broken",
        "not working",
        "fails",
        "exception",
        "can't login",
        "cannot login",
    ],
    "feature_request": ["feature", "would be nice", "please add", "wish", "support for", "suggest"],
}


class ActionError(Exception):
    pass


def matches(conditions: list, payload: dict) -> bool:
    for c in conditions:
        if c["field"] not in payload:
            return False
        try:
            if not OPS[c["op"]](payload[c["field"]], c["value"]):
                return False
        except (ValueError, TypeError, KeyError):
            return False
    return True


def classify_text(text: str) -> tuple[str, dict]:
    """Keyword-score classifier (default). An LLM classifier is NOT wired in: no API key was available."""
    t = text.lower()
    scores = {k: sum(w in t for w in ws) for k, ws in CATEGORIES.items()}
    best = max(scores, key=scores.get)
    return (best, scores) if scores[best] else ("other", scores)


def run_action(a: dict, payload: dict, attempt: int) -> str:
    t = a["type"]
    if t == "classify":
        cat, scores = classify_text(str(payload.get(a.get("field", "text"), "")))
        payload["category"] = cat
        return f"category={cat} scores={scores}"
    if t == "set_field":
        payload[a["field"]] = a["value"]
        return f"{a['field']}={a['value']}"
    if t == "log":
        return a.get("message", "")
    if t == "notify":
        return "notification recorded (no external message is sent by this demo): " + a.get(
            "message", ""
        )
    if t == "flaky":  # simulates an unreliable dependency: fails the first N attempts
        if attempt <= int(a.get("fail_times", 1)):
            raise ActionError(f"partner API returned 503 (attempt {attempt})")
        return f"partner API ok on attempt {attempt}"
    raise ActionError(f"unknown action type {t!r}")


def process(db, ex: Execution, sleep=time.sleep, base_delay=0.2):
    wf = db.get(Workflow, ex.workflow_id)
    ex.status = "running"
    db.commit()
    payload, steps = dict(ex.payload), []
    if not matches(wf.conditions, payload):
        ex.status, ex.steps = (
            "skipped",
            [{"step": "conditions", "ok": True, "detail": "conditions not met, nothing to do"}],
        )
        ex.finished_at = now()
        db.commit()
        return ex
    for i, a in enumerate(wf.actions):
        for attempt in range(1, MAX_ATTEMPTS + 1):
            try:
                detail = run_action(a, payload, attempt)
                steps.append(
                    {
                        "step": f"{i + 1}:{a['type']}",
                        "ok": True,
                        "attempt": attempt,
                        "detail": detail,
                    }
                )
                break
            except ActionError as e:
                steps.append(
                    {
                        "step": f"{i + 1}:{a['type']}",
                        "ok": False,
                        "attempt": attempt,
                        "detail": str(e),
                    }
                )
                if attempt == MAX_ATTEMPTS:
                    ex.status, ex.error, ex.steps, ex.payload = "failed", str(e), steps, payload
                    ex.finished_at = now()
                    db.commit()
                    return ex
                sleep(base_delay * 2 ** (attempt - 1))  # exponential backoff
    ex.status, ex.steps, ex.payload = "succeeded", steps, payload
    ex.finished_at = now()
    db.commit()
    return ex


def enqueue(db, wf: Workflow, trigger: str, payload: dict) -> Execution:
    ex = Execution(workflow_id=wf.id, client_id=wf.client_id, trigger=trigger, payload=payload)
    db.add(ex)
    db.commit()
    return ex


def tick(db, client_id: str | None = None, limit: int = 20, **kw) -> dict:
    """Worker tick: enqueue due schedules, then claim and run queued executions (FOR UPDATE SKIP LOCKED, safe with many workers)."""
    q = select(Workflow).where(Workflow.trigger_type == "schedule", Workflow.enabled.is_(True))
    if client_id:
        q = q.where(Workflow.client_id == client_id)
    scheduled = 0
    for wf in db.scalars(q):
        if wf.last_run_at is None or now() - wf.last_run_at >= timedelta(
            minutes=wf.interval_minutes or 1440
        ):
            enqueue(db, wf, "schedule", {})
            wf.last_run_at = now()
            db.commit()
            scheduled += 1
    done = 0
    while done < limit:
        cq = (
            select(Execution)
            .where(Execution.status == "queued")
            .order_by(Execution.id)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        if client_id:
            cq = cq.where(Execution.client_id == client_id)
        ex = db.scalars(cq).first()
        if not ex:
            break
        process(db, ex, **kw)
        done += 1
    return {"scheduled": scheduled, "processed": done}
