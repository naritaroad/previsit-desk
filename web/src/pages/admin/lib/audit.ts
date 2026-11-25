// Audit rows in words. Codes the interface does not know are shown as they are: an audit log must not hide a row.

import { useMemo } from "react";
import { useTranslation } from "react-i18next";

import type { AuditEntry } from "@/api/types";
import { joinList } from "@/lib/format";
import { useLocale } from "@/ui";

export const AUDIT_KINDS = ["admin", "access", "rx", "auth", "clinic"] as const satisfies readonly AuditEntry["kind"][];

/** Actions the server writes today, by kind, for the filter. */
export const AUDIT_ACTIONS: Readonly<Record<AuditEntry["kind"], readonly string[]>> = {
  admin: ["account.create", "account.update", "account.reset_password", "account.revoke_sessions", "settings.update", "demo.reset"],
  access: ["read", "list", "resolve"],
  rx: ["rx.create", "rx.submit", "rx.reply", "rx.cancel", "rx.assign", "rx.decide", "rx.pharmacy", "rx.message", "rx.red_flag"],
  auth: ["login", "login.failed", "account.claim", "account.delete_self", "password.change"],
  clinic: ["visit.assign", "visit.takeover", "visit.release", "note.sign", "note.addendum", "ticket.resolve", "patient.update", "staff_note.delete"],
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const keyOf = (code: string) => code.replace(/[.:]/g, "_");

/** "account:8f3c…" -> kind and id. */
export function splitTarget(target: string): { kind: string; id: string } {
  const i = target.indexOf(":");
  return i === -1 ? { kind: target, id: "" } : { kind: target.slice(0, i), id: target.slice(i + 1) };
}
export function shortId(id: string): string {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(id) ? id.slice(0, 8) : id;
}

export function useAuditText() {
  const { t } = useTranslation("admin");
  const { t: ts } = useTranslation("shell");
  const { t: tc } = useTranslation("common");
  const locale = useLocale();
  return useMemo(() => {
    const setting = (path: string) => (path.startsWith("ai.prices") ? t("setting.prices", { model: path.slice("ai.prices.".length) }) : t(`setting.${keyOf(path)}`, { defaultValue: path }));
    const action = (code: string) => t(`auditAction.${keyOf(code)}`, { defaultValue: code });
    const target = (entry: Pick<AuditEntry, "target">) => {
      const { kind, id } = splitTarget(entry.target);
      const name = t(`auditTarget.${kind}`, { defaultValue: kind });
      return id && id !== "all" && id !== "list" && id !== "platform" ? `${name} ${shortId(id)}` : name;
    };
    const detail = (entry: Pick<AuditEntry, "action" | "detail">): string => {
      const d = entry.detail;
      if (typeof d === "string") return d;
      if (!isObj(d)) return "";
      if (Array.isArray(d.changed)) return t("auditDetail.changed", { list: joinList(d.changed.map((c) => setting(String(c))), locale) });
      const parts: string[] = [];
      for (const [k, v] of Object.entries(d)) {
        if (v === null || v === false || v === "") continue;
        if (k === "role") parts.push(t("auditDetail.role", { value: ts(`role.${String(v)}`, { defaultValue: String(v) }) }));
        else if (k === "status") parts.push(t("auditDetail.status", { value: tc(`status.account.${String(v)}`, { defaultValue: String(v) }) }));
        else if (k === "revoked") parts.push(t("auditDetail.revoked", { count: Number(v) }));
        else if (v === true) parts.push(t(`auditDetail.flag_${k}`, { defaultValue: k }));
        else parts.push(`${t(`auditDetail.key_${k}`, { defaultValue: k })} ${typeof v === "object" ? JSON.stringify(v) : String(v)}`);
      }
      return joinList(parts, locale);
    };
    return { action, target, detail, setting };
  }, [t, ts, tc, locale]);
}
