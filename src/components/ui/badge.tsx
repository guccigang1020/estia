import type { ComponentProps } from "react";

import { cn } from "./cn";

export type BadgeTone = "neutral" | "brand" | "accent";

const TONE: Record<BadgeTone, string> = {
  neutral: "bg-muted text-muted-foreground",
  brand: "bg-primary-soft text-primary",
  // `accent` is a fill token, so it is always paired with accent-foreground.
  accent: "bg-accent text-accent-foreground",
};

export function Badge({
  tone = "neutral",
  className,
  ...props
}: { tone?: BadgeTone } & ComponentProps<"span">) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold",
        TONE[tone],
        className,
      )}
      {...props}
    />
  );
}
