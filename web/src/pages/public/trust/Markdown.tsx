import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown, { type Components, type Options } from "react-markdown";
import { Link } from "react-router";
import rehypeSlug from "rehype-slug";
import remarkGfm from "remark-gfm";

import type { Heading } from "./docs";
import { rehypeAnchors, rehypeSections, rehypeTables, remarkFacts } from "./plugins";

export interface FactsView {
  value: (key: string) => string | null;
  state: "loading" | "ready" | "failed";
}
export const FactsContext = createContext<FactsView>({ value: () => null, state: "loading" });

/** A number the server fills in. Underlined with dots, with a title saying where it comes from. */
export function LiveValue({ name }: { name: string }) {
  const { t } = useTranslation("public");
  const { value, state } = useContext(FactsContext);
  const v = value(name);
  if (v === null && state === "loading")
    return (
      <span className="live" data-state="loading" aria-busy="true">
        {"  "}
      </span>
    );
  return (
    <data className="live" value={v ?? ""} data-state={v === null ? "missing" : "ready"} title={t("trust.doc.liveTitle")}>
      {v ?? t("trust.doc.factMissing")}
    </data>
  );
}

const WIDE = 6;

function Table({ children, ...rest }: ComponentProps<"table"> & { node?: unknown; "data-cols"?: number }) {
  const { t } = useTranslation("public");
  const title = useContext(SectionTitle);
  const { node: _node, ...props } = rest;
  const wide = Number(props["data-cols"] ?? 0) >= WIDE;
  // The roles are spelled out because a table shown as records on a phone loses them with display: block.
  return (
    <div className="ruled-table-wrap" data-wide={wide} tabIndex={0} role="region" aria-label={t("trust.doc.table", { title })}>
      <table {...props} role="table">
        {children}
      </table>
    </div>
  );
}
const SectionTitle = createContext("");

function A({ href = "", children, node: _node, ...rest }: ComponentProps<"a"> & { node?: unknown }) {
  const { t } = useTranslation("common");
  if (rest.className?.includes("prose-anchor"))
    return (
      <a href={href} className="prose-anchor" aria-label={t("doc.linkTo")}>
        {children}
      </a>
    );
  if (href.startsWith("#fn-"))
    return (
      <a href={href} id={rest.id} className="link fn" aria-label={t("doc.footnote", { n: href.slice(4) })}>
        {children}
      </a>
    );
  if (href.startsWith("/")) return <Link to={href}>{children}</Link>;
  if (href.startsWith("#")) return <a href={href}>{children}</a>;
  return (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

const strip = <T extends object>(p: T & { node?: unknown }) => {
  const { node: _node, ...rest } = p;
  return rest as T;
};

const components: Components = {
  a: A as Components["a"],
  table: Table as Components["table"],
  thead: (p) => <thead {...strip(p)} role="rowgroup" />,
  tbody: (p) => <tbody {...strip(p)} role="rowgroup" />,
  tr: (p) => <tr {...strip(p)} role="row" />,
  td: (p) => <td {...strip(p)} role="cell" />,
  th: (p) => <th {...strip(p)} role={p.scope === "row" ? "rowheader" : "columnheader"} />,
  data: ({ node }) => <LiveValue name={String(node?.properties.dataFact ?? "")} />,
  section: ({ node: _node, children, ...p }) => <section {...p}>{children}</section>,
  pre: ({ node: _node, children }) => <Code>{children}</Code>,
};

function Code({ children }: { children: ReactNode }) {
  const { t } = useTranslation("public");
  return (
    <pre tabIndex={0} role="region" aria-label={t("trust.doc.code")}>
      {children}
    </pre>
  );
}

// remark/rehype plugin types differ between the packages' own copies of unified; the trees are the same.
type Plugins = NonNullable<Options["rehypePlugins"]>;

export function DocMarkdown({ body, headings, title }: { body: string; headings: Heading[]; title: string }) {
  return (
    <SectionTitle value={title}>
      <ReactMarkdown remarkPlugins={[remarkGfm, remarkFacts] as Options["remarkPlugins"]} rehypePlugins={[[rehypeSections, { headings }], rehypeAnchors, rehypeTables, rehypeSlug] as unknown as Plugins} components={components}>
        {body}
      </ReactMarkdown>
    </SectionTitle>
  );
}

/** One reference: inline only. */
export function InlineMarkdown({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={{ ...components, p: ({ children }) => <>{children}</> }}>
      {text}
    </ReactMarkdown>
  );
}
