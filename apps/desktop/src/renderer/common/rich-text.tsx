import { useMemo, useState, type ReactNode } from "react";
import { parseBlocks, parseInline } from "../../shared/rich-text";
import "./rich-text.css";
import { t as tx } from "./i18n";

export interface RichTextProps {
  text: string;
  /** How many numbered page sections [n] may cite. */
  sectionCount: number;
  renderCite: (section: number, key: string) => ReactNode;
  openUrl: (url: string) => void;
  copy: (text: string) => Promise<unknown>;
}

/** An answer's Markdown (see shared/rich-text.ts), drawn as React elements: never as HTML. */
export function RichMarkdown({ text, sectionCount, renderCite, openUrl, copy }: RichTextProps) {
  const blocks = useMemo(() => parseBlocks(text), [text]);

  const inline = (line: string, key: string): ReactNode[] =>
    parseInline(line, sectionCount).flatMap((p, i): ReactNode[] => {
      const k = `${key}.${i}`;
      switch (p.kind) {
        case "text":
          return [p.text];
        case "bold":
          return [<strong key={k}>{p.text}</strong>];
        case "italic":
          return [<em key={k}>{p.text}</em>];
        case "code":
          return [<code key={k}>{p.text}</code>];
        case "link":
          return [
            <a
              key={k}
              href={p.url}
              title={p.url}
              onClick={(e) => {
                e.preventDefault();
                openUrl(p.url);
              }}
            >
              {p.text}
            </a>,
          ];
        case "cite":
          return p.sections.map((n, j) => renderCite(n, `${k}.${j}`));
      }
    });
  // Single line breaks inside a paragraph stay.
  const lines = (value: string, key: string): ReactNode[] =>
    value.split("\n").flatMap((l, i) => (i === 0 ? inline(l, `${key}-${i}`) : [<br key={`${key}-br${i}`} />, ...inline(l, `${key}-${i}`)]));

  return (
    <div className="rich">
      {blocks.map((b, k) => {
        const key = `b${k}`;
        switch (b.kind) {
          case "paragraph":
            return <p key={key}>{lines(b.text, key)}</p>;
          case "heading":
            return b.level === 1 ? <h3 key={key}>{inline(b.text, key)}</h3> : b.level === 2 ? <h4 key={key}>{inline(b.text, key)}</h4> : <h5 key={key}>{inline(b.text, key)}</h5>;
          case "list": {
            const items = b.items.map((it, j) => <li key={j}>{inline(it, `${key}-${j}`)}</li>);
            return b.ordered ? (
              <ol key={key} start={b.start}>
                {items}
              </ol>
            ) : (
              <ul key={key}>{items}</ul>
            );
          }
          case "quote":
            return <blockquote key={key}>{inline(b.text, key)}</blockquote>;
          case "code":
            return <CodeBlock key={key} lang={b.lang} code={b.code} copy={copy} />;
          case "table":
            return (
              <div key={key} className="md-table">
                <table>
                  <thead>
                    <tr>
                      {b.head.map((h, j) => (
                        <th key={j} style={{ textAlign: b.align[j] }}>
                          {inline(h, `${key}-h${j}`)}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, i) => (
                      <tr key={i}>
                        {r.map((c, j) => (
                          <td key={j} style={{ textAlign: b.align[j] }}>
                            {inline(c, `${key}-${i}-${j}`)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "rule":
            return <hr key={key} />;
        }
      })}
    </div>
  );
}

function CodeBlock({ lang, code, copy }: { lang: string; code: string; copy: (text: string) => Promise<unknown> }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="code-block">
      <div className="code-head">
        <span>{lang}</span>
        <button
          onClick={() =>
            void copy(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? tx("Copied") : tx("Copy")}
        </button>
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}
