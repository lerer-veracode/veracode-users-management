import type { ReactNode } from "react";

type Props = { title: string; children?: ReactNode };

export function PageHeader({ title, children }: Props) {
  return (
    <>
      <div className="breadcrumb">
        <a href="#/users" className="breadcrumb-home">
          Home
        </a>
        <span>/</span>
      </div>
      <h1 className="page-title">{title}</h1>
      {children && <div className="toolbar">{children}</div>}
    </>
  );
}
