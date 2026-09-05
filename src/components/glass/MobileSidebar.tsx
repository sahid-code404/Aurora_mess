"use client";

/**
 * MobileSidebar — the BoardOps "More" panel, opened at EVERY viewport from
 * the top-left hamburger (always visible) or the bottom bar's "More" slot.
 * Spring slide-in from the left inside a glass-strong floating card:
 * brand header with close · user row · "Search Aurora" row (⌘K) · grouped
 * nav where the active item is a SOLID primary pill with a chevron. Escape
 * closes, body scroll locks, focus is trapped while open, and focus returns
 * to the invoking control when the drawer closes.
 */

import { useEffect, useRef } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import { ChevronRight, LogOut, Search, X } from "lucide-react";
import { navGroups, type NavItem } from "@/components/app/nav";
import type { SessionRole } from "@/hooks/use-session";
import { SPRING_SOFT, SPRING_POP } from "@/lib/motion";
import { gradientForName, initialsOf } from "@/lib/gradients";
import { cn } from "@/lib/utils";

export interface MobileSidebarUser {
  name: string;
  email: string;
  role: SessionRole;
}

export interface MobileSidebarProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: SessionRole;
  activeKey: string;
  onNavigate: (hash: string) => void;
  onSearch: () => void;
  institution?: string | null;
  user?: MobileSidebarUser | null;
  onLogout?: () => void;
  onProfile?: () => void;
  unread?: number | null;
}

const ROLE_LABELS: Record<string, string> = {
  ADMIN: "Administrator",
  RESIDENT: "Resident",
};

const FOCUSABLE_SELECTOR = [
  "button:not([disabled])",
  "a[href]",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex='-1'])",
].join(",");

