import { useState, type FormEvent } from "react";
import type {
  NewUser,
  Relationship,
  Role,
  RoleKind,
  Source,
  TeamOption,
  TeamRef,
  User,
  UserChanges,
} from "../types";
import { Dialog } from "./Dialog";
import { MultiSelect } from "./MultiSelect";

type Props = {
  source: Source;
  roles: Role[];
  teams: TeamOption[];
  // The organization's users, so a new user name can't repeat theirs.
  existing: Pick<User, "user_name">[];
  // The user to edit; none to add a new one.
  user?: User;
  onSave: (change: Change) => Promise<void>;
  onCancel: () => void;
  // Reads the organization's teams again from Veracode.
  onRefreshTeams?: () => Promise<void>;
};

export type Change = { kind: "create"; user: NewUser } | { kind: "update"; changes: UserChanges };

type Draft = NewUser & { active: boolean; login_enabled: boolean };
type ScanMode = "all" | "specific" | null;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Creator and Submitter need at least one team, unless the user is also a Security Lead; Veracode
// refuses them otherwise, on a create or an edit (docs/REALITY.md, entry 37).
const TEAM_LEVEL = ["extcreator", "extsubmitter"];
const SECURITY_LEAD = "extseclead";
const needsTeam = (roles: string[], teamCount: number) => {
  const names = roles.map((r) => r.toLowerCase());
  return (
    teamCount === 0 && names.some((n) => TEAM_LEVEL.includes(n)) && !names.includes(SECURITY_LEAD)
  );
};
const isScan = (k: RoleKind) => k === "scan_type" || k === "any_scan";

const sameRoles = (a: string[], b: string[]) =>
  a.length === b.length && a.every((r) => b.includes(r));
const sameTeams = (a: TeamRef[], b: TeamRef[]) =>
  a.length === b.length &&
  a.every((x) => b.some((y) => y.team_id === x.team_id && y.relationship === x.relationship));

// The fields that differ, as the backend expects them.
const diff = (user: User, draft: Draft): UserChanges => {
  const changes: UserChanges = {};
  if (draft.first_name !== user.first_name) changes.first_name = draft.first_name;
  if (draft.last_name !== user.last_name) changes.last_name = draft.last_name;
  if (draft.email_address !== user.email_address) changes.email_address = draft.email_address;
  if (draft.active !== user.active) changes.active = draft.active;
  if (draft.login_enabled !== user.login_enabled) changes.login_enabled = draft.login_enabled;
  if (draft.pin_required !== user.pin_required) changes.pin_required = draft.pin_required;
  const held = user.roles.map((r) => r.role_name);
  if (!sameRoles(draft.roles, held)) changes.roles = draft.roles;
  if (!sameTeams(draft.teams, user.teams)) changes.teams = draft.teams;
  return changes;
};

