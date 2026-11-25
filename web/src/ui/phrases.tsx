import { Fragment } from "react";

const CJK = /[\u3400-\u9fff]/;
/** A run up to and including its closing punctuation. */
const RUN = /[^\uff0c\u3002\u3001\uff1b\uff1a\uff01\uff1f]+[\uff0c\u3002\u3001\uff1b\uff1a\uff01\uff1f]*/g;

/**
 * Chinese display text that breaks between phrases. Each phrase moves to the next line whole; when even a whole line
 * is too short for it, it wraps inside, and its last two characters stay with the punctuation so that a full stop
 * never sits alone. Latin text is returned as it is. Use it for headings and ledes, not for body copy.
 */
export function Phrases({ text }: { text: string }) {
  if (!CJK.test(text)) return text;
  const runs = text.match(RUN) ?? [text];
  return (
    <>
      {runs.map((run, i) => {
        const chars = [...run];
        const closing = chars.length - [...run.replace(/[\uff0c\u3002\u3001\uff1b\uff1a\uff01\uff1f]+$/, "")].length;
        const keep = Math.min(chars.length, closing + 2);
        return (
          <Fragment key={i}>
            <span className="phrase">
              {chars.slice(0, -keep).join("")}
              <span className="whitespace-nowrap">{chars.slice(-keep).join("")}</span>
            </span>
            <wbr />
          </Fragment>
        );
      })}
    </>
  );
}
