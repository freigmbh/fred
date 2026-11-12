import { cn } from "cn";
import { Link } from "@tanstack/react-router";
import { DollarSignIcon, DownloadIcon, FolderIcon, LayoutDashboardIcon, ListIcon, MenuIcon, SquareCheckBigIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { useFredVersion } from "@/lib/version";
import { ThemeSwitch } from "./theme-switch";

// Nav entries with their icon tile color token: muted per section, Frei green for Overview.
const pages = [
  { to: "/", label: "Overview", tile: "bg-nav-overview", Icon: LayoutDashboardIcon },
  { to: "/queue", label: "Queue", tile: "bg-nav-queue", Icon: ListIcon },
  { to: "/reviews", label: "Reviews", tile: "bg-nav-reviews", Icon: SquareCheckBigIcon },
  { to: "/spend", label: "Spend", tile: "bg-nav-spend", Icon: DollarSignIcon },
  { to: "/projects", label: "Projects", tile: "bg-nav-projects", Icon: FolderIcon },
  { to: "/export", label: "Export", tile: "bg-nav-export", Icon: DownloadIcon },
] as const;

// The FRED face in a rounded tile, from public/fred-logo.svg.
export function Face({ className }: { className?: string }) {
  return <img src="/fred-logo.svg" alt="" className={cn("size-7.5 rounded-lg", className)} />;
}

// The FRED face next to the wordmark and the deployed version, on one line. Local development has no version.
function Brand() {
  const version = useFredVersion();
  return (
    <span className="inline-flex items-baseline gap-2">
      <Face className="size-5 self-center rounded-sm" />
      <span className="text-base font-extrabold tracking-tight text-brand italic">FRED</span>
      {version ? <span className="font-mono text-xs text-faint" title="Deployed FRED version">v{version}</span> : null}
    </span>
  );
}

function NavItem({ page, onNavigate }: { page: (typeof pages)[number]; onNavigate: () => void }) {
  return (
    <Link to={page.to} onClick={onNavigate} activeOptions={{ exact: page.to === "/" }}
      className="flex items-center gap-2 rounded-md px-2 py-1 font-medium outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring/40"
      activeProps={{ className: "bg-sidebar-primary text-sidebar-primary-foreground" }}
      inactiveProps={{ className: "text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground" }}>
      {({ isActive }) => (
        <>
          <span className={cn("inline-grid size-5 shrink-0 place-items-center rounded-sm", isActive ? "bg-sidebar-primary-foreground/25 text-sidebar-primary-foreground" : cn("text-white", page.tile))} aria-hidden>
            <page.Icon className="size-3" />
          </span>
          {page.label}
        </>
      )}
    </Link>
  );
}

// The left sidebar: brand, nav, and a footer with the theme switch and Log out. Under the md breakpoint it is a
// top bar with a menu button that opens the same content below it.
export function Sidebar({ onLogout }: { onLogout: () => void }) {
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);
  return (
    <aside className="flex flex-col border-b border-sidebar-border bg-sidebar text-sidebar-foreground md:sticky md:top-0 md:h-svh md:w-55 md:shrink-0 md:border-r md:border-b-0">
      <div className="flex h-11 items-center px-4 md:h-auto md:pt-3.5 md:pb-2">
        <Brand />
        <Button variant="ghost" size="icon" aria-expanded={open} aria-controls="sidebar-menu" aria-label="Menu" onClick={() => setOpen(!open)} className="ml-auto md:hidden">
          {open ? <XIcon /> : <MenuIcon />}
        </Button>
      </div>
      <div id="sidebar-menu" className={cn("flex-col px-2.5 pb-2.5 md:flex md:min-h-0 md:flex-1", open ? "flex" : "hidden")}>
        <nav aria-label="Pages" className="flex flex-col gap-0.5">
          {pages.map((page) => <NavItem key={page.to} page={page} onNavigate={close} />)}
        </nav>
        <div className="md:flex-1" />
        <div className="mt-2 flex items-center justify-between border-t border-sidebar-border px-1.5 pt-3">
          <ThemeSwitch />
          <Button variant="ghost" size="sm" onClick={onLogout}>Log out</Button>
        </div>
      </div>
    </aside>
  );
}
