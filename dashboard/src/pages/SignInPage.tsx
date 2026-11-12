import { useState, type FormEvent } from "react";
import { UnofficialBadge } from "../components/UnofficialBadge";

type Props = { onSignIn: (username: string, password: string) => Promise<void> };

export function SignInPage({ onSignIn }: Props) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [step, setStep] = useState<"username" | "password">("username");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (step === "username") {
      if (!username.trim()) return setError("Enter your username.");
      setError("");
      return setStep("password");
    }
    if (!password) return setError("Enter your password.");
    setBusy(true);
    try {
      await onSignIn(username.trim(), password);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Sign-in failed.");
      setPassword("");
      setBusy(false);
    }
  };

  return (
    <main className="signin">
      <div className="signin-stripe" aria-hidden="true" />
      <section className="signin-hero">
        <UnofficialBadge large />
        <p className="signin-headline">
          Manage
          <br />
          your
          <br />
          users
        </p>
        <p className="signin-wordmark">
          <span>V</span>User Manager
        </p>
      </section>
      <form
        className="signin-form"
        onSubmit={(e) => void submit(e)}
        aria-label="Sign in"
        noValidate
      >
        <h1>Sign in</h1>
        <p className="signin-warning">
          Un-official tool. Not a Veracode product or login page. Use your app username and
          password, never your Veracode password.
        </p>
        {step === "username" ? (
          <label className="signin-field">
            Username
            <input
              className="signin-input"
              autoComplete="username"
              autoFocus
              value={username}
              onChange={(e) => setUsername(e.target.value)}
            />
          </label>
        ) : (
          <>
            <p className="signin-user">
              {username}
              <button type="button" className="link" onClick={() => setStep("username")}>
                Change
              </button>
            </p>
            <label className="signin-field">
              Password
              <input
                className="signin-input"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </>
        )}
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="btn signin-button" disabled={busy}>
          {step === "username" ? "Next" : busy ? "Signing In..." : "Sign In"}
        </button>
        <p className="signin-help">
          No account? Ask someone who already has one to run{" "}
          <span className="mono">npm run connect -- add-user</span>.
        </p>
      </form>
    </main>
  );
}
