export type PillTone = "success" | "warning" | "danger" | "info" | "muted";

type Props = { tone: PillTone; children: string };

export function StatusPill({ tone, children }: Props) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}
