// Quick answers under the conversation. They only appear when the assistant's last question clearly asks for one of
// these things, and they write text into the composer: nothing is sent by tapping a chip.

export type Asked = "severity" | "onset" | "location" | "course" | "lists" | "associated" | "yesno";

const PATTERNS: readonly [Asked, RegExp][] = [
  ["severity", /0\s*(?:分)?\s*(?:到|至|～|~|-|–|to)\s*10|0 分是|scale of/i],
  ["onset", /什麼時候開始|多久了|從哪一天|何時開始|幾天了|when did (?:it|this|the)|how long (?:have|has|ago)/i],
  ["course", /比較好.{0,12}(?:糟|差)|變(?:嚴重|好|差)|better.{0,12}worse|worse.{0,12}better/i],
  ["location", /哪個部位|什麼部位|哪一?邊|哪個位置|where do you feel|where exactly|which part/i],
  ["lists", /過敏|慢性病|開過刀|病史|哪些藥|保健食品|allerg|long-term condition|operations|which medicines|supplements/i],
  ["associated", /還有.{0,10}不舒服|其他(?:症狀|不舒服)|anything else|other symptoms/i],
  ["yesno", /有沒有|是不是|會不會|嗎[？?]|^(?:do|does|did|is|are|have|has|any)\b/im],
];

/** The last question of a message, or null when it does not end with one. */
export function lastQuestion(text: string): string | null {
  const m = text.trim().match(/[^。！？?!\n]*[？?](?:[^。！？?!\n]*。)?[^。！？?!\n]*$/);
  return m ? m[0] : null;
}

export function askedIn(text: string): Asked | null {
  const q = lastQuestion(text);
  if (!q) return null;
  // Scale and list questions put the hint after the question mark, so look at the tail of the message too.
  const tail = text.slice(-160);
  for (const [kind, re] of PATTERNS) if (re.test(kind === "yesno" ? q.trim() : kind === "severity" || kind === "lists" ? tail : q)) return kind;
  return null;
}

/** Chip keys under patient:quick.<kind>. */
export const CHIPS: Readonly<Record<Exclude<Asked, "severity">, readonly string[]>> = {
  onset: ["today", "yesterday", "days", "week", "month", "longer"],
  location: ["head", "throat", "chest", "belly", "back", "arm", "leg", "skin"],
  course: ["better", "same", "worse", "comesAndGoes"],
  lists: ["none", "asRecord", "unsure"],
  associated: ["none", "some"],
  yesno: ["yes", "no", "unsure"],
};

/** Puts a chip's text after what is already written. */
export function appendText(current: string, text: string, sep: string): string {
  const base = current.replace(/\s+$/, "");
  return base === "" ? text : `${base}${/[，。、,.;；]$/.test(base) ? "" : sep}${text}`;
}
