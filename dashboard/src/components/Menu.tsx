import { useEffect, useRef, useState, type ReactNode } from "react";

// disabled: why the item can't be used; it's shown as the item's tooltip.
export type MenuItem = { label: string; onSelect: () => void; danger?: boolean; disabled?: string };

type Props = { trigger: (open: () => void) => ReactNode; items: MenuItem[] };

export function Menu({ trigger, items }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (e.target instanceof Node && !ref.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  return (
    <div className="row-menu" ref={ref}>
      {trigger(() => setOpen((o) => !o))}
      {open && (
        <div className="menu" role="menu">
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={item.danger ? "menu-danger" : undefined}
              disabled={item.disabled !== undefined}
              title={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
