import type { ComponentProps } from "react";

import { cn } from "./cn";

export type ButtonVariant = "primary" | "secondary" | "ghost";
export type ButtonSize = "sm" | "md" | "lg";

type StyleProps = {
  variant?: ButtonVariant;
  size?: ButtonSize;
};

/**
 * A Button is either a real `<button>` or, when `href` is given, an `<a>`
 * styled identically. `href` is the discriminant, so TypeScript hands each
 * branch the right DOM props.
 */
export type ButtonProps =
  | (StyleProps & ComponentProps<"button"> & { href?: never })
  | (StyleProps & ComponentProps<"a"> & { href: string });

const BASE =
  "inline-flex items-center justify-center gap-2 rounded-full font-medium " +
  "whitespace-nowrap transition-colors duration-150 " +
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring " +
  "disabled:pointer-events-none disabled:opacity-50";

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "bg-primary text-primary-foreground shadow-soft hover:bg-primary/90 active:bg-primary/80",
  secondary:
    "border border-border-strong bg-surface text-foreground hover:bg-muted active:bg-muted",
  ghost: "text-foreground hover:bg-muted active:bg-muted",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-9 px-4 text-sm",
  md: "h-11 px-5 text-[0.9375rem]",
  lg: "h-13 px-7 text-base",
};

export function Button({
  variant = "primary",
  size = "md",
  className,
  ...props
}: ButtonProps) {
  const classes = cn(BASE, VARIANT[variant], SIZE[size], className);

  if (props.href !== undefined) {
    return <a className={classes} {...props} />;
  }

  return <button type="button" className={classes} {...props} />;
}
