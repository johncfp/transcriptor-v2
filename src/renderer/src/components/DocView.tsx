import type { MouseEvent } from "react";
import type { Block, Run } from "../../../shared/showNotes";

function Runs({ runs }: { runs: Run[] }) {
  return (
    <>
      {runs.map((r, i) => {
        const text = /^https?:\/\//.test(r.text) ? <a href={r.text} onClick={openLink(r.text)}>{r.text}</a> : r.text;
        if (r.bold) return <strong key={i}>{text}</strong>;
        if (r.italic) return <em key={i}>{text}</em>;
        return <span key={i}>{text}</span>;
      })}
    </>
  );
}

/** Links open in the browser, never inside the app. */
const openLink = (url: string) => (e: MouseEvent) => {
  e.preventDefault();
  void window.api.openExternal(url);
};

/** Show notes or a reference file, rendered from the same blocks the exports use. */
export function DocView({ blocks }: { blocks: Block[] }) {
  return (
    <article className="doc">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "heading": {
            const H = `h${b.level}` as "h1" | "h2" | "h3";
            return <H key={i}>{b.text}</H>;
          }
          case "paragraph":
            return (
              <p key={i}>
                <Runs runs={b.runs} />
              </p>
            );
          case "list": {
            const L = b.ordered ? "ol" : "ul";
            return (
              <L key={i}>
                {b.items.map((item, j) => (
                  <li key={j}>
                    <Runs runs={item} />
                  </li>
                ))}
              </L>
            );
          }
          case "table":
            return (
              <table key={i}>
                <thead>
                  <tr>
                    {b.header.map((h) => (
                      <th key={h}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {b.rows.map((row, j) => (
                    <tr key={j}>
                      {row.map((cell, k) => (
                        <td key={k}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            );
          case "quote":
            return (
              <blockquote key={i}>
                <p>“{b.text}”</p>
                <footer>— {b.attribution}</footer>
              </blockquote>
            );
          case "rule":
            return <hr key={i} />;
        }
      })}
    </article>
  );
}
