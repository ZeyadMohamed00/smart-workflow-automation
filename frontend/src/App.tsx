import { useCallback, useEffect, useMemo, useState } from "react";
import { api, API_BASE, type Action, type Cond, type Execution, type Workflow } from "./api";
import { Badge, Bar, BarChart, Donut, Empty, Modal, Shell, Skeleton, Stat, Tabs, ToastProvider, useToast } from "./ui";

type Page = "overview" | "workflows" | "builder" | "runs" | "hooks";
const SAMPLE: Record<string, unknown> = {
  "Triage support tickets (AI classification)": { text: "I was charged twice on my invoice, please refund" },
  "Flag high-value orders": { amount: 900, customer: "acme" },
};
const OPS: Record<string, string> = { eq: "=", neq: "≠", gt: ">", lt: "<", contains: "contains" };
const kindOf = (s: string) => (s === "succeeded" ? "ok" : s === "failed" ? "bad" : s === "skipped" ? "" : "warn") as "ok" | "bad" | "" | "warn";

type Ctx = { wfs: Workflow[]; exs: Execution[]; loading: boolean; reload: () => Promise<void>; go: (p: Page) => void };

export function App() { return <ToastProvider><Main /></ToastProvider>; }

function Main() {
  const toast = useToast();
  const [page, setPage] = useState<Page>("overview");
  const [wfs, setWfs] = useState<Workflow[]>([]);
  const [exs, setExs] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    try { const [w, e] = await Promise.all([api.workflows(), api.executions()]); setWfs(w); setExs(e); }
    catch (e) { toast((e as Error).message, "bad"); } finally { setLoading(false); }
  }, []);
  useEffect(() => { reload(); }, [reload]);
  const ctx: Ctx = { wfs, exs, loading, reload, go: setPage };
  return (
    <Shell brand="Flowdesk" tagline="Workflow automation" page={page} onNav={(p) => setPage(p as Page)}
      nav={[{ id: "overview", label: "Overview", icon: "◎" }, { id: "workflows", label: "Workflows", icon: "⇢", badge: wfs.length || undefined }, { id: "builder", label: "Builder", icon: "✚" }, { id: "runs", label: "Execution history", icon: "☰", badge: exs.length || undefined }, { id: "hooks", label: "Webhooks", icon: "⌁" }]}
      footer={<div className="muted small">Synthetic data, private to your browser.</div>}>
      {page === "overview" && <Overview {...ctx} />}
      {page === "workflows" && <Workflows {...ctx} />}
      {page === "builder" && <Builder {...ctx} />}
      {page === "runs" && <Runs {...ctx} />}
      {page === "hooks" && <Hooks {...ctx} />}
    </Shell>
  );
}

async function tickMsg() { const t = await api.tick(); return `Worker processed ${t.processed} execution(s).`; }

function Flow({ w }: { w: Workflow }) {
  return (
    <div className="flow">
      <span className="node">{w.trigger_type}{w.interval_minutes ? ` / ${w.interval_minutes} min` : ""}</span><span className="arr">→</span>
      <span className="node">{w.conditions.length ? w.conditions.map((c) => `${c.field} ${OPS[c.op] ?? c.op} ${c.value}`).join(" and ") : "always"}</span>
      {w.actions.map((a, i) => <span key={i} style={{ display: "contents" }}><span className="arr">→</span><span className="node">{a.type}</span></span>)}
    </div>
  );
}

