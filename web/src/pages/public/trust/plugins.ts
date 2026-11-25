// Small remark/rehype steps that turn the documents into the kit's prose markup: numbered sections, live values,
// claim anchors, tables that can become records on a phone. The node shapes below are the parts of mdast/hast used.

import type { Heading } from "./docs";

export interface MdNode {
  type: string;
  value?: string;
  children?: MdNode[];
  data?: Record<string, unknown>;
}

/** Text "{{facts.x}}" -> <data data-fact="x">. */
export function remarkFacts() {
  const walk = (node: MdNode): void => {
    if (!node.children) return;
    node.children = node.children.flatMap((c): MdNode[] => {
      if (c.type !== "text" || !c.value?.includes("{{facts.")) {
        walk(c);
        return [c];
      }
      return c.value.split(/(\{\{facts\.\w+\}\})/).flatMap((part): MdNode[] => {
        const m = /^\{\{facts\.(\w+)\}\}$/.exec(part);
        if (m) return [{ type: "fact", data: { hName: "data", hProperties: { dataFact: m[1] }, hChildren: [] } }];
        return part ? [{ type: "text", value: part }] : [];
      });
    });
  };
  return (tree: MdNode) => walk(tree);
}

export interface HNode {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HNode[];
}
const isEl = (n: HNode, tag?: string) => n.type === "element" && (!tag || n.tagName === tag);
const el = (tagName: string, properties: Record<string, unknown>, children: HNode[]): HNode => ({ type: "element", tagName, properties, children });
const text = (value: string): HNode => ({ type: "text", value });
const kids = (n: HNode): HNode[] => n.children ?? [];

export function textOf(n: HNode): string {
  return n.type === "text" ? (n.value ?? "") : kids(n).map(textOf).join("");
}

/** h2/h3 and what follows them become <section class="prose-section" id="s2">, with the number in the heading. */
export function rehypeSections(options: { headings: Heading[] }) {
  return (tree: HNode) => {
    const queue = [...options.headings];
    const root: HNode[] = [];
    let h2: HNode | null = null;
    let h3: HNode | null = null;
    for (const node of kids(tree)) {
      const level = isEl(node, "h2") ? 2 : isEl(node, "h3") ? 3 : 0;
      const h = level === 0 ? undefined : queue.shift();
      if (!h) {
        const open: HNode | null = h3 ?? h2;
        if (open) kids(open).push(node);
        else root.push(node);
        continue;
      }
      node.properties = { ...node.properties, id: `${h.id}-h` };
      node.children = [
        el("span", { className: ["prose-no", "num"] }, [text(h.no)]),
        el("span", {}, kids(node)),
        el("a", { className: ["prose-anchor"], href: `#${h.id}` }, [text("#")]),
      ];
      const section = el("section", { className: ["prose-section"], id: h.id, dataLevel: level, ariaLabelledBy: [`${h.id}-h`] }, [node]);
      if (level === 2) {
        h2 = section;
        h3 = null;
        root.push(section);
      } else {
        h3 = section;
        if (h2) kids(h2).push(section);
        else root.push(section);
      }
    }
    tree.children = root;
  };
}

/** First mention of a claim number on the page is its anchor. First mention of a reference is where the "back"
 *  link of its note goes. */
export function rehypeAnchors() {
  return (tree: HNode) => {
    const seen = new Set<string>();
    const walk = (node: HNode): void => {
      if (node.tagName === "code" || node.tagName === "pre") return;
      node.children = kids(node).flatMap((c): HNode[] => {
        if (c.type === "element") {
          const href = c.properties?.href;
          if (c.tagName === "a" && typeof href === "string" && href.startsWith("#fn-")) {
            const id = `fnref-${href.slice(4)}`;
            if (!seen.has(id)) {
              seen.add(id);
              c.properties = { ...c.properties, id };
            }
          }
          walk(c);
          return [c];
        }
        if (c.type !== "text" || !/C-\d\d/.test(c.value ?? "")) return [c];
        return (c.value ?? "").split(/(C-\d\d)/).flatMap((part): HNode[] => {
          if (!/^C-\d\d$/.test(part)) return part ? [text(part)] : [];
          const first = !seen.has(part);
          seen.add(part);
          return [el("span", first ? { className: ["claim"], id: part } : { className: ["claim"] }, [text(part)])];
        });
      });
    };
    walk(tree);
  };
}

/** Cells learn their column name, the first cell heads its row, tables learn how wide they are, hazard rows get ids. */
export function rehypeTables() {
  const table = (t: HNode) => {
    const rows = (part: string) =>
      kids(t)
        .filter((n) => isEl(n, part))
        .flatMap((n) => kids(n).filter((r) => isEl(r, "tr")));
    const head = (rows("thead")[0] ? kids(rows("thead")[0]) : []).filter((n) => isEl(n)).map(textOf);
    t.properties = { ...t.properties, className: ["ruled-table"], dataCols: head.length };
    for (const r of rows("thead")) for (const h of kids(r)) if (isEl(h)) h.properties = { ...h.properties, scope: "col" };
    for (const r of rows("tbody")) {
      const cells = kids(r).filter((n) => isEl(n));
      const id = cells[0] ? textOf(cells[0]).trim() : "";
      if (/^H-\d\d$/.test(id)) r.properties = { ...r.properties, id };
      cells.forEach((cell, i) => {
        if (i === 0) {
          cell.tagName = "th";
          cell.properties = { ...cell.properties, scope: "row" };
        }
        cell.properties = { ...cell.properties, dataLabel: head[i] ?? "" };
      });
    }
  };
  const walk = (node: HNode): void => {
    for (const c of kids(node)) {
      if (c.tagName === "table") table(c);
      else walk(c);
    }
  };
  return (tree: HNode) => walk(tree);
}
