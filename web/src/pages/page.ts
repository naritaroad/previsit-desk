import type { ComponentType } from "react";

/** `lazy` for a route whose module default-exports the page component. */
export function page(load: () => Promise<{ default: ComponentType }>) {
  return async () => ({ Component: (await load()).default });
}
