import os

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sqlalchemy import func

from . import db as D
from . import engine as E
from .auth import identity
from .auth import router as auth_router


def get_db():
    with D.Session() as s:
        yield s


def client(authorization: str = Header(default=""), x_client_id: str = Header(default="")):
    return identity(authorization, x_client_id)


class Condition(BaseModel):
    field: str
    op: str = Field(pattern="^(eq|neq|gt|lt|contains)$")
    value: str | int | float


class Action(BaseModel):
    type: str = Field(pattern="^(classify|set_field|log|notify|flaky)$")
    field: str | None = None
    value: str | int | float | None = None
    message: str | None = None
    fail_times: int | None = Field(default=None, ge=0, le=5)


class WorkflowIn(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    trigger_type: str = Field(pattern="^(webhook|schedule|manual)$")
    interval_minutes: int | None = Field(default=None, ge=1, le=10080)
    conditions: list[Condition] = []
    actions: list[Action] = Field(min_length=1, max_length=10)


def wf_out(w):
    return {
        "id": w.id,
        "name": w.name,
        "trigger_type": w.trigger_type,
        "interval_minutes": w.interval_minutes,
        "conditions": w.conditions,
        "actions": w.actions,
        "enabled": w.enabled,
        "webhook_path": f"/hooks/{w.token}" if w.trigger_type == "webhook" else None,
    }


def ex_out(e):
    return {
        "id": e.id,
        "workflow_id": e.workflow_id,
        "trigger": e.trigger,
        "status": e.status,
        "payload": e.payload,
        "steps": e.steps,
        "error": e.error,
        "created_at": e.created_at.isoformat() if e.created_at else None,
    }


def create_app():
    D.init()
    app = FastAPI(title="Smart Workflow Automation", version="1.0.0")
    app.include_router(auth_router)
    app.add_middleware(
        CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"]
    )
    fast = lambda: dict(base_delay=float(os.getenv("RETRY_BASE_DELAY", "0.2")))

    @app.get("/health")
    def health():
        return {"status": "ok"}

    @app.get("/workflows")
    def list_workflows(cid: str = Depends(client), db=Depends(get_db)):
        D.ensure_seed(db, cid)
        return [
            wf_out(w) for w in db.query(D.Workflow).filter_by(client_id=cid).order_by(D.Workflow.id)
        ]

    @app.post("/workflows", status_code=201)
    def create_workflow(body: WorkflowIn, cid: str = Depends(client), db=Depends(get_db)):
        if db.query(D.Workflow).filter_by(client_id=cid).count() >= 20:
            raise HTTPException(409, "Workflow limit (20) reached")
        if body.trigger_type == "schedule" and not body.interval_minutes:
            raise HTTPException(422, "schedule workflows need interval_minutes")
        w = D.Workflow(
            client_id=cid,
            name=body.name,
            trigger_type=body.trigger_type,
            interval_minutes=body.interval_minutes,
            conditions=[c.model_dump() for c in body.conditions],
            actions=[a.model_dump(exclude_none=True) for a in body.actions],
        )
        db.add(w)
        db.commit()
        return wf_out(w)

    def own(db, cid, wid):
        w = db.get(D.Workflow, wid)
        if not w or w.client_id != cid:
            raise HTTPException(404, "Not found")
        return w

    @app.patch("/workflows/{wid}")
    def toggle(wid: int, enabled: bool, cid: str = Depends(client), db=Depends(get_db)):
        w = own(db, cid, wid)
        w.enabled = enabled
        db.commit()
        return wf_out(w)

    @app.delete("/workflows/{wid}", status_code=204)
    def delete(wid: int, cid: str = Depends(client), db=Depends(get_db)):
        db.delete(own(db, cid, wid))
        db.commit()

    @app.post("/workflows/{wid}/run", status_code=202)
    def run_manual(
        wid: int, payload: dict | None = None, cid: str = Depends(client), db=Depends(get_db)
    ):
        w = own(db, cid, wid)
        if not w.enabled:
            raise HTTPException(409, "Workflow is disabled")
        return ex_out(E.enqueue(db, w, "manual", payload or {}))

    @app.post("/hooks/{token}", status_code=202)
    async def webhook(token: str, request: Request, db=Depends(get_db)):
        w = db.query(D.Workflow).filter_by(token=token).first()
        if not w or w.trigger_type != "webhook" or not w.enabled:
            raise HTTPException(404, "Unknown or disabled webhook")
        try:
            payload = await request.json()
            if not isinstance(payload, dict):
                raise ValueError
        except ValueError:
            raise HTTPException(422, "Body must be a JSON object")
        return {"execution_id": E.enqueue(db, w, "webhook", payload).id, "status": "queued"}

    @app.post("/worker/tick")
    def tick(cid: str = Depends(client), db=Depends(get_db)):
        return E.tick(db, cid, **fast())

    @app.get("/cron/tick")
    def cron_tick(authorization: str = Header(default=""), db=Depends(get_db)):
        """Called by the platform scheduler (Vercel Cron). Processes ALL clients' queues; protected by CRON_SECRET when set."""
        secret = os.getenv("CRON_SECRET")
        if secret and authorization != f"Bearer {secret}":
            raise HTTPException(401, "Unauthorized")
        return E.tick(db, None, **fast())

    @app.get("/executions")
    def executions(cid: str = Depends(client), db=Depends(get_db)):
        return [
            ex_out(e)
            for e in db.query(D.Execution)
            .filter_by(client_id=cid)
            .order_by(D.Execution.id.desc())
            .limit(30)
        ]

    @app.get("/stats")
    def stats(cid: str = Depends(client), db=Depends(get_db)):
        rows = dict(
            db.query(D.Execution.status, func.count())
            .filter_by(client_id=cid)
            .group_by(D.Execution.status)
            .all()
        )
        return {"by_status": rows, "total": sum(rows.values())}

    @app.post("/demo/reset", status_code=204)
    def reset(cid: str = Depends(client), db=Depends(get_db)):
        db.query(D.Execution).filter_by(client_id=cid).delete()
        for w in db.query(D.Workflow).filter_by(client_id=cid).all():
            db.delete(w)
        db.commit()

    return app


app = create_app()
