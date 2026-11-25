import { useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import photos from "@/content/photos.json";

import { cn } from "./cn";
import { useLocale } from "./locale";

interface PhotoMeta {
  widths: number[];
  w: number;
  h: number;
  focal?: string;
  blur?: string;
  color?: string;
  alt_zh: string;
  alt_en: string;
  credit?: { photographer: string; source: string; url: string };
}

const META = photos as unknown as Record<string, PhotoMeta | undefined>;

export interface PhotoProps {
  /** Slot name in content/photos.json. A slot that does not exist (yet) renders a quiet ruled sheet. */
  slot: string;
  /** CSS aspect ratio, e.g. "3 / 2". Without it the photo keeps its own. */
  ratio?: string;
  sizes?: string;
  /** Above the fold: eager, high priority. */
  priority?: boolean;
  /** Decorative next to text that already says it. */
  decorative?: boolean;
  credit?: boolean;
  /** One short line under the picture: what it shows, as a record would. */
  caption?: ReactNode;
  className?: string;
  /** Square the picture sits in its box; photographs are never rounded in this design. */
  fill?: boolean;
}

/** Places, objects and hands. AVIF then WebP, blur-up from the JSON, focal point kept when cropped. */
export function Photo({ slot, ratio, sizes = "100vw", priority, decorative, credit, caption, className, fill }: PhotoProps) {
  const { t } = useTranslation("common");
  const locale = useLocale();
  const [loaded, setLoaded] = useState(false);
  const meta = META[slot];
  const box: CSSProperties & { "--photo-focal"?: string; "--photo-color"?: string } = fill ? { position: "absolute", inset: 0 } : { aspectRatio: ratio ?? (meta ? `${meta.w} / ${meta.h}` : "3 / 2") };
  if (!meta) return <div className={cn("photo", className)} data-missing="true" data-slot={slot} style={box} aria-hidden="true" />;

  const set = (ext: string) => meta.widths.map((w) => `/photos/${slot}-${w}.${ext} ${w}w`).join(", ");
  box["--photo-focal"] = meta.focal;
  box["--photo-color"] = meta.color;
  if (meta.blur && !loaded) box.backgroundImage = `url("${meta.blur}")`;
  const img = (
    <div className={cn("photo", className)} data-slot={slot} style={box}>
      <picture>
        <source type="image/avif" srcSet={set("avif")} sizes={sizes} />
        <source type="image/webp" srcSet={set("webp")} sizes={sizes} />
        <img
          src={`/photos/${slot}-${meta.widths[Math.min(1, meta.widths.length - 1)]}.webp`}
          width={meta.w}
          height={meta.h}
          alt={decorative ? "" : locale === "zh-TW" ? meta.alt_zh : meta.alt_en}
          loading={priority ? "eager" : "lazy"}
          fetchPriority={priority ? "high" : undefined}
          decoding="async"
          data-loaded={loaded}
          ref={(el) => {
            if (el?.complete && el.naturalWidth > 0 && !loaded) setLoaded(true);
          }}
          onLoad={() => setLoaded(true)}
        />
      </picture>
    </div>
  );
  const by = credit ? meta.credit : undefined;
  if (!by && !caption) return img;
  return (
    <figure className="photo-figure">
      {img}
      <figcaption className="photo-credit">
        {caption}
        {by && (
          <span className="block">
            {t("photo.credit")}{" "}
            <a className="link" data-quiet="true" href={by.url} target="_blank" rel="noreferrer noopener">
              {by.photographer}
            </a>
            {t("photo.via", { source: by.source })}
          </span>
        )}
      </figcaption>
    </figure>
  );
}

/** Photo credits for the footer or a credits page. */
export function photoCredits(): { slot: string; photographer: string; source: string; url: string }[] {
  return Object.entries(META).flatMap(([slot, m]) => (m?.credit ? [{ slot, ...m.credit }] : []));
}
