import os
import secrets
from datetime import datetime, timezone

from sqlalchemy import JSON, Boolean, DateTime, ForeignKey, Integer, String, Text, create_engine
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

engine = create_engine(
    os.getenv("DATABASE_URL", "postgresql+psycopg2://postgres@localhost/wf"), pool_pre_ping=True
)
Session = sessionmaker(engine, expire_on_commit=False)
now = lambda: datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Workflow(Base):
    __tablename__ = "wf_workflows"
    id: Mapped[int] = mapped_column(primary_key=True)
    client_id: Mapped[str] = mapped_column(String(64), index=True)
    name: Mapped[str] = mapped_column(String(120))
    trigger_type: Mapped[str] = mapped_column(String(10))  # webhook | schedule | manual
    interval_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    conditions: Mapped[list] = mapped_column(JSON, default=list)
    actions: Mapped[list] = mapped_column(JSON, default=list)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    token: Mapped[str] = mapped_column(
        String(40), unique=True, default=lambda: secrets.token_urlsafe(18)
    )
    last_run_at = mapped_column(DateTime(timezone=True), nullable=True)


class Execution(Base):
    __tablename__ = "wf_executions"
    id: Mapped[int] = mapped_column(primary_key=True)
    workflow_id: Mapped[int] = mapped_column(
        ForeignKey("wf_workflows.id", ondelete="CASCADE"), index=True
    )
    client_id: Mapped[str] = mapped_column(String(64), index=True)
    trigger: Mapped[str] = mapped_column(String(12))
    status: Mapped[str] = mapped_column(
        String(12), default="queued", index=True
    )  # queued|running|succeeded|failed|skipped
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    steps: Mapped[list] = mapped_column(JSON, default=list)
    error: Mapped[str] = mapped_column(Text, default="")
    created_at = mapped_column(DateTime(timezone=True), default=now)
    finished_at = mapped_column(DateTime(timezone=True), nullable=True)


def init():
    Base.metadata.create_all(engine)


SAMPLES = [
    dict(
        name="Triage support tickets (AI classification)",
        trigger_type="webhook",
        conditions=[],
        actions=[
            {"type": "classify", "field": "text"},
            {"type": "log", "message": "Ticket classified"},
        ],
    ),
    dict(
        name="Flag high-value orders",
        trigger_type="webhook",
        conditions=[{"field": "amount", "op": "gt", "value": 500}],
        actions=[
            {"type": "set_field", "field": "priority", "value": "high"},
            {"type": "notify", "message": "High-value order needs review"},
        ],
    ),
    dict(
        name="Daily heartbeat",
        trigger_type="schedule",
        interval_minutes=1440,
        conditions=[],
        actions=[{"type": "log", "message": "heartbeat"}],
    ),
    dict(
        name="Flaky partner API (retry test)",
        trigger_type="manual",
        conditions=[],
        actions=[
            {"type": "flaky", "fail_times": 2},
            {"type": "log", "message": "partner sync done"},
        ],
    ),
]


def ensure_seed(db, client_id):
    if client_id.startswith("user:"):
        return  # real accounts start empty; only anonymous guests get demo data
    if db.bind.dialect.name == "postgresql":  # the UI fires several requests at once on first load
        from sqlalchemy import text

        db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:c))"), {"c": client_id})
    if db.query(Workflow).filter_by(client_id=client_id).first():
        db.commit()
        return
    wfs = [Workflow(client_id=client_id, **s) for s in SAMPLES]
    db.add_all(wfs)
    db.commit()
    _seed_history(db, client_id, wfs)


def _seed_history(db, client_id, wfs):
    """Synthetic past runs so a new guest's dashboard is not empty. Clearly sample data."""
    import datetime as dt

    triage, flag, beat, flaky = wfs
    t0 = now()
    runs = []

    def add(wf, hours_ago, trigger, status, payload, steps, error=""):
        runs.append((wf, hours_ago, trigger, status, payload, steps, error))

    tickets = [
        ("The invoice shows the wrong amount", "billing"),
        ("App crashes when I open settings", "bug"),
        ("Could you add CSV export?", "feature_request"),
        ("I was charged twice this month", "billing"),
        ("Dark mode would be great", "feature_request"),
    ]
    for i, (txt, lab) in enumerate(tickets):
        add(triage, 70 - i * 13, "webhook", "succeeded", {"text": txt, "label": lab},
            [{"step": "1:classify", "ok": True, "attempt": 1, "detail": f"label={lab}"},
             {"step": "2:log", "ok": True, "attempt": 1, "detail": "Ticket classified"}])
    for i, amt in enumerate([1200, 90, 640]):
        if amt > 500:
            add(flag, 60 - i * 20, "webhook", "succeeded", {"amount": amt, "priority": "high"},
                [{"step": "1:set_field", "ok": True, "attempt": 1, "detail": "priority=high"},
                 {"step": "2:notify", "ok": True, "attempt": 1, "detail": "High-value order needs review"}])
        else:
            add(flag, 60 - i * 20, "webhook", "skipped", {"amount": amt},
                [{"step": "conditions", "ok": True, "detail": "conditions not met, nothing to do"}])
    for d in (3, 2, 1):
        add(beat, d * 24 - 6, "schedule", "succeeded", {},
            [{"step": "1:log", "ok": True, "attempt": 1, "detail": "heartbeat"}])
    add(flaky, 40, "manual", "succeeded", {},
        [{"step": "1:flaky", "ok": False, "attempt": 1, "detail": "partner API returned 503 (attempt 1)"},
         {"step": "1:flaky", "ok": False, "attempt": 2, "detail": "partner API returned 503 (attempt 2)"},
         {"step": "1:flaky", "ok": True, "attempt": 3, "detail": "partner API ok on attempt 3"},
         {"step": "2:log", "ok": True, "attempt": 1, "detail": "partner sync done"}])
    add(flaky, 9, "manual", "failed", {},
        [{"step": "1:flaky", "ok": False, "attempt": n, "detail": f"partner API returned 503 (attempt {n})"} for n in (1, 2, 3)],
        "partner API returned 503 (attempt 3)")
    runs.sort(key=lambda r: -r[1])
    for wf, h, trig, status, payload, steps, err in runs:
        ts = t0 - dt.timedelta(hours=h)
        db.add(Execution(workflow_id=wf.id, client_id=client_id, trigger=trig, status=status,
                         payload=payload, steps=steps, error=err, created_at=ts,
                         finished_at=ts + dt.timedelta(seconds=2)))
    db.commit()
