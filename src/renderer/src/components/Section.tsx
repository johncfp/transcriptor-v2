import type { ReactNode } from "react";

export function Section({ title, intro, children }: { title: string; intro?: ReactNode; children: ReactNode }) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {intro && <p className="muted section-intro">{intro}</p>}
      <div className="rows">{children}</div>
    </section>
  );
}
