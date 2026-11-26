import os, secrets
from datetime import datetime, timezone
from sqlalchemy import create_engine, String, Integer, Text, Boolean, DateTime, JSON, ForeignKey
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, sessionmaker

engine = create_engine(os.getenv("DATABASE_URL", "postgresql+psycopg2://postgres@localhost/wf"), pool_pre_ping=True)
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
    token: Mapped[str] = mapped_column(String(40), unique=True, default=lambda: secrets.token_urlsafe(18))
    last_run_at = mapped_column(DateTime(timezone=True), nullable=True)


class Execution(Base):
    __tablename__ = "wf_executions"
    id: Mapped[int] = mapped_column(primary_key=True)
    workflow_id: Mapped[int] = mapped_column(ForeignKey("wf_workflows.id", ondelete="CASCADE"), index=True)
    client_id: Mapped[str] = mapped_column(String(64), index=True)
    trigger: Mapped[str] = mapped_column(String(12))
    status: Mapped[str] = mapped_column(String(12), default="queued", index=True)  # queued|running|succeeded|failed|skipped
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    steps: Mapped[list] = mapped_column(JSON, default=list)
    error: Mapped[str] = mapped_column(Text, default="")
    created_at = mapped_column(DateTime(timezone=True), default=now)
    finished_at = mapped_column(DateTime(timezone=True), nullable=True)


def init():
    Base.metadata.create_all(engine)


SAMPLES = [
    dict(name="Triage support tickets (AI classification)", trigger_type="webhook", conditions=[],
         actions=[{"type": "classify", "field": "text"}, {"type": "log", "message": "Ticket classified"}]),
    dict(name="Flag high-value orders", trigger_type="webhook", conditions=[{"field": "amount", "op": "gt", "value": 500}],
         actions=[{"type": "set_field", "field": "priority", "value": "high"}, {"type": "notify", "message": "High-value order needs review"}]),
    dict(name="Daily heartbeat", trigger_type="schedule", interval_minutes=1440, conditions=[], actions=[{"type": "log", "message": "heartbeat"}]),
    dict(name="Flaky partner API (retry demo)", trigger_type="manual", conditions=[],
         actions=[{"type": "flaky", "fail_times": 2}, {"type": "log", "message": "partner sync done"}]),
]


def ensure_seed(db, client_id):
    if db.query(Workflow).filter_by(client_id=client_id).first():
        return
    db.add_all([Workflow(client_id=client_id, **s) for s in SAMPLES])
    db.commit()