export function UserFormDialog({
  source,
  roles,
  teams,
  existing,
  user,
  onSave,
  onCancel,
  onRefreshTeams,
}: Props) {
  const [teamsNote, setTeamsNote] = useState("");
  const refreshTeams = async () => {
    if (!onRefreshTeams) return;
    setTeamsNote("Refreshing…");
    try {
      await onRefreshTeams();
      setTeamsNote("Teams refreshed.");
    } catch (e) {
      setTeamsNote(e instanceof Error ? e.message : String(e));
    }
  };
  // A new user's user name: the email address, or a different one typed in.
  const [nameMode, setNameMode] = useState<"email" | "other">("email");
  const [otherName, setOtherName] = useState("");
  const [draft, setDraft] = useState<Draft>({
    email_address: user?.email_address ?? "",
    first_name: user?.first_name ?? "",
    last_name: user?.last_name ?? "",
    roles: user?.roles.map((r) => r.role_name) ?? [],
    teams: user?.teams.map(({ team_id, relationship }) => ({ team_id, relationship })) ?? [],
    active: user?.active ?? true,
    login_enabled: user?.login_enabled ?? true,
    // New users get MFA by default; it can be turned off before saving.
    pin_required: user?.pin_required ?? true,
  });
  const kindOf = (name: string): RoleKind =>
    roles.find((r) => r.role_name === name)?.kind ?? "plain";
  const [scanMode, setScanMode] = useState<ScanMode>(() => {
    const kinds = draft.roles.map(kindOf);
    if (kinds.includes("any_scan")) return "all";
    return kinds.includes("scan_type") ? "specific" : null;
  });
  const [reviewing, setReviewing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const offered = roles.filter((r) => r.assignable);
  const mainRoles = offered.filter((r) => !isScan(r.kind));
  const anyScan = offered.find((r) => r.kind === "any_scan");
  const specificScans = offered.filter((r) => r.kind === "scan_type");
  // Roles the user already has that this app won't give: they stay, and can't be changed here.
  const kept = (user?.roles ?? []).filter((r) => !offered.some((o) => o.role_name === r.role_name));
  // Teams the user is in, even if they're not in the organization's list, stay listed.
  const teamChoices: TeamOption[] = [
    ...teams,
    ...(user?.teams ?? []).filter((t) => !teams.some((x) => x.team_id === t.team_id)),
  ];

  const kinds = draft.roles.map(kindOf);
  const needsScan = kinds.includes("needs_scan_type");
  const isTeamAdmin = kinds.includes("team_admin");
  const trimmed: Draft = {
    ...draft,
    email_address: draft.email_address.trim(),
    first_name: draft.first_name.trim(),
    last_name: draft.last_name.trim(),
  };
  const changes = user ? diff(user, trimmed) : null;
  const userName = nameMode === "email" ? trimmed.email_address : otherName.trim();

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const toggle = (name: string) => {
    const removing = draft.roles.includes(name);
    setDraft((d) => ({
      ...d,
      roles: removing ? d.roles.filter((r) => r !== name) : [...d.roles, name],
      // No longer a Team Admin: the teams they managed stay as memberships.
      teams:
        removing && kindOf(name) === "team_admin"
          ? d.teams.map((t) => ({ ...t, relationship: "MEMBER" as const }))
          : d.teams,
    }));
  };
  const chooseScanMode = (mode: "all" | "specific") => {
    setScanMode(mode);
    const others = draft.roles.filter((r) => !isScan(kindOf(r)));
    if (mode === "all" && anyScan) set("roles", [...others, anyScan.role_name]);
    if (mode === "specific") {
      set("roles", [...others, ...draft.roles.filter((r) => kindOf(r) === "scan_type")]);
    }
  };
  // Teams the user manages (Team Admin) and teams they're only a member of. A managed team
  // counts as a membership, so it isn't offered again as one.
  const idsWith = (relationship: Relationship) =>
    draft.teams.filter((t) => t.relationship === relationship).map((t) => t.team_id);
  const manages = idsWith("ADMIN");
  const memberOf = idsWith("MEMBER");
  const setMemberOf = (ids: string[]) =>
    set("teams", [
      ...draft.teams.filter((t) => t.relationship === "ADMIN"),
      ...ids.map((team_id) => ({ team_id, relationship: "MEMBER" as const })),
    ]);
  const setManages = (ids: string[]) =>
    set("teams", [
      ...ids.map((team_id) => ({ team_id, relationship: "ADMIN" as const })),
      ...draft.teams.filter((t) => t.relationship === "MEMBER" && !ids.includes(t.team_id)),
    ]);
  const teamOptions = (exclude: string[]) =>
    teamChoices
      .filter((t) => !exclude.includes(t.team_id))
      .map((t) => ({ value: t.team_id, label: t.team_name }));

  // The same rules the backend checks, so mistakes show here first.
  const problem = (): string => {
    if (!EMAIL.test(trimmed.email_address)) return "Enter a valid email address.";
    if (!user) {
      if (!userName) return "Enter the user name, or use the email address.";
      if (/\s/.test(userName) || userName.length > 256) {
        return "A user name can't contain spaces or be over 256 characters.";
      }
      if (existing.some((u) => u.user_name.toLowerCase() === userName.toLowerCase())) {
        return `${userName} is already a user name in ${source.name}.`;
      }
    }
    // Several users may share an email address (docs/REALITY.md, entry 34).
    if (!trimmed.first_name) return "Enter the first name.";
    if (!trimmed.last_name) return "Enter the last name.";
    if (trimmed.roles.length === 0) return "Choose at least one role.";
    if (needsScan && !kinds.some(isScan)) {
      return "Security Lead, Creator and Submitter need a scan type: All scan types, or at least one specific type.";
    }
    if (isTeamAdmin && manages.length === 0) return "Team Admin needs at least one team to manage.";
    // As the backend: checked on a new user, and on an edit that changes roles or teams.
    const rolesOrTeams = !changes || changes.roles !== undefined || changes.teams !== undefined;
    if (rolesOrTeams && needsTeam(trimmed.roles, trimmed.teams.length)) {
      return "This combination of roles requires the user to be in at least one team: choose one under Member of teams.";
    }
    if (changes && Object.keys(changes).length === 0) return "Nothing to change.";
    return "";
  };

  const review = (e: FormEvent) => {
    e.preventDefault();
    const p = problem();
    setError(p);
    if (!p) setReviewing(true);
  };

  const confirm = async () => {
    setBusy(true);
    setError("");
    try {
      const { email_address, first_name, last_name, pin_required } = trimmed;
      const { roles: chosen, teams: joined } = trimmed;
      await onSave(
        changes
          ? { kind: "update", changes }
          : {
              kind: "create",
              user: {
                // Sent only when it differs from the email address.
                ...(nameMode === "other" && { user_name: userName }),
                email_address,
                first_name,
                last_name,
                roles: chosen,
                teams: joined,
                pin_required,
              },
            },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const title = user ? `Edit ${user.user_name}` : "Add New User";
  const org = `${source.name} (${source.region})`;

  const describe = (names: string[]) =>
    names.map((n) => roles.find((r) => r.role_name === n)?.role_description ?? n).join(", ") ||
    "None";
  const roleText = (names: string[]) => describe(names.filter((n) => !isScan(kindOf(n))));
  const scanText = (names: string[]) => describe(names.filter((n) => isScan(kindOf(n))));
  const teamText = (refs: TeamRef[], relationship: Relationship) =>
    refs
      .filter((t) => t.relationship === relationship)
      .map((t) => teamChoices.find((x) => x.team_id === t.team_id)?.team_name ?? t.team_id)
      .sort()
      .join(", ") || "None";
  const yesNo = (on: boolean, yes: string, no: string) => (on ? yes : no);

  if (reviewing) {
    const held = user?.roles.map((r) => r.role_name) ?? [];
    const rows: [string, string, string][] = user
      ? [
          ["First name", user.first_name, trimmed.first_name],
          ["Last name", user.last_name, trimmed.last_name],
          ["Email", user.email_address, trimmed.email_address],
          ["Status", user.active ? "Active" : "Inactive", trimmed.active ? "Active" : "Inactive"],
          [
            "Login",
            yesNo(user.login_enabled, "Enabled", "Disabled"),
            yesNo(trimmed.login_enabled, "Enabled", "Disabled"),
          ],
          [
            "MFA",
            yesNo(user.pin_required, "Required", "Not required"),
            yesNo(trimmed.pin_required, "Required", "Not required"),
          ],
          ["Roles", roleText(held), roleText(trimmed.roles)],
          ["Scan types", scanText(held), scanText(trimmed.roles)],
          ["Member of teams", teamText(user.teams, "MEMBER"), teamText(trimmed.teams, "MEMBER")],
          ["Manages teams", teamText(user.teams, "ADMIN"), teamText(trimmed.teams, "ADMIN")],
        ].filter((row): row is [string, string, string] => row[1] !== row[2])
      : [
          ["User name", "", userName],
          ["Email", "", trimmed.email_address],
          ["First name", "", trimmed.first_name],
          ["Last name", "", trimmed.last_name],
          ["MFA", "", yesNo(trimmed.pin_required, "Required", "Not required")],
          ["Roles", "", roleText(trimmed.roles)],
          ["Scan types", "", scanText(trimmed.roles)],
          ["Member of teams", "", teamText(trimmed.teams, "MEMBER")],
          ...(isTeamAdmin
            ? [["Manages teams", "", teamText(trimmed.teams, "ADMIN")] as [string, string, string]]
            : []),
        ];
    return (
      <Dialog title={title} onClose={busy ? () => undefined : onCancel}>
        <p>
          {user ? "These changes" : "This new user"} will be saved on Veracode, in{" "}
          <strong>{org}</strong>.
        </p>
        <table className="review-table">
          <thead>
            <tr>
              <th scope="col">Field</th>
              {user && <th scope="col">Now</th>}
              <th scope="col">{user ? "After" : "Value"}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, before, after]) => (
              <tr key={label}>
                <th scope="row">{label}</th>
                {user && <td>{before}</td>}
                <td>{after}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!user && (
          <p className="muted small">Veracode may email the new user to activate the account.</p>
        )}
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
            onClick={() => setReviewing(false)}
          >
            Back
          </button>
          <button
            type="button"
            className="btn btn-primary btn-small"
            disabled={busy}
            onClick={() => void confirm()}
          >
            {busy ? "Saving..." : user ? "Save changes" : "Create user"}
          </button>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog title={title} onClose={onCancel}>
      <form onSubmit={review} noValidate>
        <p className="muted">
          In <strong>{org}</strong>.
        </p>
        <div className="form-grid">
          <label className="field field-wide">
            Email
            <input
              className="input"
              type="email"
              value={draft.email_address}
              onChange={(e) => set("email_address", e.target.value)}
            />
          </label>
          {!user && (
            <fieldset className="field field-wide">
              <legend>User name</legend>
              <div className="role-list">
                <label>
                  <input
                    type="radio"
                    name="user-name"
                    checked={nameMode === "email"}
                    onChange={() => setNameMode("email")}
                  />
                  Same as email
                </label>
                <label>
                  <input
                    type="radio"
                    name="user-name"
                    checked={nameMode === "other"}
                    onChange={() => setNameMode("other")}
                  />
                  A different user name
                </label>
              </div>
              {nameMode === "other" && (
                <input
                  className="input"
                  aria-label="User name"
                  autoComplete="off"
                  value={otherName}
                  onChange={(e) => setOtherName(e.target.value)}
                />
              )}
            </fieldset>
          )}
          <label className="field">
            First name
            <input
              className="input"
              value={draft.first_name}
              onChange={(e) => set("first_name", e.target.value)}
            />
          </label>
          <label className="field">
            Last name
            <input
              className="input"
              value={draft.last_name}
              onChange={(e) => set("last_name", e.target.value)}
            />
          </label>
          <div className="field field-wide switches">
            {user && (
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={draft.active}
                  onChange={(e) => set("active", e.target.checked)}
                />
                Active
              </label>
            )}
            {user && (
              <label className="check-field">
                <input
                  type="checkbox"
                  checked={draft.login_enabled}
                  onChange={(e) => set("login_enabled", e.target.checked)}
                />
                Login enabled
              </label>
            )}
            <label className="check-field">
              <input
                type="checkbox"
                checked={draft.pin_required}
                onChange={(e) => set("pin_required", e.target.checked)}
              />
              Require MFA
            </label>
          </div>

          <fieldset className="field field-wide">
            <legend>Roles</legend>
            <div className="role-list">
              {mainRoles.map((r) => (
                <label key={r.role_name}>
                  <input
                    type="checkbox"
                    checked={draft.roles.includes(r.role_name)}
                    onChange={() => toggle(r.role_name)}
                  />
                  {r.role_description}
                </label>
              ))}
            </div>
            {kept.length > 0 && (
              <p className="muted small">
                Kept, and not changed here: {kept.map((r) => r.role_description).join(", ")}.
              </p>
            )}
            <p className="muted small">
              The Administrator role and API roles are never given by this app.
            </p>
          </fieldset>

          {(needsScan || kinds.some(isScan)) && (
            <fieldset className="field field-wide">
              <legend>Scan types</legend>
              <p className="muted small">Security Lead, Creator and Submitter need at least one.</p>
              <div className="role-list">
                {anyScan && (
                  <label>
                    <input
                      type="radio"
                      name="scan-mode"
                      checked={scanMode === "all"}
                      onChange={() => chooseScanMode("all")}
                    />
                    All scan types
                  </label>
                )}
                <label>
                  <input
                    type="radio"
                    name="scan-mode"
                    checked={scanMode === "specific"}
                    onChange={() => chooseScanMode("specific")}
                  />
                  Specific scan types
                </label>
              </div>
              {scanMode === "specific" && (
                <div className="role-list indent">
                  {specificScans.map((r) => (
                    <label key={r.role_name}>
                      <input
                        type="checkbox"
                        checked={draft.roles.includes(r.role_name)}
                        onChange={() => toggle(r.role_name)}
                      />
                      {r.role_description}
                    </label>
                  ))}
                </div>
              )}
            </fieldset>
          )}

          <div className="field field-wide">
            <MultiSelect
              label="Member of teams"
              options={teamOptions(manages)}
              selected={memberOf}
              onChange={setMemberOf}
              empty={teamChoices.length === 0 ? "No teams in this organization" : "None"}
            />
            {onRefreshTeams && (
              // Teams are kept until a refresh (docs/PLAN_CACHE.md, phase 3): one just made on the
              // Platform shows after this, without closing the form.
              <p className="small">
                <button
                  type="button"
                  className="link"
                  disabled={teamsNote === "Refreshing…"}
                  onClick={() => void refreshTeams()}
                >
                  ↻ Refresh teams
                </button>{" "}
                {teamsNote && (
                  <span className="muted" role="status">
                    {teamsNote}
                  </span>
                )}
              </p>
            )}
          </div>
          {isTeamAdmin && (
            <div className="field field-wide">
              <MultiSelect
                label="Manages teams (Team Admin)"
                options={teamOptions([])}
                selected={manages}
                onChange={setManages}
                empty="Choose at least one"
              />
              <p className="muted small">
                A Team Admin manages the teams chosen here; there is no "all teams". A managed team
                counts as a membership.
              </p>
            </div>
          )}
        </div>
        {error && (
          <p className="error-text" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn btn-secondary btn-small" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary btn-small">
            Review
          </button>
        </div>
      </form>
    </Dialog>
  );
}
