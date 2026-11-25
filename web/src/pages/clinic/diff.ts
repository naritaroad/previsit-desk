// Word diff for the AI draft and what people made of it. CJK text has no spaces, so every CJK character is a token.

export interface DiffPart {
  op: "same" | "add" | "del";
  text: string;
}

const TOKEN = /[A-Za-z0-9]+(?:[.,/:%][A-Za-z0-9]+)*|\s+|./gsu;
export const tokens = (s: string): string[] => s.match(TOKEN) ?? [];

/** Beyond this many cells the middle is shown as one replacement; nobody reads a diff that large. */
const MAX_CELLS = 4_000_000;

export function diffText(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a[a.length - 1 - end] === b[b.length - 1 - end]) end++;
  const x = a.slice(start, a.length - end);
  const y = b.slice(start, b.length - end);
  const out: DiffPart[] = [];
  const push = (op: DiffPart["op"], text: string) => {
    if (text === "") return;
    const last = out.at(-1);
    if (last?.op === op) last.text += text;
    else out.push({ op, text });
  };
  push("same", a.slice(0, start).join(""));
  if (x.length * y.length > MAX_CELLS) {
    push("del", x.join(""));
    push("add", y.join(""));
  } else {
    const w = y.length + 1;
    const lcs = new Uint16Array((x.length + 1) * w);
    for (let i = x.length - 1; i >= 0; i--)
      for (let j = y.length - 1; j >= 0; j--) lcs[i * w + j] = x[i] === y[j] ? lcs[(i + 1) * w + j + 1] + 1 : Math.max(lcs[(i + 1) * w + j], lcs[i * w + j + 1]);
    let i = 0;
    let j = 0;
    while (i < x.length && j < y.length) {
      if (x[i] === y[j]) {
        push("same", x[i]);
        i++;
        j++;
      } else if (lcs[(i + 1) * w + j] >= lcs[i * w + j + 1]) push("del", x[i++]);
      else push("add", y[j++]);
    }
    push("del", x.slice(i).join(""));
    push("add", y.slice(j).join(""));
  }
  push("same", end ? a.slice(-end).join("") : "");
  return out;
}

export const changed = (parts: readonly DiffPart[]): boolean => parts.some((p) => p.op !== "same");
