import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: ["xs", "sm", "base", "md", "lg", "xl", "2xl", "3xl", "4xl", "5xl", "ctl", "body", "note", "title"] }],
      rounded: [{ rounded: ["cell", "control", "panel", "sheet", "full"] }],
      shadow: [{ shadow: ["1", "2", "3"] }],
    },
  },
});

export function cn(...inputs: ClassValue[]): string {
  return merge(clsx(inputs));
}

/** Tones shared by tags, banners and timelines. `danger` is for emergencies only. */
export type Tone = "mute" | "ok" | "info" | "warn" | "hold" | "ink" | "danger";
