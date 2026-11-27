import { useState, type FormEvent, type ReactNode } from "react";
import { API_BASE } from "./api";

const TOKEN_KEY = "auth_token";
const USER_KEY = "auth_user";
const GUEST_KEY = "auth_guest";

export type AuthUser = { id: number; email: string; name: string };

export const getToken = (): string | null => localStorage.getItem(TOKEN_KEY);
export const authHeaders = (): Record<string, string> => {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
};
const getUser = (): AuthUser | null => {
  try { return JSON.parse(localStorage.getItem(USER_KEY) || "null"); } catch { return null; }
};
export function logout() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
  sessionStorage.removeItem(GUEST_KEY);
  location.reload();
}

async function authCall(path: string, body: unknown): Promise<{ access_token: string; user: AuthUser }> {
  const res = await fetch(API_BASE + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) {
    let msg = res.statusText;
    try {
      const j = await res.json();
      msg = typeof j.detail === "string" ? j.detail : Array.isArray(j.detail) ? j.detail.map((d: { msg: string }) => d.msg).join(", ") : msg;
    } catch { /* keep status text */ }
    throw new Error(msg);
  }
  return res.json();
}

const _box: React.CSSProperties = { maxWidth: 380, margin: "8vh auto", padding: 24, borderRadius: 14, border: "1px solid rgba(128,128,128,.35)", background: "var(--card, var(--surface, #fff))", color: "inherit", display: "grid", gap: 12 };
const field: React.CSSProperties = { display: "grid", gap: 4, fontSize: 13, textAlign: "left" };
const input: React.CSSProperties = { padding: "9px 10px", borderRadius: 8, border: "1px solid rgba(128,128,128,.5)", background: "transparent", color: "inherit", font: "inherit" };
const primary: React.CSSProperties = { padding: "10px 14px", borderRadius: 8, border: 0, background: "#4f46e5", color: "#fff", font: "inherit", cursor: "pointer" };
const ghost: React.CSSProperties = { padding: "8px 12px", borderRadius: 8, border: "1px solid rgba(128,128,128,.5)", background: "transparent", color: "inherit", font: "inherit", cursor: "pointer" };

export function AuthGate({ title, children }: { title: string; children: ReactNode }) {
  const [token, setTok] = useState(getToken());
  const [guest, setGuest] = useState(sessionStorage.getItem(GUEST_KEY) === "1");
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  if (token || guest) {
    const user = getUser();
    return (
      <>
        <div className="authpill">
          {token ? <span>{user?.name || user?.email || "Signed in"}</span> : <span>Guest session</span>}
          <button className="btn sm" onClick={logout}>{token ? "Log out" : "Sign in"}</button>
        </div>
        {children}
      </>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(""); setBusy(true);
    try {
      const out = mode === "login"
        ? await authCall("/auth/login", { email, password })
        : await authCall("/auth/register", { email, password, name });
      localStorage.setItem(TOKEN_KEY, out.access_token);
      localStorage.setItem(USER_KEY, JSON.stringify(out.user));
      setTok(out.access_token);
    } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  }

  return (
    <div className="lp">
      <section className="lp-l">
        <div className="brand"><span className="logo"><img src="/icon.svg" alt="" /></span>{title}</div>
        <div>
          <h1>Automate the routine, <em>keep the audit trail.</em></h1>
          <p className="lede">Define a trigger, add conditions and actions, and every run is queued, retried with backoff and recorded step by step in an execution history.</p>
        </div>
        <div className="qa" aria-hidden>
          <div className="q">Webhook: order over the high-value threshold</div>
          <div className="a">Rule matched. Flagged for review, 3 steps logged.<br /><small>execution history, step timeline</small></div>
        </div>
      </section>
      <section className="lp-r">
        <div className="col authbox" style={{ gap: 14 }}>
          <button type="button" className="btn primary" onClick={() => { sessionStorage.setItem(GUEST_KEY, "1"); setGuest(true); }}>Explore without signing up</button>
          <div className="or">or</div>
          <form className="col" onSubmit={submit} aria-label="Account">
            <h2>{mode === "login" ? "Log in" : "Create an account"}</h2>
            {mode === "register" && <label className="f">Name<input aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} /></label>}
            <label className="f">Email<input aria-label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
            <label className="f">Password<input aria-label="Password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="8+ characters" required minLength={mode === "register" ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
            {error && <p role="alert" className="err">{error}</p>}
            <button className="btn" type="submit" disabled={busy}>{busy ? "Please wait..." : mode === "login" ? "Log in" : "Create account"}</button>
            <button type="button" className="btn ghost sm" onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "New here? Create an account" : "Have an account? Log in"}</button>
          </form>
        </div>
      </section>
    </div>
  );
}
