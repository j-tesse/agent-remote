import { useEffect, useState, type FormEvent } from "react";
import {
  changePassword,
  clearSudoPassword,
  fetchSudoStatus,
  saveSudoPassword,
} from "./auth";

/** Gear button in the sidebar header; opens the settings page. */
export function SettingsButton({
  active,
  onOpen,
}: {
  active: boolean;
  onOpen: () => void;
}) {
  return (
    <button
      className={`settings-button ${active ? "active" : ""}`}
      aria-label="Settings"
      aria-current={active ? "page" : undefined}
      title="Settings"
      onClick={onOpen}
    >
      <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
        <path
          fill="currentColor"
          d="M19.14 12.94a7.07 7.07 0 0 0 .05-.94 7.07 7.07 0 0 0-.05-.94l2.03-1.58a.5.5 0 0 0 .12-.64l-1.92-3.32a.5.5 0 0 0-.6-.22l-2.39.96a7.03 7.03 0 0 0-1.63-.94l-.36-2.54a.5.5 0 0 0-.5-.42h-3.84a.5.5 0 0 0-.5.42l-.36 2.54c-.59.24-1.13.56-1.63.94l-2.39-.96a.5.5 0 0 0-.6.22L2.65 8.84a.5.5 0 0 0 .12.64l2.03 1.58a7.07 7.07 0 0 0 0 1.88l-2.03 1.58a.5.5 0 0 0-.12.64l1.92 3.32c.13.22.39.3.6.22l2.39-.96c.5.38 1.04.7 1.63.94l.36 2.54c.05.24.26.42.5.42h3.84c.24 0 .45-.18.5-.42l.36-2.54c.59-.24 1.13-.56 1.63-.94l2.39.96c.22.08.47 0 .6-.22l1.92-3.32a.5.5 0 0 0-.12-.64l-2.03-1.58ZM12 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7Z"
        />
      </svg>
    </button>
  );
}

/** Full-page settings view (shares the system page's shell). */
export function SettingsPage({
  username,
  onLogout,
}: {
  username: string;
  onLogout: () => void;
}) {
  return (
    <div className="system-view">
      <div className="folder-header">
        <span className="folder-header-path">Settings</span>
      </div>
      <div className="settings-page">
        <section className="system-card">
          <label className="field-label">Account</label>
          <div className="settings-account">
            <span>
              Signed in as <strong>{username}</strong>
            </span>
            <button className="settings-logout" onClick={onLogout}>
              Log out
            </button>
          </div>
        </section>
        <section className="system-card">
          <label className="field-label">Change password</label>
          <ChangePasswordForm username={username} />
        </section>
        <section className="system-card">
          <label className="field-label">Sudo password</label>
          <SudoPasswordForm />
        </section>
      </div>
    </div>
  );
}

function ChangePasswordForm({ username }: { username: string }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setDone(null);
    if (next !== confirm) {
      setError("New passwords don't match.");
      return;
    }
    if (next === current) {
      setError("New password must differ from the current one.");
      return;
    }
    setBusy(true);
    try {
      const res = await changePassword(current, next);
      if (res.ok) {
        setDone(res.message ?? "Password changed.");
        setCurrent("");
        setNext("");
        setConfirm("");
      } else setError(res.message ?? "Couldn't change password.");
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="settings-form" onSubmit={submit}>
      {/* Hidden username lets password managers file the new password. */}
      <input type="text" autoComplete="username" hidden readOnly value={username} />
      <input
        className="login-input"
        type="password"
        placeholder="Current password"
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <input
        className="login-input"
        type="password"
        placeholder="New password"
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <input
        className="login-input"
        type="password"
        placeholder="Confirm new password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      {error && <p className="login-error">{error}</p>}
      {done && <p className="login-message">{done}</p>}
      <button
        className="login-submit"
        type="submit"
        disabled={busy || !current || !next || !confirm}
      >
        {busy ? "Changing…" : "Change password"}
      </button>
    </form>
  );
}

/** Write-only: the stored value is never shown or prefilled, only whether one is set. */
function SudoPasswordForm() {
  const [set, setSet] = useState<boolean | null>(null);
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetchSudoStatus()
      .then((r) => setSet(r.ok ? !!r.set : null))
      .catch(() => setSet(null));
  }, []);

  const run = async (op: () => ReturnType<typeof fetchSudoStatus>, ok: string) => {
    setError(null);
    setDone(null);
    setBusy(true);
    try {
      const res = await op();
      if (res.ok) {
        setSet(!!res.set);
        setValue("");
        setDone(ok);
      } else setError(res.message ?? "Couldn't update the sudo password.");
    } catch {
      setError("Couldn't reach the server.");
    } finally {
      setBusy(false);
    }
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void run(() => saveSudoPassword(value), "Sudo password saved.");
  };

  return (
    <form className="settings-form" onSubmit={submit}>
      <p className="settings-note">
        {set === null ? "…" : set ? "A sudo password is stored." : "No sudo password stored."}{" "}
        Terminals offer to fill it when <code>sudo</code> asks. Stored encrypted; never shown.
      </p>
      <input
        className="login-input"
        type="password"
        placeholder={set ? "Replace sudo password" : "Sudo password"}
        autoComplete="off"
        data-1p-ignore
        data-lpignore="true"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      {error && <p className="login-error">{error}</p>}
      {done && <p className="login-message">{done}</p>}
      <div className="settings-actions">
        <button className="login-submit" type="submit" disabled={busy || !value}>
          {set ? "Replace" : "Save"}
        </button>
        {set && (
          <button
            type="button"
            className="settings-logout"
            disabled={busy}
            onClick={() => void run(clearSudoPassword, "Sudo password removed.")}
          >
            Remove
          </button>
        )}
      </div>
    </form>
  );
}
