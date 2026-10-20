import { useState, type FormEvent, type ReactNode } from "react";
import { api, ApiError, type Me } from "./api.js";

export function SignIn({ onSignedIn }: { onSignedIn: () => void }): ReactNode {
  const [mode, setMode] = useState<"login" | "signup">("login");
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api<Me>(mode === "login" ? "/api/login" : "/api/signup", { body: mode === "login" ? { email, password } : { email, name, password } });
      onSignedIn();
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "the server did not answer");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <h1>coelho notes</h1>
      <p className="muted">Collaborative pages, stored validated.</p>
      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={mode === "login"} onClick={() => setMode("login")}>
          Sign in
        </button>
        <button type="button" role="tab" aria-selected={mode === "signup"} onClick={() => setMode("signup")}>
          Create an account
        </button>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        {mode === "signup" ? (
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} required maxLength={60} autoComplete="name" />
          </label>
        ) : null}
        <label>
          Email
          <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            required
            minLength={mode === "signup" ? 8 : undefined}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
          />
        </label>
        {error === null ? null : (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {mode === "login" ? "Sign in" : "Create the account"}
        </button>
        {mode === "signup" ? <p className="muted small">The first account is the admin. Everyone after reads until an admin lets them edit.</p> : null}
      </form>
    </div>
  );
}

interface Person {
  id: string;
  name: string;
  email: string;
  role: Me["role"];
}

/** For admins: who has an account, and what they may do. */
export function People({ me, onClose }: { me: Me; onClose: () => void }): ReactNode {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (people === null && error === null) {
    api<Person[]>("/api/users").then(setPeople, (caught: Error) => setError(caught.message));
  }
  const change = async (person: Person, role: Me["role"]): Promise<void> => {
    setError(null);
    try {
      const updated = await api<Person>(`/api/users/${person.id}`, { method: "PATCH", body: { role } });
      setPeople((all) => all?.map((one) => (one.id === updated.id ? updated : one)) ?? null);
    } catch (caught) {
      setError((caught as Error).message);
    }
  };
  return (
    <aside className="people">
      <header>
        <h2>People</h2>
        <button type="button" onClick={onClose} aria-label="Close">
          ×
        </button>
      </header>
      {error === null ? null : (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <ul>
        {(people ?? []).map((person) => (
          <li key={person.id}>
            <span>
              {person.name} {person.id === me.id ? <small>(you)</small> : null}
              <br />
              <small className="muted">{person.email}</small>
            </span>
            <select value={person.role} onChange={(event) => void change(person, event.target.value as Me["role"])} aria-label={`Role of ${person.name}`}>
              <option value="admin">admin</option>
              <option value="editor">editor</option>
              <option value="reader">reader</option>
            </select>
          </li>
        ))}
      </ul>
      <p className="muted small">A new role applies at once: their pages reconnect under it.</p>
    </aside>
  );
}
