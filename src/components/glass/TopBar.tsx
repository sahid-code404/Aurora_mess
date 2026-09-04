"use client";

/**
 * TopBar — the floating command bar, rendered at ALL viewports inside the
 * content column (navigation lives in the fixed bottom bar). Sticky glass
 * pill (max-w-6xl, centered, navigation radius): hamburger (EVERY viewport —
 * always top-left, opens the More panel/drawer) · dual-line animated title
 * (context label + view label) · search (⌘K palette, visible at every size)
 * · theme popover (light/dark/system with a spring check) · notification
 * bell with a popping unread badge · gradient avatar with the account dropdown.
 */

import { AnimatePresence, motion } from "framer-motion";
import { Bell, Check, LogOut, Menu, Monitor, Moon, Search, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useMounted } from "@/hooks/use-mounted";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { StatusBadge } from "./StatusBadge";
import { gradientForName, initialsOf } from "@/lib/gradients";
import { SPRING_POP } from "@/lib/motion";
import { cn } from "@/lib/utils";

export interface TopBarUser {
  name: string;
  email: string;
  role: "ADMIN" | "RESIDENT";
}

export interface TopBarProps {
  title: string;
  /** Tiny context line above the title ("Admin Console" / "Workspace"). */
  context: string;
  unread?: number | null;
  onBellClick?: () => void;
  onMenuClick: () => void;
  onSearchClick: () => void;
  user?: TopBarUser | null;
  onLogout?: () => void;
  onProfile?: () => void;
  className?: string;
}

/* ---- theme popover (light / dark / system) ---- */

