import { formatDateTime } from "../lib/format";
import { daysLeft } from "../lib/retention";
import { StatusPill } from "./StatusPill";

type Props = { removesAt: string; now: Date };

export function RemovalPill({ removesAt, now }: Props) {
  const days = daysLeft(removesAt, now);
  const label = days === 1 ? "1 day left" : `${days} days left`;
  return (
    <span title={`Removed on ${formatDateTime(removesAt)}`}>
      <StatusPill tone={days <= 7 ? "warning" : "muted"}>{label}</StatusPill>
    </span>
  );
}
