type Props = { large?: boolean };

export function UnofficialBadge({ large }: Props) {
  return (
    <span className={large ? "unofficial unofficial-large" : "unofficial"} role="note">
      Un-official
    </span>
  );
}
