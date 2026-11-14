// Thin fetch wrappers around the server auth routes. The session lives in an
// HttpOnly cookie the browser sends automatically, so there is no token to
// store here — we only learn the current username from /api/me.

export interface AuthResult {
  ok: boolean;
  message?: string;
  username?: string;
}

async function postAuth(path: string, body: object): Promise<AuthResult> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, message: data.message, username: data.username };
}

export async function fetchMe(): Promise<string | null> {
  const res = await fetch("/api/me");
  if (!res.ok) return null;
  const data = await res.json().catch(() => ({}));
  return typeof data.username === "string" ? data.username : null;
}

/** Whether web signup is offered; "closed" on any failure (the safe reading). */
export async function fetchRegistration(): Promise<"open" | "closed"> {
  try {
    const res = await fetch("/api/auth-info");
    const data = await res.json();
    return data.registration === "open" ? "open" : "closed";
  } catch {
    return "closed";
  }
}

export function login(username: string, password: string): Promise<AuthResult> {
  return postAuth("/api/login", { username, password });
}

export function register(
  username: string,
  password: string,
): Promise<AuthResult> {
  return postAuth("/api/register", { username, password });
}

export async function logout(): Promise<void> {
  await fetch("/api/logout", { method: "POST" });
}

export function changePassword(
  current: string,
  next: string,
): Promise<AuthResult> {
  return postAuth("/api/change-password", { current, next });
}

// Stored sudo password: write-only, the server only ever says whether it's set.
async function sudoRequest(method: string, body?: object): Promise<AuthResult & { set?: boolean }> {
  const res = await fetch("/api/sudo-password", {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, message: data.message, set: data.set === true };
}

export const fetchSudoStatus = () => sudoRequest("GET");
export const saveSudoPassword = (password: string) => sudoRequest("PUT", { password });
export const clearSudoPassword = () => sudoRequest("DELETE");
