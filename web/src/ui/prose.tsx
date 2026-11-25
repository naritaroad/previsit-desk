import { IconArrowBackUp, IconList } from "@tabler/icons-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { cn } from "./cn";

/* Reading components for the trust centre and the handbook: numbered sections, contents with scroll spy, document
   block, footnotes, evidence table, changelog. Headings and lede are set in 明體, text in 黑體. */

export interface DocMeta {
  label: ReactNode;
  value: ReactNode;
}

/** Version, effective date, owner, reviewer, next review: the block a formal document opens with. */
export function DocumentMeta({ items, title }: { items: DocMeta[]; title?: string }) {
  const { t } = useTranslation("common");
  return (
    <div className="doc-meta">
      <p className="sr-only">{title ?? t("doc.meta")}</p>
      <dl>
        {items.map((i, n) => (
          <div key={n}>
            <dt>{i.label}</dt>
            <dd>{i.value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export interface TocItem {
  id: string;
  title: string;
  /** "3" or "3.2"; omit for unnumbered documents. */
  no?: string;
  children?: TocItem[];
}

function useScrollSpy(ids: string[]): string | null {
  const [active, setActive] = useState<string | null>(ids[0] ?? null);
  const key = ids.join("|");
  useEffect(() => {
    const els = key
      .split("|")
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (els.length === 0) return;
    const visible = new Set<string>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.add(e.target.id);
          else visible.delete(e.target.id);
        }
        const first = els.find((el) => visible.has(el.id));
        if (first) setActive(first.id);
      },
      { rootMargin: "-88px 0px -66% 0px" },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [key]);
  return active;
}

/** Contents. Sticky beside the text on wide screens, a disclosure above it on narrow ones. */
export function TableOfContents({ items, className }: { items: TocItem[]; className?: string }) {
  const { t } = useTranslation("common");
  const flat = items.flatMap((i) => [i, ...(i.children ?? [])]);
  const active = useScrollSpy(flat.map((i) => i.id));
  const parentOf = (id: string | null) => items.find((i) => i.id === id || i.children?.some((c) => c.id === id))?.id;
  const open = parentOf(active);
  const list = (
    <ol className="toc">
      {items.map((i) => (
        <li key={i.id}>
          <a href={`#${i.id}`} aria-current={i.id === active ? "location" : undefined} data-open={i.id === open}>
            {i.no && <span className="num">{i.no}</span>}
            <span>{i.title}</span>
          </a>
          {i.children && i.id === open && (
            <ol>
              {i.children.map((c) => (
                <li key={c.id}>
                  <a href={`#${c.id}`} aria-current={c.id === active ? "location" : undefined}>
                    {c.no && <span className="num">{c.no}</span>}
                    <span>{c.title}</span>
                  </a>
                </li>
              ))}
            </ol>
          )}
        </li>
      ))}
    </ol>
  );
  return (
    <nav aria-label={t("doc.contents")} className={cn("toc-nav", className)}>
      <p className="toc-title">{t("doc.contents")}</p>
      <div className="toc-wide">{list}</div>
      <details className="toc-narrow">
        <summary>
          <IconList size={20} aria-hidden />
          {t("doc.contents")}
          <span className="truncate text-fg-2">{flat.find((i) => i.id === active)?.title}</span>
        </summary>
        {list}
      </details>
    </nav>
  );
}

/** Contents on the left, text in the middle, notes in the right margin when there is room. */
export function DocLayout({ toc, children, className }: { toc: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cn("doc", className)}>
      <div className="doc-toc">{toc}</div>
      <div className="doc-body">{children}</div>
    </div>
  );
}

export function Prose({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("prose", className)}>{children}</div>;
}

/** A numbered section. The number is part of how people cite the document, so it stays. */
export function ProseSection({ id, no, title, level = 2, children }: { id: string; no?: string; title: ReactNode; level?: 2 | 3; children: ReactNode }) {
  const { t } = useTranslation("common");
  const H = level === 2 ? "h2" : "h3";
  return (
    <section id={id} className="prose-section" data-level={level} aria-labelledby={`${id}-h`}>
      <H id={`${id}-h`}>
        {no && <span className="prose-no num">{no}</span>}
        <span>{title}</span>
        <a href={`#${id}`} className="prose-anchor" aria-label={t("doc.linkTo")}>
          #
        </a>
      </H>
      {children}
    </section>
  );
}

/** Side note: a limit, a definition, a source, beside the sentence it belongs to. */
export function MarginNote({ children }: { children: ReactNode }) {
  return (
    <aside className="margin-note" role="note">
      {children}
    </aside>
  );
}

export function FootnoteRef({ n }: { n: number }) {
  const { t } = useTranslation("common");
  return (
    <sup id={`fnref-${n}`} className="fn-ref">
      <a href={`#fn-${n}`} aria-label={t("doc.footnote", { n })}>
        {n}
      </a>
    </sup>
  );
}

export function Footnotes({ items, title }: { items: { n: number; content: ReactNode }[]; title?: string }) {
  const { t } = useTranslation("common");
  return (
    <section className="footnotes" aria-label={title ?? t("doc.footnotes")}>
      <h2>{title ?? t("doc.footnotes")}</h2>
      <ol>
        {items.map((i) => (
          <li key={i.n} id={`fn-${i.n}`} value={i.n}>
            {i.content}{" "}
            <a href={`#fnref-${i.n}`} className="link" aria-label={t("doc.backToText", { n: i.n })}>
              <IconArrowBackUp size={16} className="inline" aria-hidden />
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Claims with where they can be checked and what they do not show. */
export function EvidenceTable({ caption, rows }: { caption: string; rows: { no: string; claim: ReactNode; evidence: ReactNode; limits: ReactNode }[] }) {
  const { t } = useTranslation("common");
  return (
    <div className="ruled-table-wrap" tabIndex={0} role="region" aria-label={caption}>
      <table className="ruled-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{t("doc.no")}</th>
            <th scope="col">{t("doc.claim")}</th>
            <th scope="col">{t("doc.evidence")}</th>
            <th scope="col">{t("doc.limits")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.no}>
              <th scope="row" className="num">
                {r.no}
              </th>
              <td>{r.claim}</td>
              <td>{r.evidence}</td>
              <td>{r.limits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Any other table inside prose (hazard log, data categories, regulation mapping). */
export function RuledTable({ caption, head, rows, numeric = [] }: { caption: string; head: ReactNode[]; rows: ReactNode[][]; /** Column indexes set as figures. */ numeric?: number[] }) {
  return (
    <div className="ruled-table-wrap" tabIndex={0} role="region" aria-label={caption}>
      <table className="ruled-table">
        <caption>{caption}</caption>
        <thead>
          <tr>
            {head.map((h, i) => (
              <th key={i} scope="col" data-num={numeric.includes(i)}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) =>
                j === 0 ? (
                  <th key={j} scope="row">
                    {c}
                  </th>
                ) : (
                  <td key={j} data-num={numeric.includes(j)}>
                    {c}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Changelog({ entries }: { entries: { version: string; date: string; dateTime?: string; by?: ReactNode; changes: ReactNode[] }[] }) {
  return (
    <ol className="changelog">
      {entries.map((e) => (
        <li key={e.version}>
          <div>
            <p className="num text-lg font-bold">{e.version}</p>
            <time dateTime={e.dateTime} className="text-sm text-fg-2">
              {e.date}
            </time>
            {e.by && <p className="text-sm text-fg-2">{e.by}</p>}
          </div>
          <ul>
            {e.changes.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
        </li>
      ))}
    </ol>
  );
}
