import { useEffect, useState } from "react";
import { api, type Execution, type Workflow } from "./api";

const SAMPLE_PAYLOADS: Record<string, unknown> = {
  "Triage support tickets (AI classification)": { text: "I was charged twice on my invoice, please refund" },
  "Flag high-value orders": { amount: 900, customer: "demo" },
};

export function App() {
  const [wfs, setWfs] = useState<Workflow[]>([]);
  const [exs, setExs] = useState<Execution[]>([]);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [name, setName] = useState("");
  const [trigger, setTrigger] = useState("manual");
  const [cond, setCond] = useState("");
  const [acts, setActs] = useState<string[]>(["log"]);

  const load = async () => { setWfs(await api.workflows()); setExs(await api.executions()); };
  const run = async (fn: () => Promise<void>) => { setError(""); try { await fn(); await load(); } catch (e) { setError((e as Error).message); } };
  useEffect(() => { run(async () => undefined); }, []);

  const trig = (w: Workflow) => run(async () => {
    if (w.trigger_type === "webhook" && w.webhook_path) await api.hook(w.webhook_path, SAMPLE_PAYLOADS[w.name] ?? { text: "hello", amount: 1 });
    else await api.runManual(w.id);
    const t = await api.tick(); setMsg(`Worker processed ${t.processed} execution(s).`);
  });

  const create = () => run(async () => {
    const m = cond.match(/^(\w+)\s*(>|<|=|contains)\s*(.+)$/);
    const conditions = m ? [{ field: m[1], op: { ">": "gt", "<": "lt", "=": "eq", contains: "contains" }[m[2]], value: isNaN(Number(m[3])) ? m[3] : Number(m[3]) }] : [];
    const actions = acts.map((a) => a === "classify" ? { type: "classify", field: "text" } : a === "priority" ? { type: "set_field", field: "priority", value: "high" } : a === "flaky" ? { type: "flaky", fail_times: 2 } : { type: a, message: "from builder" });
    await api.create({ name, trigger_type: trigger, interval_minutes: trigger === "schedule" ? 60 : undefined, conditions, actions });
    setName(""); setCond("");
  });

  return (
    <div className="wrap">
      <h1>Smart Workflow Automation</h1>
      <p className="muted">Triggers, conditions, actions, retries and execution history. Synthetic demo data, private to your browser. Classification is keyword-based (no LLM key configured).</p>
      {error && <p role="alert" className="err">{error}</p>}
      {msg && <p className="muted">{msg}</p>}
      <div className="grid">
        <section>
          <h3>Workflows</h3>
          {wfs.map((w) => (
            <div key={w.id} className="card">
              <strong>{w.name}</strong> <span className="tag">{w.trigger_type}{w.interval_minutes ? ` / ${w.interval_minutes} min` : ""}</span>
              <div className="muted">if {w.conditions.length ? w.conditions.map((c) => `${c.field} ${c.op} ${c.value}`).join(" and ") : "always"} then {w.actions.map((a) => a.type).join(" > ")}</div>
              <button onClick={() => trig(w)} disabled={!w.enabled || w.trigger_type === "schedule"}>{w.trigger_type === "webhook" ? "Send test webhook" : "Run now"}</button>
              <button onClick={() => run(async () => { await api.toggle(w.id, !w.enabled); })}>{w.enabled ? "Disable" : "Enable"}</button>
              <button className="link" onClick={() => run(async () => { await api.remove(w.id); })}>delete</button>
            </div>
          ))}
          <h3>New workflow</h3>
          <input aria-label="Name" placeholder="name" value={name} onChange={(e) => setName(e.target.value)} />
          <select aria-label="Trigger" value={trigger} onChange={(e) => setTrigger(e.target.value)}><option>manual</option><option>webhook</option><option>schedule</option></select>
          <input aria-label="Condition" placeholder='condition, e.g. amount > 500' value={cond} onChange={(e) => setCond(e.target.value)} />
          <div>{["log", "notify", "classify", "priority", "flaky"].map((a) => (
            <label key={a} className="chk"><input type="checkbox" checked={acts.includes(a)} onChange={(e) => setActs(e.target.checked ? [...acts, a] : acts.filter((x) => x !== a))} />{a}</label>))}</div>
          <button disabled={!name || acts.length === 0} onClick={create}>Create</button>
        </section>
        <section>
          <h3>Execution history <button onClick={() => run(async () => { const t = await api.tick(); setMsg(`Worker: scheduled ${t.scheduled}, processed ${t.processed}.`); })}>Run worker now</button></h3>
          {exs.length === 0 && <p className="muted">Nothing yet. Click "Send test webhook" on a workflow.</p>}
          {exs.map((e) => (
            <div key={e.id} className="card">
              <strong>#{e.id}</strong> <span className={"st " + e.status}>{e.status}</span> <span className="muted">via {e.trigger}</span>
              <ul className="steps">{e.steps.map((s, i) => <li key={i} className={s.ok ? "" : "bad"}>{s.ok ? "ok" : "FAIL"} {s.step}{s.attempt && s.attempt > 1 ? ` (attempt ${s.attempt})` : ""}: {s.detail}</li>)}</ul>
              {e.error && <div className="err">{e.error}</div>}
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
