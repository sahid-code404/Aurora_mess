"use client";

/**
 * Shared form field components for the admin views — glass-skinned, labeled,
 * accessible, mobile-friendly (native inputs where the platform helps).
 */

import { Search } from "lucide-react";
import { useId, type ReactNode } from "react";
import { cn } from "@/lib/utils";

// Money parsing helpers live in format.ts; re-exported here so field
// consumers can import everything from one module.
export { moneyProblem, parseMoneyToMinor } from "./format";

export const FIELD_CLASSES =
  "glass-inset h-11 w-full rounded-md px-3 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring disabled:opacity-60";

function FieldShell({
  label,
  error,
  hint,
  htmlFor,
  children,
  className,
}: {
  label?: ReactNode;
  error?: string | null;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      {label && (
        <label htmlFor={htmlFor} className="mb-1.5 block text-xs font-medium text-muted-foreground">
          {label}
        </label>
      )}
      {children}
      {hint && !error && <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{hint}</p>}
      {error && <p className="mt-1.5 text-[11px] font-medium text-danger">{error}</p>}
    </div>
  );
}

/* --------------------------------------------------------------- text input */

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  error,
  hint,
  maxLength,
  type = "text",
  inputMode,
  disabled,
  className,
  autoFocus,
}: {
  label?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string | null;
  hint?: ReactNode;
  maxLength?: number;
  type?: "text" | "date" | "time" | "number" | "password";
  inputMode?: "text" | "numeric" | "decimal";
  disabled?: boolean;
  className?: string;
  autoFocus?: boolean;
}) {
  const id = useId();
  return (
    <FieldShell label={label} error={error} hint={hint} htmlFor={id} className={className}>
      <input
        id={id}
        type={type}
        inputMode={inputMode}
        value={value}
        maxLength={maxLength}
        disabled={disabled}
        autoFocus={autoFocus}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(FIELD_CLASSES, type === "date" || type === "time" ? "min-h-11" : undefined)}
      />
    </FieldShell>
  );
}

/* -------------------------------------------------------------- text areas */

export function TextAreaField({
  label,
  value,
  onChange,
  placeholder,
  error,
  hint,
  rows = 3,
  maxLength,
  className,
  mono,
}: {
  label?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  error?: string | null;
  hint?: ReactNode;
  rows?: number;
  maxLength?: number;
  className?: string;
  mono?: boolean;
}) {
  const id = useId();
  return (
    <FieldShell label={label} error={error} hint={hint} htmlFor={id} className={className}>
      <textarea
        id={id}
        value={value}
        rows={rows}
        maxLength={maxLength}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(
          "glass-inset w-full resize-y rounded-md px-3 py-2.5 text-sm outline-none placeholder:text-muted-foreground/60 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring",
          mono && "font-mono text-[13px]"
        )}
      />
    </FieldShell>
  );
}

/* -------------------------------------------------------------- money input */

export function MoneyField({
  label,
  value,
  onChange,
  error,
  hint,
  placeholder = "0.00",
  allowNegative,
  className,
}: {
  label?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: ReactNode;
  placeholder?: string;
  allowNegative?: boolean;
  className?: string;
}) {
  const id = useId();
  return (
    <FieldShell label={label} error={error} hint={hint} htmlFor={id} className={className}>
      <div className="glass-inset flex h-11 items-center rounded-md focus-within:outline-2 focus-within:outline-offset-1 focus-within:outline-ring">
        <span className="kpi-num pl-3 text-sm font-semibold text-muted-foreground" aria-hidden>
          ₹
        </span>
        <input
          id={id}
          value={value}
          inputMode="decimal"
          placeholder={placeholder}
          onChange={(e) => {
            const raw = e.target.value;
            const valid = allowNegative
              ? /^-?\d*(\.\d{0,2})?$/.test(raw)
              : /^\d*(\.\d{0,2})?$/.test(raw);
            if (valid || raw === "") onChange(raw);
          }}
          className="h-full min-w-0 flex-1 bg-transparent px-2 text-sm outline-none placeholder:text-muted-foreground/60"
        />
      </div>
    </FieldShell>
  );
}

/* ----------------------------------------------------------------- selects */

export interface SelectOption {
  value: string;
  label: string;
}

export function SelectField({
  label,
  value,
  onChange,
  options,
  error,
  hint,
  placeholder,
  className,
}: {
  label?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  error?: string | null;
  hint?: ReactNode;
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <FieldShell label={label} error={error} hint={hint} htmlFor={id} className={className}>
      <div className="relative">
        <select
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className={cn(FIELD_CLASSES, "appearance-none pr-9")}
        >
          {placeholder !== undefined && <option value="">{placeholder}</option>}
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </div>
    </FieldShell>
  );
}

/* ------------------------------------------------------------ search field */