function ThemeSwitcher() {
  const { theme, resolvedTheme, setTheme } = useTheme();
  const mounted = useMounted();
  const isDark = mounted && resolvedTheme === "dark";
  const current = mounted ? (theme ?? "system") : "system";

  const options = [
    { value: "light", label: "Light", icon: Sun },
    { value: "dark", label: "Dark", icon: Moon },
    { value: "system", label: "System", icon: Monitor },
  ] as const;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Theme switcher"
          suppressHydrationWarning
          className="glass-inset flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-2xl text-foreground transition-all duration-150 hover:text-primary active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <AnimatePresence mode="wait" initial={false}>
            <motion.span
              key={isDark ? "sun" : "moon"}
              initial={{ rotate: -90, opacity: 0, scale: 0.5 }}
              animate={{ rotate: 0, opacity: 1, scale: 1 }}
              exit={{ rotate: 90, opacity: 0, scale: 0.5 }}
              transition={{ duration: 0.2 }}
              className="grid place-items-center"
            >
              {isDark ? <Sun className="size-[18px]" aria-hidden /> : <Moon className="size-[18px]" aria-hidden />}
            </motion.span>
          </AnimatePresence>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        side="bottom"
        sideOffset={10}
        className="glass-strong min-w-40 rounded-2xl border-0 p-1.5"
      >
        {options.map((option) => {
          const active = current === option.value;
          const Icon = option.icon;
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => setTheme(option.value)}
              className={cn(
                "gap-2.5 rounded-xl px-3 py-2.5 text-sm font-medium cursor-pointer transition-colors duration-150",
                active && "bg-primary text-primary-foreground font-semibold"
              )}
            >
              <Icon className="size-4" aria-hidden />
              <span className="flex-1">{option.label}</span>
              {active && (
                <Check className="size-4 shrink-0 stroke-[2.5]" aria-hidden />
              )}
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* ---- the bar ---- */

export function TopBar({
  title,
  context,
  unread,
  onBellClick,
  onMenuClick,
  onSearchClick,
  user,
  onLogout,
  onProfile,
  className,
}: TopBarProps) {
  return (
    <header
      className={cn(
        "sticky top-0 z-[var(--z-appbar)] px-3 pt-3 sm:px-4 lg:px-6",
        className
      )}
      style={{ paddingTop: "calc(env(safe-area-inset-top, 0px) + 12px)" }}
    >
      <div className="glass-nav mx-auto flex max-w-6xl items-center gap-1.5 rounded-3xl px-3 py-2.5 sm:gap-2">
        {/* hamburger → More panel / drawer */}
        <motion.button
          type="button"
          aria-label="Open menu"
          whileTap={{ scale: 0.9 }}
          transition={SPRING_POP}
          onClick={onMenuClick}
          className="glass-inset flex size-10 shrink-0 items-center justify-center rounded-2xl text-foreground transition-colors hover:text-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Menu className="size-5" aria-hidden />
        </motion.button>

        {/* dual-line animated title */}
        <div className="min-w-0 flex-1 pl-1">
          <motion.p
            key={`${context}-ctx`}
            initial={{ opacity: 0, x: -8 }}
            animate={{ opacity: 1, x: 0 }}
            className="truncate text-[10px] leading-tight text-muted-foreground"
          >
            {context}
          </motion.p>
          <AnimatePresence mode="wait" initial={false}>
            <motion.h1
              key={title}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              className="truncate font-display text-sm font-semibold leading-tight tracking-tight"
            >
              {title}
            </motion.h1>
          </AnimatePresence>
        </div>

        {/* search → palette (visible on all viewports) */}
        <motion.button
          type="button"
          aria-label="Search (Ctrl+K)"
          whileTap={{ scale: 0.9 }}
          transition={SPRING_POP}
          onClick={onSearchClick}
          className="glass-inset flex size-10 shrink-0 items-center justify-center rounded-2xl text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Search className="size-[18px]" aria-hidden />
        </motion.button>

        <ThemeSwitcher />

        {/* bell */}
        <motion.button
          type="button"
          onClick={onBellClick}
          aria-label={unread ? `Notifications — ${unread} unread` : "Notifications"}
          whileTap={{ scale: 0.88 }}
          whileHover={{ scale: 1.06 }}
          transition={SPRING_POP}
          className="glass-inset relative flex size-10 shrink-0 items-center justify-center rounded-2xl text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          <Bell className="size-[18px]" aria-hidden />
          <AnimatePresence>
            {!!unread && unread > 0 && (
              <motion.span
                key={unread}
                initial={{ scale: 0.3, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                exit={{ scale: 0.3, opacity: 0 }}
                transition={SPRING_POP}
                className="pulse-dot absolute -top-1 -right-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-bold text-white shadow-[0_2px_8px_color-mix(in_oklab,var(--destructive)_60%,transparent)]"
              >
                {unread > 9 ? "9+" : unread}
              </motion.span>
            )}
          </AnimatePresence>
        </motion.button>

        {/* avatar → account menu */}
        {user && (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                aria-label="Account menu"
                className={cn(
                  "relative size-10 shrink-0 cursor-pointer overflow-hidden rounded-2xl",
                  "ring-2 ring-border/50 transition-all duration-150 hover:ring-primary/60 active:scale-95",
                  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
                )}
              >
                <span
                  className={cn(
                    "grid h-full w-full place-items-center bg-gradient-to-br text-sm font-bold text-white",
                    gradientForName(user.name)
                  )}
                >
                  {initialsOf(user.name)}
                </span>
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="bottom"
              sideOffset={10}
              className="glass-strong min-w-56 rounded-xl border-0 p-1.5"
            >
              <DropdownMenuLabel className="px-2.5 py-2">
                <p className="truncate text-sm font-semibold">{user.name}</p>
                <p className="truncate text-xs font-normal text-muted-foreground">{user.email}</p>
              </DropdownMenuLabel>
              <div className="px-2.5 pb-2">
                <StatusBadge
                  status={user.role === "ADMIN" ? "ADMIN_OVERRIDE" : "ACTIVE"}
                  label={user.role === "ADMIN" ? "Admin" : "Resident"}
                />
              </div>
              <DropdownMenuSeparator className="bg-border" />
              {onProfile && <DropdownMenuItem onSelect={onProfile}>Profile</DropdownMenuItem>}
              {onLogout && (
                <>
                  <DropdownMenuSeparator className="bg-border" />
                  <DropdownMenuItem
                    variant="destructive"
                    onSelect={() => onLogout()}
                    className="text-destructive focus:text-destructive"
                  >
                    <LogOut className="size-4" aria-hidden />
                    Sign out
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>
    </header>
  );
}

export default TopBar;
