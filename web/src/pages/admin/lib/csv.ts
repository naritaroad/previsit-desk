/** RFC 4180 with a BOM, so spreadsheet programs open Chinese text. Cells that could run as a formula get a leading '. */
export function toCsv(head: readonly string[], rows: readonly (readonly (string | number | null)[])[]): string {
  const cell = (v: string | number | null) => {
    if (v === null) return "";
    const s = typeof v === "number" ? String(v) : /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
    return /[",\r\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
  };
  return `﻿${[head, ...rows].map((r) => r.map(cell).join(",")).join("\r\n")}\r\n`;
}

export function downloadText(name: string, text: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
