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

const box: React.CSSProperties = { maxWidth: 380, margin: "8vh auto", padding: 24, borderRadius: 14, border: "1px solid rgba(128,128,128,.35)", background: "var(--card, var(--surface, #fff))", color: "inherit", display: "grid", gap: 12 };
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
        <div style={{ position: "fixed", top: 8, right: 8, zIndex: 1000, display: "flex", gap: 8, alignItems: "center", fontSize: 12, padding: "4px 8px", borderRadius: 999, border: "1px solid rgba(128,128,128,.4)", background: "var(--card, var(--surface, #fff))", color: "inherit" }}>
          {token ? <span>{user?.name || user?.email || "Signed in"}</span> : <span>Guest demo (sample data)</span>}
          <button style={{ ...ghost, padding: "2px 10px", fontSize: 12 }} onClick={logout}>{token ? "Log out" : "Sign in"}</button>
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
    <form style={box} onSubmit={submit} aria-label="Account">
      <h2 style={{ margin: 0 }}>{title}</h2>
      <p style={{ margin: 0, fontSize: 13, opacity: 0.75 }}>{mode === "login" ? "Log in to your account." : "Create an account. Your data is saved to your own workspace."}</p>
      {mode === "register" && <label style={field}>Name<input style={input} aria-label="Name" value={name} onChange={(e) => setName(e.target.value)} /></label>}
      <label style={field}>Email<input style={input} aria-label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} /></label>
      <label style={field}>Password<input style={input} aria-label="Password" type="password" autoComplete={mode === "login" ? "current-password" : "new-password"} placeholder="8+ characters" required minLength={mode === "register" ? 8 : 1} value={password} onChange={(e) => setPassword(e.target.value)} /></label>
      {error && <p role="alert" style={{ margin: 0, color: "#dc2626", fontSize: 13 }}>{error}</p>}
      <button style={primary} type="submit" disabled={busy}>{busy ? "Please wait..." : mode === "login" ? "Log in" : "Create account"}</button>
      <button type="button" style={ghost} onClick={() => { setMode(mode === "login" ? "register" : "login"); setError(""); }}>{mode === "login" ? "New here? Create an account" : "Have an account? Log in"}</button>
      <button type="button" style={{ ...ghost, border: 0, opacity: 0.8 }} onClick={() => { sessionStorage.setItem(GUEST_KEY, "1"); setGuest(true); }}>Continue as guest (demo data)</button>
    </form>
  );
}