function DrawerItem({
  item,
  active,
  unread,
  onSelect,
  reduced,
}: {
  item: NavItem;
  active: boolean;
  unread?: number | null;
  onSelect: (hash: string) => void;
  reduced: boolean | null;
}) {
  const Icon = item.icon;
  return (
    <button
      type="button"
      aria-current={active ? "page" : undefined}
      onClick={() => onSelect(item.hash)}
      className={cn(
        "relative flex h-11 w-full items-center gap-3 rounded-pill px-3.5 text-left text-sm font-medium transition-colors",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        active
          ? "bg-primary text-primary-foreground shadow-[0_8px_24px_-8px_color-mix(in_oklab,var(--primary)_65%,transparent)]"
          : "text-muted-foreground hover:bg-foreground/5 hover:text-foreground dark:hover:bg-white/6"
      )}
    >
      <motion.span
        key={`icon-${active}`}
        initial={reduced || !active ? undefined : { scale: 0.6, y: 3 }}
        animate={{ scale: 1, y: 0 }}
        transition={reduced ? { duration: 0 } : SPRING_POP}
        className="shrink-0 [&_svg]:size-[18px]"
      >
        <Icon aria-hidden />
      </motion.span>
      <span className="flex-1 truncate">{item.label}</span>
      {active ? (
        <ChevronRight className="size-4 shrink-0" aria-hidden />
      ) : (
        !!unread &&
        unread > 0 && (
          <span className="kpi-num flex min-w-5 items-center justify-center rounded-pill bg-danger/90 px-1.5 text-[10px] font-bold text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )
      )}
    </button>
  );
}

export function MobileSidebar({
  open,
  onOpenChange,
  role,
  activeKey,
  onNavigate,
  onSearch,
  institution,
  user,
  onLogout,
  onProfile,
  unread,
}: MobileSidebarProps) {
  const reduced = useReducedMotion();
  const groups = navGroups(role);
  const panelRef = useRef<HTMLElement | null>(null);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);

  /* body scroll lock while open */
  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    if (open) document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  /* Modal keyboard behavior: focus entry, Escape, Tab containment, restoration. */
  useEffect(() => {
    if (!open) return;

    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = window.requestAnimationFrame(() => closeButtonRef.current?.focus());

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onOpenChange(false);
        return;
      }
      if (event.key !== "Tab") return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusable = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
        (element) => element.getAttribute("aria-hidden") !== "true" && !element.hasAttribute("disabled")
      );
      if (focusable.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || !panel.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !panel.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [open, onOpenChange]);

  const handleNav = (hash: string) => {
    onOpenChange(false);
    onNavigate(hash);
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* scrim */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduced ? 0 : 0.2 }}
            onClick={() => onOpenChange(false)}
            className="fixed inset-0 z-[var(--z-nav)] bg-black/55 backdrop-blur-sm"
            aria-hidden
          />

          {/* drawer */}
          <motion.aside
            ref={panelRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby="mobile-sidebar-title"
            tabIndex={-1}
            initial={reduced ? { x: 0, opacity: 0 } : { x: "-102%", opacity: 1 }}
            animate={{ x: 0, opacity: 1 }}
            exit={reduced ? { x: 0, opacity: 0 } : { x: "-102%", opacity: 1 }}
            transition={reduced ? { duration: 0 } : { ...SPRING_SOFT, damping: 30, stiffness: 320 }}
            className="fixed inset-y-0 left-0 z-[var(--z-modal)] flex w-[86vw] max-w-[400px] flex-col p-2 md:w-[400px] md:shrink-0"
            style={{
              paddingTop: "calc(env(safe-area-inset-top, 0px) + 8px)",
              paddingBottom: "calc(env(safe-area-inset-bottom, 0px) + 8px)",
            }}
          >
            <div className="glass-strong flex h-full w-full flex-col overflow-hidden rounded-sheet">
              {/* brand */}
              <div className="flex items-center justify-between border-b border-border/40 p-4">
                <div className="flex items-center gap-3">
                  <span className="glow-breathe shrink-0 rounded-lg">
                    <img
                      src="/logo-mark.png"
                      alt=""
                      width={44}
                      height={44}
                      className="size-11 rounded-xl object-cover"
                    />
                  </span>
                  <div className="min-w-0">
                    <p id="mobile-sidebar-title" className="font-display truncate text-[15px] font-bold leading-tight tracking-tight">
                      Aurora Mess
                    </p>
                    <p className="truncate text-[10px] uppercase tracking-wider text-muted-foreground">
                      {institution ?? "Operations Suite"}
                    </p>
                  </div>
                </div>
                <button
                  ref={closeButtonRef}
                  type="button"
                  onClick={() => onOpenChange(false)}
                  aria-label="Close menu"
                  className="glass-inset flex size-11 shrink-0 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <X className="size-5" aria-hidden />
                </button>
              </div>

              {/* user + search */}
              <div className="space-y-3 border-b border-border/40 p-4">
                <button
                  type="button"
                  onClick={() => {
                    if (onProfile) {
                      onOpenChange(false);
                      onProfile();
                    }
                  }}
                  disabled={!onProfile}
                  className={cn(
                    "flex w-full items-center gap-3 rounded-xl p-1.5 text-left transition-colors",
                    onProfile && "hover:bg-foreground/5 dark:hover:bg-white/6"
                  )}
                >
                  <span
                    className={cn(
                      "grid size-11 shrink-0 place-items-center rounded-xl bg-gradient-to-br text-sm font-bold text-white",
                      gradientForName(user?.name ?? "U")
                    )}
                  >
                    {user ? initialsOf(user.name) : "?"}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-semibold">{user?.name ?? "Signed in"}</p>
                    <p className="truncate text-[11px] text-muted-foreground">
                      {ROLE_LABELS[user?.role ?? "RESIDENT"] ?? user?.role}
                    </p>
                  </div>
                  {onProfile && <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />}
                </button>

                <button
                  type="button"
                  onClick={() => {
                    onOpenChange(false);
                    onSearch();
                  }}
                  aria-label="Search Aurora"
                  className="glass-inset flex w-full items-center gap-3 rounded-pill px-3.5 py-3 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                >
                  <Search className="size-[18px] shrink-0" aria-hidden />
                  <span className="flex-1 text-left">Search Aurora</span>
                  <span className="text-[10px] text-muted-foreground/70">⌘K</span>
                </button>
              </div>

              {/* grouped nav */}
              <nav aria-label="Drawer" className="flex-1 space-y-5 overflow-y-auto px-3 py-4">
                {groups.map((group) => (
                  <div key={group.label}>
                    <p className="mb-2 px-3.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      {group.label}
                    </p>
                    <div className="space-y-1">
                      {group.items.map((item) => (
                        <DrawerItem
                          key={item.key}
                          item={item}
                          active={item.key === activeKey}
                          unread={item.key.endsWith("-notifications") ? unread : null}
                          onSelect={handleNav}
                          reduced={reduced}
                        />
                      ))}
                    </div>
                  </div>
                ))}
              </nav>

              {/* sign out */}
              {onLogout && (
                <div className="border-t border-border/40 p-3">
                  <button
                    type="button"
                    onClick={() => {
                      onOpenChange(false);
                      onLogout();
                    }}
                    className="flex h-11 w-full items-center gap-3 rounded-pill px-3.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-danger/12 hover:text-danger focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                  >
                    <LogOut className="size-[18px] shrink-0" aria-hidden />
                    Sign out
                  </button>
                </div>
              )}
            </div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

export default MobileSidebar;
