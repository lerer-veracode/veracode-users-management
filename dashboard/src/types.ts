export type Permission = { permission_name: string; permission_description: string };

export type Relationship = "ADMIN" | "MEMBER";

// A team the user is in, and whether they manage it (Team Admin) or are a member.
export type Team = { team_id: string; team_name: string; relationship: Relationship };

// A team of the organization, to choose from.
export type TeamOption = { team_id: string; team_name: string };

export type TeamRef = { team_id: string; relationship: Relationship };

// How a role is given: plainly, as a scan type ("any_scan" is All scan types), as a role that
// needs a scan type (Security Lead, Creator, Submitter), or as Team Admin, which needs teams.
export type RoleKind = "plain" | "scan_type" | "any_scan" | "needs_scan_type" | "team_admin";

export type Role = {
  role_name: string;
  role_description: string;
  is_api: boolean;
  permissions: Permission[];
  // Whether this app may give the role: never Administrator or an API role.
  assignable: boolean;
  kind: RoleKind;
};

export type RoleRef = Pick<Role, "role_name" | "role_description">;

export type UserType = "UI" | "API" | "SAML";

export type User = {
  user_id: string;
  user_name: string;
  first_name: string;
  last_name: string;
  email_address: string;
  user_type: UserType;
  active: boolean;
  login_enabled: boolean;
  // Require MFA: Veracode's pin_required.
  pin_required: boolean;
  roles: RoleRef[];
  permissions: Permission[];
  teams: Team[];
  last_login: string | null;
  // Why this app won't change or delete the user (an administrator, or not a UI user), or null.
  locked: string | null;
};

export type NewUser = {
  // Left out when the user name is the email address.
  user_name?: string;
  email_address: string;
  first_name: string;
  last_name: string;
  roles: string[];
  teams: TeamRef[];
  pin_required: boolean;
};

export type UserChanges = Partial<Omit<NewUser, "user_name">> & {
  active?: boolean;
  login_enabled?: boolean;
};

// Which connection a list came from, as the backend names it in every answer.
export type Source = { id: string; name: string; region: string };

export type Connection = {
  id: string;
  name: string;
  region: string;
  client_id: string;
  token_expires: string | null;
  added_at: string;
  removes_at: string;
  active: boolean;
};

export type AuditEntry = {
  time: string;
  actor: string;
  action: string;
  outcome: "ok" | "failed";
  connection: string | null;
  reason: string | null;
  // Why the app made the call, in plain words.
  purpose: string | null;
  request: string | null;
  // How long Veracode took, in milliseconds, and what came back, as counts only.
  ms: number | null;
  result: string | null;
  detail: string | null;
  // For a change to a user: which user, and each field from and to (null: none).
  target: string | null;
  changes: FieldChange[];
};

export type FieldChange = { field: string; from: string | null; to: string | null };

export type AppUser = {
  username: string;
  added_at: string;
  last_sign_in: string;
  removes_at: string;
};
