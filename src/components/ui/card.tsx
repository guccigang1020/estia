import type { ComponentProps } from "react";

import { cn } from "./cn";

export type CardTone = "default" | "featured";

const TONE: Record<CardTone, string> = {
  default: "border-border bg-surface shadow-soft",
  // `featured` carries a brand outline rather than a different fill, so the
  // emphasis survives a brand swap without a second background token.
  featured:
    "border-primary bg-surface-raised shadow-lift ring-1 ring-primary/25",
};

export function Card({
  tone = "default",
  className,
  ...props
}: { tone?: CardTone } & ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "flex flex-col rounded-xl border p-6 sm:p-7",
        TONE[tone],
        className,
      )}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex flex-col gap-2", className)} {...props} />;
}

/**
 * The heading level is a prop, not a fixed tag: the same visual card title has
 * to sit at different depths without breaking the document outline.
 */
export function CardTitle({
  as: Tag = "h3",
  className,
  ...props
}: { as?: "h2" | "h3" | "h4" } & ComponentProps<"h3">) {
  return (
    <Tag
      className={cn(
        "font-display text-xl font-bold tracking-tight text-foreground",
        className,
      )}
      {...props}
    />
  );
}

export function CardDescription({ className, ...props }: ComponentProps<"p">) {
  return (
    <p
      className={cn("text-sm text-muted-foreground", className)}
      {...props}
    />
  );
}

export function CardContent({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("flex-1", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn("mt-6 border-t border-border pt-5", className)}
      {...props}
    />
  );
}
