import type { ReactNode } from "react";

export function PageHeading({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-10">
      <h1 className="text-4xl font-extrabold tracking-[-0.03em] sm:text-5xl">{title}</h1>
      {children && <p className="mt-3 text-muted">{children}</p>}
    </div>
  );
}
