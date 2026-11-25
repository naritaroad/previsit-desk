// Inline stroke icons (24px grid), the set drawn in docs/design/mockup.html. The classes `icon`,
// `icon-sm` and `icon-lg` come from base.css. Icons are decorative: the visible text carries the meaning.

import type { ReactNode } from "react";

const PATHS = {
  info: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 11v5M12 8h.01" />
    </>
  ),
  "check-circle": (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M8 12.5l2.7 2.7L16 9.8" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  clock: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3.5 2" />
    </>
  ),
  calendar: (
    <>
      <rect x="3.5" y="5" width="17" height="15" rx="2" />
      <path d="M3.5 10h17M8 3v4M16 3v4M9 15h6M13 13l2 2-2 2" />
    </>
  ),
  "person-chat": (
    <>
      <circle cx="9" cy="8" r="3.5" />
      <path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6" />
      <path d="M15 4h5a1 1 0 0 1 1 1v3.5a1 1 0 0 1-1 1h-2.5L15.5 11V9.5H15a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1z" />
    </>
  ),
  alert: (
    <>
      <path d="M10.3 4.2L2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z" />
      <path d="M12 9.5v4.5M12 17h.01" />
    </>
  ),
  phone: <path d="M5 4h3.5l1.8 4.5-2.3 1.4a11 11 0 0 0 6.1 6.1l1.4-2.3L20 15.5V19a1.5 1.5 0 0 1-1.6 1.5A16 16 0 0 1 3.5 5.6 1.5 1.5 0 0 1 5 4z" />,
  code: <path d="M8.5 8L4.5 12l4 4M15.5 8l4 4-4 4" />,
  spark: (
    <>
      <path d="M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2L5 10.5l5.2-1.8z" />
      <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </>
  ),
  form: (
    <>
      <rect x="4.5" y="3.5" width="15" height="17" rx="2" />
      <path d="M8 8.5h8M8 12h8M8 15.5h5" />
    </>
  ),
  slash: (
    <>
      <circle cx="12" cy="12" r="9" />
      <path d="M5.6 5.6l12.8 12.8" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />,
  send: (
    <>
      <path d="M4 12l16-8-6 16-2.5-6.5z" />
      <path d="M11.5 13.5L20 4" />
    </>
  ),
  chat: <path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-8l-4.5 3.5v-3.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5z" />,
  list: (
    <>
      <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      <circle cx="5" cy="6.5" r="1" />
      <circle cx="5" cy="12" r="1" />
      <circle cx="5" cy="17.5" r="1" />
    </>
  ),
  doc: (
    <>
      <path d="M6 3.5h8l4.5 4.5v12a.5.5 0 0 1-.5.5H6a.5.5 0 0 1-.5-.5V4a.5.5 0 0 1 .5-.5z" />
      <path d="M14 3.5V8h4.5M9 12.5h6M9 16h6" />
    </>
  ),
  pill: (
    <>
      <rect x="2.8" y="8.5" width="18.4" height="7" rx="3.5" transform="rotate(-35 12 12)" />
      <path d="M9.3 8.2l5.4 7.6" />
    </>
  ),
  shield: (
    <>
      <path d="M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6z" />
      <path d="M8.8 12l2.3 2.3 4.2-4.6" />
    </>
  ),
  back: <path d="M14.5 6l-6 6 6 6" />,
  search: (
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4 4" />
    </>
  ),
  ticket: (
    <>
      <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h14a1.5 1.5 0 0 1 1.5 1.5V10a2 2 0 0 0 0 4v2.5A1.5 1.5 0 0 1 19 18H5a1.5 1.5 0 0 1-1.5-1.5V14a2 2 0 0 0 0-4z" />
      <path d="M14 6v12" strokeDasharray="2 2" />
    </>
  ),
  // Not in the mockup sprite; drawn in the same style.
  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  refresh: (
    <>
      <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
      <path d="M19.5 4.5v4h-4" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  wifi: (
    <>
      <path d="M3.5 9.5a12 12 0 0 1 17 0M6.5 12.8a8 8 0 0 1 11 0M9.5 16a4 4 0 0 1 5 0" />
      <path d="M12 19.5h.01" />
    </>
  ),
  external: <path d="M14 4.5h5.5V10M19.5 4.5L11 13M17.5 14v4.5a1 1 0 0 1-1 1h-10a1 1 0 0 1-1-1v-10a1 1 0 0 1 1-1H10" />,
  chevron: <path d="M9 6l6 6-6 6" />,
  logout: (
    <>
      <path d="M10 4.5H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h4" />
      <path d="M15 8l4 4-4 4M19 12H9.5" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size }: { name: IconName; size?: "sm" | "lg" }) {
  const cls = size === "sm" ? "icon icon-sm" : size === "lg" ? "icon icon-lg" : "icon";
  return (
    <svg className={cls} viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      {PATHS[name]}
    </svg>
  );
}

/** The product mark (speech bubble with a check), colours from the theme tokens. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <path
        fill="var(--color-primary)"
        d="M8 3h16a6 6 0 0 1 6 6v10a6 6 0 0 1-6 6H13.5l-5.6 4.4A1 1 0 0 1 6.3 28.6V24.6A6 6 0 0 1 2 19V9a6 6 0 0 1 6-6z"
      />
      <g fill="none" stroke="var(--color-primary-contrast)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8.5 13.6l3 3 5.5-6" />
        <path d="M20 11.5h4.5M20 16.5h3" />
      </g>
    </svg>
  );
}