function Overview({ wfs, exs, loading, reload, go }: Ctx) {
  const toast = useToast();
  const by = useMemo(() => { const m: Record<string, number> = {}; exs.forEach((e) => { m[e.status] = (m[e.status] ?? 0) + 1; }); return m; }, [exs]);
  const done = (by.succeeded ?? 0) + (by.failed ?? 0);
  const retried = exs.filter((e) => e.steps.some((s) => (s.attempt ?? 1) > 1)).length;
  const perWf = wfs.map((w) => ({ label: w.name.slice(0, 14), value: exs.filter((e) => e.workflow_id === w.id).length }));
  return (
    <>
      <div className="page-h"><div><h1>Overview</h1><p>Triggers, conditions, actions, retries with backoff and a full execution history.</p></div>
        <div className="sp"><button className="btn" onClick={async () => { await api.reset(); await reload(); toast("Sample data reset"); }}>Reset sample data</button><button className="btn primary" onClick={async () => { toast(await tickMsg()); await reload(); }}>Run worker now</button></div></div>
      {loading ? <Skeleton lines={4} /> : (
        <>
          <div className="grid g4">
            <Stat label="Workflows" value={wfs.length} hint={`${wfs.filter((w) => w.enabled).length} enabled`} />
            <Stat label="Executions" value={exs.length} hint="latest 30" />
            <Stat label="Success rate" value={done ? `${Math.round(((by.succeeded ?? 0) / done) * 100)}%` : "n/a"} hint={`${by.failed ?? 0} failed`} />
            <Stat label="Recovered by retry" value={retried} hint="steps that needed >1 attempt" />
          </div>
          <div className="grid g2" style={{ marginTop: 16 }}>
            <div className="card"><h3>Executions by status</h3>
              {exs.length === 0 ? <Empty title="No executions yet" hint="Run a workflow to see data here."><button className="btn primary" onClick={() => go("workflows")}>Go to workflows</button></Empty>
                : <div className="row" style={{ gap: 24 }}><Donut parts={[{ label: "succeeded", value: by.succeeded ?? 0, color: "#22c55e" }, { label: "failed", value: by.failed ?? 0, color: "#ef4444" }, { label: "skipped", value: by.skipped ?? 0, color: "#94a3b8" }, { label: "queued", value: by.queued ?? 0, color: "#f59e0b" }]} />
                  <div className="col small">{Object.entries(by).map(([k, v]) => <span key={k}><Badge kind={kindOf(k)}>{k}</Badge> {v}</span>)}</div></div>}
            </div>
            <div className="card"><h3>Executions per workflow</h3>{perWf.some((p) => p.value) ? <BarChart data={perWf} /> : <p className="muted">Nothing run yet.</p>}</div>
          </div>
          <div className="card" style={{ marginTop: 16 }}><h3>Recent executions</h3>
            {exs.slice(0, 5).map((e) => <div key={e.id} className="row" style={{ justifyContent: "space-between", padding: "6px 0" }}><span>#{e.id} {wfs.find((w) => w.id === e.workflow_id)?.name ?? "workflow"}</span><span><Badge kind={kindOf(e.status)}>{e.status}</Badge> <span className="muted small">via {e.trigger}</span></span></div>)}
            {exs.length === 0 && <p className="muted">No executions yet.</p>}
          </div>
        </>
      )}
    </>
  );
}

function Workflows({ wfs, loading, reload, go }: Ctx) {
  const toast = useToast();
  const [open, setOpen] = useState<Workflow | null>(null);
  const [payload, setPayload] = useState("");
  const [busy, setBusy] = useState(false);
  const start = (w: Workflow) => { setOpen(w); setPayload(JSON.stringify(SAMPLE[w.name] ?? { text: "hello", amount: 1 }, null, 2)); };
  const run = async (w: Workflow) => {
    let body: Record<string, unknown>;
    try { body = JSON.parse(payload); if (typeof body !== "object" || Array.isArray(body) || !body) throw new Error(); } catch { toast("Payload must be a JSON object", "bad"); return; }
    setBusy(true);
    try {
      if (w.trigger_type === "webhook" && w.webhook_path) await api.hook(w.webhook_path, body); else await api.runManual(w.id, body);
      toast(await tickMsg()); setOpen(null); await reload(); go("runs");
    } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="page-h"><div><h1>Workflows</h1><p>Each workflow is a trigger, optional conditions and an ordered list of actions.</p></div><div className="sp"><button className="btn primary" onClick={() => go("builder")}>New workflow</button></div></div>
      {loading ? <Skeleton lines={4} /> : wfs.length === 0 ? <Empty title="No workflows" hint="Create one in the builder."><button className="btn primary" onClick={() => go("builder")}>Open builder</button></Empty> : (
        <div className="col">{wfs.map((w) => (
          <div key={w.id} className="card col">
            <div className="row" style={{ justifyContent: "space-between" }}><h3 style={{ margin: 0 }}>{w.name}</h3><Badge kind={w.enabled ? "ok" : ""}>{w.enabled ? "enabled" : "disabled"}</Badge></div>
            <Flow w={w} />
            <div className="row">
              <button className="btn primary" disabled={!w.enabled || w.trigger_type === "schedule"} onClick={() => start(w)}>{w.trigger_type === "webhook" ? "Send test webhook" : "Run now"}</button>
              <button className="btn" onClick={async () => { await api.toggle(w.id, !w.enabled); await reload(); }}>{w.enabled ? "Disable" : "Enable"}</button>
              <button className="btn" onClick={async () => { await api.remove(w.id); toast("Workflow deleted"); await reload(); }}>Delete</button>
              {w.trigger_type === "schedule" && <span className="muted small">Fires on worker ticks (daily cron on the free tier).</span>}
            </div>
          </div>))}</div>
      )}
      {open && (
        <Modal title={`${open.trigger_type === "webhook" ? "Send test webhook" : "Run"}: ${open.name}`} onClose={() => setOpen(null)}>
          <div className="col"><label className="f">Payload (JSON)<textarea aria-label="Payload" className="code" value={payload} onChange={(e) => setPayload(e.target.value)} /></label>
            <p className="muted small">Conditions are evaluated against this payload. Try changing amount to 100 to see the run get skipped.</p>
            <div className="row"><button className="btn primary" disabled={busy} onClick={() => run(open)}>{busy ? "Running..." : "Send and run worker"}</button><button className="btn" onClick={() => setOpen(null)}>Cancel</button></div></div>
        </Modal>
      )}
    </>
  );
}

const TEMPLATES: { name: string; trigger: string; conds: Cond[]; acts: Action[] }[] = [
  { name: "Escalate large orders", trigger: "webhook", conds: [{ field: "amount", op: "gt", value: 500 }], acts: [{ type: "set_field", field: "priority", value: "high" }, { type: "notify", message: "Large order" }] },
  { name: "Classify inbound tickets", trigger: "webhook", conds: [], acts: [{ type: "classify", field: "text" }, { type: "log", message: "classified" }] },
  { name: "Retry test (flaky dependency)", trigger: "manual", conds: [], acts: [{ type: "flaky", fail_times: 2 }, { type: "log", message: "done after retries" }] },
  { name: "Hourly digest", trigger: "schedule", conds: [], acts: [{ type: "log", message: "digest" }, { type: "notify", message: "digest sent" }] },
];

function Builder({ reload, go }: Ctx) {
  const toast = useToast();
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("webhook");
  const [interval, setIntervalM] = useState(60);
  const [conds, setConds] = useState<Cond[]>([]);
  const [acts, setActs] = useState<Action[]>([{ type: "log", message: "hello" }]);
  const [busy, setBusy] = useState(false);
  const loadT = (t: (typeof TEMPLATES)[number]) => { setName(t.name); setTrigger(t.trigger); setConds(t.conds); setActs(t.acts); };
  const upC = (i: number, p: Partial<Cond>) => setConds(conds.map((c, j) => (j === i ? { ...c, ...p } : c)));
  const upA = (i: number, p: Partial<Action>) => setActs(acts.map((a, j) => (j === i ? { ...a, ...p } : a)));
  const move = (i: number, d: number) => { const n = [...acts]; const j = i + d; if (j < 0 || j >= n.length) return; [n[i], n[j]] = [n[j], n[i]]; setActs(n); };
  const preview: Workflow = { id: 0, name, trigger_type: trigger, interval_minutes: trigger === "schedule" ? interval : null, conditions: conds, actions: acts, enabled: true, webhook_path: null };
  const valid = name.trim() && acts.length > 0 && conds.every((c) => c.field.trim() && String(c.value) !== "");
  const save = async () => {
    setBusy(true);
    try {
      const conditions = conds.map((c) => ({ ...c, value: c.op === "gt" || c.op === "lt" || (c.value !== "" && !isNaN(Number(c.value)) && c.op !== "contains") ? Number(c.value) : c.value }));
      await api.create({ name: name.trim(), trigger_type: trigger, interval_minutes: trigger === "schedule" ? interval : undefined, conditions, actions: acts });
      toast("Workflow created"); await reload(); go("workflows");
    } catch (e) { toast((e as Error).message, "bad"); } finally { setBusy(false); }
  };
  return (
    <>
      <div className="page-h"><div><h1>Workflow builder</h1><p>Start from a template or build from scratch.</p></div></div>
      <div className="row" style={{ marginBottom: 12 }}>{TEMPLATES.map((t) => <button key={t.name} className="chip" onClick={() => loadT(t)}>{t.name}</button>)}</div>
      <div className="grid g-main">
        <div className="col">
          <div className="card col"><h3 style={{ margin: 0 }}>1. Trigger</h3>
            <label className="f">Name<input aria-label="Name" placeholder="e.g. Escalate large orders" value={name} onChange={(e) => setName(e.target.value)} /></label>
            <div className="row"><label className="f">Trigger type<select aria-label="Trigger" value={trigger} onChange={(e) => setTrigger(e.target.value)}><option>webhook</option><option>manual</option><option>schedule</option></select></label>
              {trigger === "schedule" && <label className="f">Every (minutes)<input type="number" min={1} max={10080} value={interval} onChange={(e) => setIntervalM(Number(e.target.value))} /></label>}</div></div>
          <div className="card col"><div className="row" style={{ justifyContent: "space-between" }}><h3 style={{ margin: 0 }}>2. Conditions</h3><button className="btn" onClick={() => setConds([...conds, { field: "", op: "gt", value: "" }])}>Add condition</button></div>
            {conds.length === 0 && <p className="muted small">No conditions: the workflow always runs. All conditions must match.</p>}
            {conds.map((c, i) => <div key={i} className="row"><input aria-label={`Field ${i + 1}`} placeholder="field" value={c.field} onChange={(e) => upC(i, { field: e.target.value })} />
              <select value={c.op} onChange={(e) => upC(i, { op: e.target.value })}>{Object.entries(OPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <input aria-label={`Value ${i + 1}`} placeholder="value" value={String(c.value)} onChange={(e) => upC(i, { value: e.target.value })} /><button className="btn" onClick={() => setConds(conds.filter((_, j) => j !== i))}>Remove</button></div>)}</div>
          <div className="card col"><div className="row" style={{ justifyContent: "space-between" }}><h3 style={{ margin: 0 }}>3. Actions (run in order)</h3><button className="btn" onClick={() => setActs([...acts, { type: "log", message: "" }])}>Add action</button></div>
            {acts.map((a, i) => <div key={i} className="row">
              <span className="muted">{i + 1}.</span>
              <select aria-label={`Action ${i + 1}`} value={a.type} onChange={(e) => upA(i, { type: e.target.value, field: e.target.value === "classify" ? "text" : e.target.value === "set_field" ? "priority" : undefined, value: e.target.value === "set_field" ? "high" : undefined, message: e.target.value === "log" || e.target.value === "notify" ? "" : undefined, fail_times: e.target.value === "flaky" ? 2 : undefined })}>
                {["log", "notify", "classify", "set_field", "flaky"].map((t) => <option key={t}>{t}</option>)}</select>
              {(a.type === "log" || a.type === "notify") && <input placeholder="message" value={a.message ?? ""} onChange={(e) => upA(i, { message: e.target.value })} />}
              {a.type === "classify" && <input placeholder="payload field to classify" value={a.field ?? ""} onChange={(e) => upA(i, { field: e.target.value })} />}
              {a.type === "set_field" && <><input placeholder="field" value={a.field ?? ""} onChange={(e) => upA(i, { field: e.target.value })} /><input placeholder="value" value={String(a.value ?? "")} onChange={(e) => upA(i, { value: e.target.value })} /></>}
              {a.type === "flaky" && <label className="muted small">fails first <input type="number" min={0} max={5} style={{ width: 60 }} value={a.fail_times ?? 2} onChange={(e) => upA(i, { fail_times: Number(e.target.value) })} /> times</label>}
              <button className="btn" aria-label="Move up" onClick={() => move(i, -1)}>↑</button><button className="btn" aria-label="Move down" onClick={() => move(i, 1)}>↓</button>
              <button className="btn" onClick={() => setActs(acts.filter((_, j) => j !== i))}>Remove</button></div>)}
            <p className="muted small">classify = keyword-score classifier (billing, bug, feature_request, other), not an LLM. notify only records a line. flaky fails N times to show retry with backoff (max 3 attempts).</p></div>
        </div>
        <div className="col"><div className="card col"><h3 style={{ margin: 0 }}>Preview</h3><strong>{name || "Untitled workflow"}</strong><Flow w={preview} />
          <button className="btn primary" disabled={!valid || busy} onClick={save}>Create</button></div></div>
      </div>
    </>
  );
}

function Runs({ wfs, exs, loading, reload }: Ctx) {
  const toast = useToast();
  const [f, setF] = useState<"all" | "succeeded" | "failed" | "skipped" | "queued">("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<Execution | null>(null);
  const shown = exs.filter((e) => (f === "all" || e.status === f) && (!q || JSON.stringify(e).toLowerCase().includes(q.toLowerCase()) || (wfs.find((w) => w.id === e.workflow_id)?.name ?? "").toLowerCase().includes(q.toLowerCase())));
  return (
    <>
      <div className="page-h"><div><h1>Execution history</h1><p>Every step and every retry attempt is stored.</p></div>
        <div className="sp"><button className="btn primary" onClick={async () => { try { toast(await tickMsg()); await reload(); } catch (e) { toast((e as Error).message, "bad"); } }}>Run worker now</button></div></div>
      <div className="row" style={{ marginBottom: 12 }}><Tabs tabs={(["all", "succeeded", "failed", "skipped", "queued"] as const).map((t) => ({ id: t, label: t }))} value={f} onChange={setF} />
        <input aria-label="Search" placeholder="Search runs" value={q} onChange={(e) => setQ(e.target.value)} style={{ marginLeft: "auto" }} /></div>
      {loading ? <Skeleton lines={4} /> : shown.length === 0 ? <Empty title="Nothing here" hint="Send a test webhook from the Workflows page." /> : (
        <div className="card" style={{ overflowX: "auto" }}><table className="t"><thead><tr><th>#</th><th>Workflow</th><th>Status</th><th>Trigger</th><th>Steps</th><th>Attempts</th></tr></thead><tbody>
          {shown.map((e) => <tr key={e.id} onClick={() => setSel(e)} style={{ cursor: "pointer" }}><td>#{e.id}</td><td>{wfs.find((w) => w.id === e.workflow_id)?.name ?? "workflow"}</td><td><Badge kind={kindOf(e.status)}>{e.status}</Badge></td><td className="muted">{e.trigger}</td><td>{e.steps.filter((s) => s.ok).length}/{e.steps.length}</td><td>{e.steps.length ? Math.max(...e.steps.map((s) => s.attempt ?? 1)) : 0}</td></tr>)}
        </tbody></table></div>
      )}
      {sel && (
        <Modal drawer title={`Execution #${sel.id}`} onClose={() => setSel(null)}>
          <div className="col"><div className="row"><Badge kind={kindOf(sel.status)}>{sel.status}</Badge><span className="muted">via {sel.trigger}</span></div>
            <div><div className="muted small">Payload</div><pre className="code">{JSON.stringify(sel.payload, null, 2)}</pre></div>
            <div><div className="muted small">Step timeline</div>
              {sel.steps.length === 0 ? <p className="muted">No steps ran (conditions did not match or still queued).</p> : <ul className="tl">{sel.steps.map((s, i) => <li key={i} className={s.ok ? "" : "bad"}><strong>{s.step}</strong> {s.attempt && s.attempt > 1 ? <Badge kind="warn">attempt {s.attempt}</Badge> : null} <Badge kind={s.ok ? "ok" : "bad"}>{s.ok ? "ok" : "FAIL"}</Badge><div className="muted small">{s.detail}</div></li>)}</ul>}</div>
            {sel.error && <div className="err">{sel.error}</div>}</div>
        </Modal>
      )}
    </>
  );
}

function Hooks({ wfs }: Ctx) {
  const toast = useToast();
  const hooks = wfs.filter((w) => w.webhook_path);
  const base = API_BASE || "https://your-api-host";
  return (
    <>
      <div className="page-h"><div><h1>Webhooks</h1><p>Each webhook workflow gets its own URL with a random token. POST a JSON object to it.</p></div></div>
      {hooks.length === 0 ? <Empty title="No webhook workflows" hint="Create a workflow with a webhook trigger." /> : (
        <div className="col">{hooks.map((w) => { const cmd = `curl -X POST ${base}${w.webhook_path} -H 'Content-Type: application/json' -d '${JSON.stringify(SAMPLE[w.name] ?? { text: "hello", amount: 1 })}'`; return (
          <div key={w.id} className="card col"><strong>{w.name}</strong><pre className="code">{cmd}</pre>
            <div className="row"><button className="btn" onClick={() => { navigator.clipboard?.writeText(cmd); toast("Copied"); }}>Copy curl</button><span className="muted small">Executions are queued; run the worker (or use the UI button) to process them.</span></div></div>); })}</div>
      )}
      <p className="muted small" style={{ marginTop: 12 }}>No signature verification or per-user login in this app. Visitors are separated by a browser id only.</p>
    </>
  );
}
