// One-line plain-language summary of a tool call, from the shapes in contract section 7.5.
// Unknown tool names (or unexpected shapes) return null and the panel falls back to the raw JSON.

export interface TraceBrief {
  /** Key in the language files. */
  key: string;
  params?: Record<string, string | number>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
const str = (v: unknown) => (typeof v === "string" ? v : "");

const SCOPE_KEYS: Record<string, string> = {
  ok: "trace.brief.scopeOk",
  prescription_request: "trace.brief.scopePrescription",
  controlled_drug: "trace.brief.scopeControlled",
  injection: "trace.brief.scopeInjection",
};
const REFILL_KEYS: Record<string, string> = {
  eligible: "trace.brief.refillEligible",
  too_early: "trace.brief.refillTooEarly",
  revisit: "trace.brief.refillRevisit",
  consult: "trace.brief.refillConsult",
};

export function traceBrief(name: string, result: unknown): TraceBrief | null {
  if (!isObj(result)) return null;
  switch (name) {
    case "red_flag_precheck": {
      // `matched` is the shape of an earlier draft; accept it so old stored rows still read well.
      const hit = result.hit === true || result.matched === true;
      return hit ? { key: "trace.brief.redFlagHit", params: { label: str(result.label) } } : { key: "trace.brief.redFlagNone" };
    }
    case "scope_precheck": {
      const key = SCOPE_KEYS[str(result.verdict) || str(result.scope)];
      return key ? { key } : null;
    }
    case "pii_filter":
      return { key: "trace.brief.pii", params: { count: Number(result.masked) || 0, kinds: Array.isArray(result.kinds) ? result.kinds.join("、") : "" } };
    case "record_intake":
      return { key: "trace.brief.intake", params: { applied: len(result.applied), rejected: len(result.rejected) } };
    case "search_health_education":
      return len(result.hits) ? { key: "trace.brief.searchHits", params: { count: len(result.hits) } } : { key: "trace.brief.searchNone" };
    case "check_chronic_refill": {
      const key = REFILL_KEYS[str(result.outcome)];
      return key ? { key } : null;
    }
    case "transfer_to_clinician":
      return result.deduped === true
        ? { key: "trace.brief.transferDeduped", params: { ticket: str(result.ticket_no) } }
        : { key: "trace.brief.transfer", params: { ticket: str(result.ticket_no) } };
    case "save_previsit_summary":
      return result.saved === true ? { key: "trace.brief.saved", params: { count: len(result.not_collected) } } : null;
    case "output_guard":
      if (result.passed === true) return { key: "trace.brief.guardPass" };
      return { key: result.action === "replaced" ? "trace.brief.guardReplaced" : "trace.brief.guardRewritten", params: { violations: Array.isArray(result.violations) ? result.violations.join("、") : "" } };
    default:
      return null;
  }
}

/** True when the red-flag precheck row is a hit (drives the red outline in the trace). */
export function isRedFlagHitResult(result: unknown): boolean {
  return isObj(result) && (result.hit === true || result.matched === true);
}

/** pii_filter rows are shown as a small notice, and only when something was masked. */
export function piiMasked(result: unknown): number {
  return isObj(result) ? Number(result.masked) || 0 : 0;
}

export interface HandbookHit {
  title: string;
  section: string;
  sourceName: string;
  /** http(s) only; anything else is dropped. */
  url: string | null;
}

/** Hits of search_health_education (contract 7.5), for a readable list under the trace row. */
export function handbookHits(result: unknown): HandbookHit[] {
  if (!isObj(result) || !Array.isArray(result.hits)) return [];
  return result.hits.filter(isObj).map((h) => {
    let url: string | null = null;
    try {
      const u = new URL(str(h.source_url));
      url = u.protocol === "https:" || u.protocol === "http:" ? u.toString() : null;
    } catch {
      url = null;
    }
    return { title: str(h.title), section: str(h.section), sourceName: str(h.source_name), url };
  });
}
