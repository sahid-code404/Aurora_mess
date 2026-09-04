"use client";

/**
 * CommandPalette — ⌘K / Ctrl+K / F8 quick navigation (BoardOps pattern).
 * Grouped by the nav taxonomy (Workspace / Finance / Administration / Account)
 * with fuzzy search over labels + keywords. Selecting an item routes the
 * hash and closes the palette.
 */

import { useEffect } from "react";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { paletteItems, navGroups } from "@/components/app/nav";
import type { SessionRole } from "@/hooks/use-session";

export interface CommandPaletteProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: SessionRole;
  onNavigate: (hash: string) => void;
}

export function CommandPalette({ open, onOpenChange, role, onNavigate }: CommandPaletteProps) {
  /* Global hotkeys: ⌘K / Ctrl+K toggles, F8 toggles (BoardOps parity). */
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        onOpenChange(!open);
      }
      if (event.key === "F8") {
        event.preventDefault();
        onOpenChange(!open);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onOpenChange]);

  const items = paletteItems(role);
  const groups = navGroups(role);

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      title="Search Aurora"
      description="Jump to a section…"
      className="glass-strong rounded-lg border-0"
    >
      <CommandInput placeholder="Search navigation…" />
      <CommandList>
        <CommandEmpty>No results found.</CommandEmpty>
        {groups.map((group) => {
          const groupItems = items.filter((i) => i.group === group.label);
          if (groupItems.length === 0) return null;
          return (
            <CommandGroup key={group.label} heading={group.label}>
              {groupItems.map((item) => {
                const Icon = item.icon;
                return (
                  <CommandItem
                    key={item.key}
                    value={`${item.label} ${item.keywords?.join(" ") ?? ""}`}
                    onSelect={() => {
                      onOpenChange(false);
                      onNavigate(item.hash);
                    }}
                  >
                    <Icon className="size-4" aria-hidden />
                    <span>{item.label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          );
        })}
      </CommandList>
    </CommandDialog>
  );
}

export default CommandPalette;
