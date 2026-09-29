import type { ReactNode } from "react";

export function Section({
  title,
  intro,
  className,
  children,
}: {
  title: string;
  intro?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={className ? `section ${className}` : "section"}>
      <h2>{title}</h2>
      {intro && <p className="muted section-intro">{intro}</p>}
      <div className="rows">{children}</div>
    </section>
  );
}
