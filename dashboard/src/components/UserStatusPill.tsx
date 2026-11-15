import { STATUS_LABELS, userStatus, type UserStatus } from "../lib/users";
import type { User } from "../types";
import { StatusPill, type PillTone } from "./StatusPill";

const TONES: Record<UserStatus, PillTone> = {
  active: "success",
  login_disabled: "warning",
  inactive: "muted",
};

export function UserStatusPill({ user }: { user: Pick<User, "active" | "login_enabled"> }) {
  const status = userStatus(user);
  return <StatusPill tone={TONES[status]}>{STATUS_LABELS[status]}</StatusPill>;
}
