import { cn } from "cn";
import type { ComponentProps, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardFooter } from "@/components/ui/card";
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item";
import { Loading } from "./marks";

export function Page({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("mx-auto max-w-(--breakpoint-xl) px-4 py-4 md:px-6 md:py-5", className)}>{children}</div>;
}

// A whole page while its first query loads.
export function PageLoading() {
  return <Page><Loading className="p-0" /></Page>;
}

// The page's title row: name, one faint fact under it, actions at the right.
export function PageTitle({ title, fact, children }: { title: ReactNode; fact?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-4 flex min-h-9 flex-wrap items-center gap-x-3 gap-y-2">
      <div className="min-w-0">
        <h1 className="truncate text-base leading-tight font-semibold">{title}</h1>
        {fact ? <p className="truncate text-faint">{fact}</p> : null}
      </div>
      {children ? <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

// A section heading above a Box. `children` at the right holds controls that scope the box, such as a segmented control.
// Every heading is as tall as those controls, so boxes side by side start on one line whether or not they have any.
export function BoxHeading({ title, children, className }: { title: ReactNode; children?: ReactNode; className?: string }) {
  return (
    <div className={cn("mb-1.5 ml-0.5 flex min-h-8 flex-wrap items-center gap-x-3 gap-y-1.5", className)}>
      <h2 className="text-xs font-semibold text-muted-foreground">{title}</h2>
      {children ? <div className="ml-auto flex flex-wrap items-center gap-2">{children}</div> : null}
    </div>
  );
}

// A flush Card: Rows, tables, Tiles, and a BoxFooter go inside, separated by hairlines. A fieldset that groups Rows needs
// `divide-y` itself to draw the hairlines between them.
export function Box({ className, ...props }: ComponentProps<typeof Card>) {
  return <Card className={cn("gap-0 divide-y py-0", className)} {...props} />;
}

// A BoxHeading and its Box, stacked with the section rhythm. Stretched by its parent, say in a grid row, the Box grows to
// the bottom, so side-by-side sections end on one line.
export function Section({ title, heading, className, children }: { title: ReactNode; heading?: ReactNode; className?: string; children: ReactNode }) {
  return (
    <section className={cn("mt-4 flex flex-col", className)}>
      <BoxHeading title={title}>{heading}</BoxHeading>
      <Box className="flex-1">{children}</Box>
    </section>
  );
}

// One row of a Box: a fixed label, the value with an optional second-line fact, and actions at the right end. `align="start"`
// tops the label for a value that spans several lines.
export function Row({ label, sub, action, className, align = "center", children }: {
  label: ReactNode; sub?: ReactNode; action?: ReactNode; className?: string; align?: "center" | "start"; children?: ReactNode;
}) {
  return (
    <Item size="xs" className={cn(align === "start" && "items-start", className)}>
      <ItemTitle className="w-32 shrink-0">{label}</ItemTitle>
      <ItemContent className="min-w-0">
        <div className="min-w-0">{children}</div>
        {sub ? <ItemDescription className="line-clamp-none">{sub}</ItemDescription> : null}
      </ItemContent>
      {action ? <ItemActions>{action}</ItemActions> : null}
    </Item>
  );
}

// The muted footer of a Box, actions right-aligned. Text at the left, such as a write's outcome, goes in `status`.
export function BoxFooter({ status, children, className }: { status?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <CardFooter className={cn("gap-2 bg-muted/50 py-2", className)}>
      {status ? <div className="min-w-0 flex-1">{status}</div> : null}
      <div className="ml-auto flex items-center gap-2">{children}</div>
    </CardFooter>
  );
}

// A row of stat tiles separated by hairlines, wrapping on narrow screens. Put it alone in a Box.
export function Tiles({ columns = 4, children }: { columns?: 4 | 5 | 7 | 8; children: ReactNode }) {
  const cols = { 4: "md:grid-cols-4", 5: "md:grid-cols-5", 7: "md:grid-cols-7", 8: "md:grid-cols-8" }[columns];
  return <div className={cn("-mt-px -ml-px grid grid-cols-2 *:border-t *:border-l sm:grid-cols-3", cols)}>{children}</div>;
}

export function Tile({ label, value, sub, tone }: { label: ReactNode; value: ReactNode; sub?: ReactNode; tone?: "bad" | "warn" | undefined }) {
  return (
    <div className="min-w-0 px-3 py-2">
      <div className="truncate text-xs text-faint">{label}</div>
      <div className={cn("truncate text-base leading-tight font-semibold tabular-nums", tone === "bad" && "text-bordeaux", tone === "warn" && "text-warning")}>{value}</div>
      {sub ? <div className="truncate text-xs text-faint" title={typeof sub === "string" ? sub : undefined}>{sub}</div> : null}
    </div>
  );
}

// The tinted block an expanded table row opens.
export function Detail({ className, children }: { className?: string; children: ReactNode }) {
  return <div className={cn("border-b bg-muted/60 px-3 py-2.5 whitespace-normal", className)}>{children}</div>;
}

// A full-width action under a table in a Box: "Show more", "Show older". Without `onClick` it is a faint note instead.
export function MoreRow({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  if (!onClick) return <p className="px-3 py-2.5 text-center text-xs text-faint">{children}</p>;
  return <Button variant="ghost" size="lg" className="w-full rounded-none" onClick={onClick}>{children}</Button>;
}