export function SearchField({
  value,
  onChange,
  placeholder = "Search…",
  className,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const id = useId();
  return (
    <div className={cn("relative min-w-0", className)}>
      <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden />
      <label htmlFor={id} className="sr-only">
        {placeholder}
      </label>
      <input
        id={id}
        type="search"
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(FIELD_CLASSES, "pl-9")}
      />
    </div>
  );
}

/* ------------------------------------------------------------ weekday chips */

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

export function WeekdayPicker({
  selected,
  onToggle,
}: {
  selected: number[];
  onToggle: (weekday: number) => void;
}) {
  return (
    <div role="group" aria-label="Repeat on weekdays" className="flex flex-wrap gap-1.5">
      {WEEKDAYS.map((d, i) => {
        const day = i + 1;
        const active = selected.includes(day);
        return (
          <button
            key={d}
            type="button"
            aria-pressed={active}
            onClick={() => onToggle(day)}
            className={cn(
              "h-11 min-w-11 rounded-pill px-3 text-[13px] font-semibold transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              active
                ? "bg-primary/15 text-primary border border-primary/40"
                : "glass-inset text-muted-foreground hover:text-foreground"
            )}
          >
            {d}
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------- icon picker */

import {
  Apple,
  Cake,
  Coffee,
  Cookie,
  Croissant,
  EggFried,
  IceCream,
  Moon,
  Pizza,
  Salad,
  Sandwich,
  Soup,
  Sun,
  Utensils,
  Wheat,
  CupSoda,
  Donut,
  FishSymbol,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

export const MEAL_ICON_CHOICES: { name: string; label: string; Icon: LucideIcon }[] = [
  { name: "coffee", label: "Coffee", Icon: Coffee },
  { name: "sun", label: "Sun", Icon: Sun },
  { name: "utensils", label: "Utensils", Icon: Utensils },
  { name: "moon", label: "Moon", Icon: Moon },
  { name: "soup", label: "Soup", Icon: Soup },
  { name: "salad", label: "Salad", Icon: Salad },
  { name: "sandwich", label: "Sandwich", Icon: Sandwich },
  { name: "apple", label: "Apple", Icon: Apple },
  { name: "croissant", label: "Croissant", Icon: Croissant },
  { name: "egg", label: "Egg", Icon: EggFried },
  { name: "cake", label: "Cake", Icon: Cake },
  { name: "cookie", label: "Cookie", Icon: Cookie },
  { name: "icecream", label: "Ice cream", Icon: IceCream },
  { name: "pizza", label: "Pizza", Icon: Pizza },
  { name: "donut", label: "Donut", Icon: Donut },
  { name: "wheat", label: "Wheat", Icon: Wheat },
  { name: "soda", label: "Soda", Icon: CupSoda },
  { name: "fish", label: "Fish", Icon: FishSymbol },
];

const ICON_MAP = new Map(MEAL_ICON_CHOICES.map((c) => [c.name, c.Icon]));

/** Resolve a stored icon name to a Lucide component (fallback Utensils). */
export function mealIcon(name: string | null | undefined): LucideIcon {
  return ICON_MAP.get(name ?? "") ?? Utensils;
}

export function IconPicker({ value, onChange }: { value: string; onChange: (name: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Icon" className="grid grid-cols-6 gap-1.5 min-[420px]:grid-cols-9">
      {MEAL_ICON_CHOICES.map(({ name, label, Icon }) => {
        const active = value === name;
        return (
          <button
            key={name}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={label}
            title={label}
            onClick={() => onChange(name)}
            className={cn(
              "flex size-11 items-center justify-center rounded-md transition-colors",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              active
                ? "bg-primary/15 text-primary border border-primary/40"
                : "glass-inset text-muted-foreground hover:text-foreground"
            )}
          >
            <Icon className="size-5" aria-hidden />
          </button>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------ color tokens */

export const COLOR_TOKENS = ["emerald", "amber", "rose", "sky", "slate", "teal"] as const;

const COLOR_SWATCH: Record<string, string> = {
  emerald: "bg-emerald-500",
  amber: "bg-amber-500",
  rose: "bg-rose-500",
  sky: "bg-sky-500",
  slate: "bg-slate-500",
  teal: "bg-teal-500",
};

export function ColorTokenPicker({ value, onChange }: { value: string; onChange: (token: string) => void }) {
  return (
    <div role="radiogroup" aria-label="Accent color" className="flex flex-wrap gap-2">
      {COLOR_TOKENS.map((token) => {
        const active = value === token;
        return (
          <button
            key={token}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={token}
            title={token}
            onClick={() => onChange(token)}
            className={cn(
              "flex size-11 items-center justify-center rounded-pill transition-transform focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
              active && "scale-105 ring-2 ring-ring ring-offset-2"
            )}
          >
            <span className={cn("size-6 rounded-full", COLOR_SWATCH[token])} />
          </button>
        );
      })}
    </div>
  );
}
