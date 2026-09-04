/**
 * gradients.ts — deterministic per-user visual identity (BoardOps pattern).
 * A name always maps to the same gradient + greeting emoji, so avatars and
 * headlines feel personal without any stored state. Palette stays in the
 * Aurora family (mint/emerald/gold/rose/teal) — no blue/indigo.
 */

const AVATAR_GRADIENTS = [
  "from-emerald-500 to-teal-500",
  "from-amber-400 to-orange-500",
  "from-rose-500 to-pink-500",
  "from-teal-400 to-emerald-500",
  "from-orange-400 to-rose-500",
  "from-lime-400 to-emerald-500",
  "from-amber-300 to-yellow-500",
  "from-pink-400 to-rose-500",
];

/** Deterministic avatar gradient for a name (same name → same gradient). */
export function gradientForName(name: string): string {
  const hash = name.split("").reduce((acc, c) => acc + c.charCodeAt(0), 0);
  return AVATAR_GRADIENTS[hash % AVATAR_GRADIENTS.length];
}

/** Up-to-two-letter initials, e.g. "Sahid Ali" → "SA". */
export function initialsOf(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((p) => p[0]?.toUpperCase() ?? "")
      .join("") || "U"
  );
}

/** Time-based greeting with emoji (BoardOps pattern). */
export function getTimeGreeting(): { greeting: string; emoji: string } {
  const hour = new Date().getHours();
  if (hour < 5) return { greeting: "Good night", emoji: "🌙" };
  if (hour < 12) return { greeting: "Good morning", emoji: "☀️" };
  if (hour < 17) return { greeting: "Good afternoon", emoji: "🌤️" };
  if (hour < 21) return { greeting: "Good evening", emoji: "🌆" };
  return { greeting: "Good night", emoji: "🌙" };
}
