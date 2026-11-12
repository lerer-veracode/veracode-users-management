import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./Icon";

type Option = { value: string; label: string };

type Props = {
  label: string;
  options: Option[];
  selected: string[];
  onChange: (selected: string[]) => void;
  empty?: string;
};

// A dropdown of checkboxes: the button shows what's chosen, the panel lists the options, with
// a filter once the list is long.
export function MultiSelect({ label, options, selected, onChange, empty = "None" }: Props) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const id = useId();

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (e.target instanceof Node && !ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const chosen = options.filter((o) => selected.includes(o.value)).map((o) => o.label);
  const shown = options.filter((o) => o.label.toLowerCase().includes(filter.trim().toLowerCase()));
  const toggle = (value: string) =>
    onChange(selected.includes(value) ? selected.filter((v) => v !== value) : [...selected, value]);

  return (
    <div
      className="multi"
      ref={ref}
      onKeyDown={(e) => {
        // Escape closes the list, not the dialog around it.
        if (e.key === "Escape" && open) {
          e.nativeEvent.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <span id={id} className="field-label">
        {label}
      </span>
      <button
        type="button"
        className="input multi-trigger"
        aria-labelledby={id}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={chosen.length === 0 ? "muted" : undefined}>
          {chosen.length === 0 ? empty : chosen.join(", ")}
        </span>
        <Icon name="caret" size={18} />
      </button>
      {open && (
        <div className="multi-panel" role="group" aria-label={label}>
          {options.length > 8 && (
            <input
              className="input"
              placeholder="Filter"
              aria-label={`Filter ${label}`}
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          {shown.length === 0 && <p className="muted small">No matches.</p>}
          {shown.map((o) => (
            <label key={o.value}>
              <input
                type="checkbox"
                checked={selected.includes(o.value)}
                onChange={() => toggle(o.value)}
              />
              {o.label}
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
