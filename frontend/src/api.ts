export const API_BASE: string = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? "/api" : "");

export function clientId(): string {
  let id = localStorage.getItem("wf_client_id");
  if (!id) {
    id = (crypto.randomUUID?.() ?? String(Date.now()) + Math.random().toString(16).slice(2)).replace(/[^a-zA-Z0-9-]/g, "");
    localStorage.setItem("wf_client_id", id);
  }
  return id;
}

async function req<T>(path: string, method = "GET", body?: unknown, auth = true): Promise<T> {
  const headers: Record<string, string> = {};
  if (auth) headers["X-Client-Id"] = clientId();
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(API_BASE + path, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    let msg = res.statusText;
    try { const j = await res.json(); msg = typeof j.detail === "string" ? j.detail : JSON.stringify(j.detail); } catch { /* keep */ }
    throw new Error(msg);
  }
  return res.status === 204 ? (undefined as T) : res.json();
}

export type Cond = { field: string; op: string; value: string | number };
export type Action = { type: string; field?: string; value?: string | number; message?: string; fail_times?: number };
export type Workflow = { id: number; name: string; trigger_type: string; interval_minutes: number | null; conditions: Cond[]; actions: Action[]; enabled: boolean; webhook_path: string | null };
export type Step = { step: string; ok: boolean; attempt?: number; detail: string };
export type Execution = { id: number; workflow_id: number; trigger: string; status: string; payload: Record<string, unknown>; steps: Step[]; error: string };

export const api = {
  workflows: () => req<Workflow[]>("/workflows"),
  create: (w: unknown) => req<Workflow>("/workflows", "POST", w),
  remove: (id: number) => req<void>(`/workflows/${id}`, "DELETE"),
  toggle: (id: number, enabled: boolean) => req<Workflow>(`/workflows/${id}?enabled=${enabled}`, "PATCH", {}),
  runManual: (id: number, payload: unknown = {}) => req<Execution>(`/workflows/${id}/run`, "POST", payload),
  hook: (path: string, payload: unknown) => req<{ execution_id: number }>(path, "POST", payload, false),
  tick: () => req<{ scheduled: number; processed: number }>("/worker/tick", "POST", {}),
  executions: () => req<Execution[]>("/executions"),
  stats: () => req<{ by_status: Record<string, number>; total: number }>("/stats"),
  reset: () => req<void>("/demo/reset", "POST", {}),
};
