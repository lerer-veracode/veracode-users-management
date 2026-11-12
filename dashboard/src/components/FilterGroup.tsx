import { useState, type ReactNode } from "react";
import { Icon } from "./Icon";

type Props = { title: string; children: ReactNode };

export function FilterGroup({ title, children }: Props) {
  const [open, setOpen] = useState(true);
  return (
    <div className="filter-group">
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)}>
        {title}
        <Icon name={open ? "chevronUp" : "chevronDown"} size={18} />
      </button>
      {open && <div className="filter-options">{children}</div>}
    </div>
  );
}
