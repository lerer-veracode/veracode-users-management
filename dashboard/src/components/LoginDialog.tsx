import { useState } from "react";
import { fullName } from "../lib/format";
import type { Source, User } from "../types";
import { Dialog } from "./Dialog";

type Props = {
  source: Source;
  user: User;
  onConfirm: () => Promise<void>;
  onCancel: () => void;
};

// Confirms turning a user's login on or off, saying which user and organization.
export function LoginDialog({ source, user, onConfirm, onCancel }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const enabling = !user.login_enabled;
  const action = enabling ? "Enable login" : "Disable login";

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <Dialog title={`${action} for ${user.user_name}`} onClose={busy ? () => undefined : onCancel}>
      <p>
        {enabling
          ? `${fullName(user)} will be able to sign in to Veracode again`
          : `${fullName(user)} won't be able to sign in to Veracode`}
        , in{" "}
        <strong>
          {source.name} ({source.region})
        </strong>
        . Their roles and teams don't change.
      </p>
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <div className="dialog-actions">
        <button
          type="button"
          className="btn btn-secondary btn-small"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className={`btn btn-small ${enabling ? "btn-primary" : "btn-danger"}`}
          disabled={busy}
          onClick={() => void confirm()}
        >
          {busy ? "Saving..." : action}
        </button>
      </div>
    </Dialog>
  );
}
