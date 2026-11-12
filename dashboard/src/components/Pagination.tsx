import { Icon, type IconName } from "./Icon";
import { pageCount } from "../lib/users";

const DEFAULT_SIZES = [10, 25, 50];

type Props = {
  total: number;
  page: number;
  size: number;
  onPage: (page: number) => void;
  onSize: (size: number) => void;
  sizes?: number[];
};

export function Pagination({ total, page, size, onPage, onSize, sizes = DEFAULT_SIZES }: Props) {
  const pages = pageCount(total, size);
  const from = total === 0 ? 0 : (page - 1) * size + 1;
  const to = Math.min(page * size, total);
  const nav = (label: string, icon: IconName, target: number) => (
    <button
      type="button"
      className="icon-button"
      aria-label={label}
      disabled={target === page}
      onClick={() => onPage(target)}
    >
      <Icon name={icon} size={22} />
    </button>
  );

  return (
    <div className="pagination">
      <span>
        {from}-{to} of {total}
      </span>
      <div className="pager">
        {nav("First page", "first", 1)}
        {nav("Previous page", "chevronLeft", Math.max(1, page - 1))}
        Page <span className="page-box">{page}</span> of {pages}
        {nav("Next page", "chevronRight", Math.min(pages, page + 1))}
        {nav("Last page", "last", pages)}
      </div>
      <label className="rows-per-page">
        Rows per page:
        <select className="input" value={size} onChange={(e) => onSize(Number(e.target.value))}>
          {sizes.map((s) => (
            <option key={s}>{s}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
