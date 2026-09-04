"use client";

/**
 * AuthScreen — Redesigned Liquid Glass Authentication Window.
 *
 * Visual & functional features:
 *   - Focused, centered Liquid Glass portal window (no split landing page).
 *   - Ambient floating aurora lighting canopy with specular reflections.
 *   - Hero emblem with specular gloss ring and soft breathing pulse.
 *   - Fluid sliding water-droplet mode switcher (Sign In <-> Create Account).
 *   - Tactile glass input fields with contextual icons (Email, Lock, User, Room, Phone).
 *   - Micro-animated password visibility toggles.
 *   - Animated spring-in error surfaces and validation alerts.
 *   - Application submitted success screen with celebration badge.
 *   - Floating development quick-fill glass capsule.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, LayoutGroup, motion, useReducedMotion } from "framer-motion";
import {
  AlertCircle,
  Check,
  CheckCircle2,
  DoorOpen,
  Eye,
  EyeOff,
  Lock,
  Mail,
  Phone,
  Sparkles,
  Terminal,
  User,
} from "lucide-react";
import { api, ApiClientError, persistSessionToken } from "@/lib/api";
import { useApiQuery } from "@/hooks/use-api-query";
import GlassButton from "@/components/glass/GlassButton";
import { SPRING_SOFT, SPRING_LIQUID, SPRING_SNAPPY } from "@/lib/motion";
import { cn } from "@/lib/utils";

type Mode = "signin" | "register";

const SIGNIN_ERROR_COPY: Record<string, string> = {
  INVALID_CREDENTIALS: "Email or password is incorrect.",
  ACCOUNT_PENDING: "Your account is waiting for admin approval.",
  ACCOUNT_REJECTED: "Your registration was declined. Please contact the admin.",
  ACCOUNT_INACTIVE: "This account is inactive. Please contact the admin.",
  NETWORK: "We couldn't reach the server. Check your connection and try again.",
};

interface PolicyInfo {
  policyId: string;
  policyVersionId: string;
  title: string;
  version?: string;
}

function normalizePolicies(data: unknown): PolicyInfo[] {
  const obj = data as { items?: unknown } | null;
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(obj?.items)
      ? (obj.items as unknown[])
      : [];
  const out: PolicyInfo[] = [];
  for (const p of raw) {
    if (!p || typeof p !== "object") continue;
    const o = p as Record<string, unknown>;
    const policyId = [o.policyId, o.id].find((v): v is string => typeof v === "string");
    const policyVersionId = [o.policyVersionId, o.versionId, o.id].find(
      (v): v is string => typeof v === "string"
    );
    if (!policyId || !policyVersionId) continue;
    out.push({
      policyId,
      policyVersionId,
      title:
        [o.title, o.name].find((v): v is string => typeof v === "string") ??
        "Community policy",
      version:
        typeof o.version === "string" || typeof o.version === "number"
          ? String(o.version)
          : undefined,
    });
  }
  return out;
}

/* ---------------------------------------------------------------- UI bits */

function Field({
  label,
  error,
  children,
  htmlFor,
}: {
  label: string;
  error?: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-xs font-semibold tracking-wide text-foreground/80">
        {label}
      </label>
      {children}
      <AnimatePresence>
        {error && (
          <motion.p
            role="alert"
            initial={{ opacity: 0, y: -4, height: 0 }}
            animate={{ opacity: 1, y: 0, height: "auto" }}
            exit={{ opacity: 0, y: -4, height: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden text-[11px] font-medium text-danger"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}

const inputClass =
  "w-full h-11 rounded-2xl bg-foreground/[0.04] dark:bg-white/[0.06] border border-white/20 dark:border-white/10 px-3.5 text-sm outline-none transition-all placeholder:text-muted-foreground/50 focus:border-primary/60 focus:bg-white/[0.08] dark:focus:bg-white/[0.09] focus:shadow-[0_0_0_3px_color-mix(in_oklab,var(--primary)_22%,transparent),inset_0_1px_2px_rgba(0,0,0,0.2)]";

function ErrorSurface({ message }: { message: string }) {
  return (
    <motion.div
      role="alert"
      initial={{ opacity: 0, scale: 0.96, y: -6 }}
      animate={{ opacity: 1, scale: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.96, y: -6 }}
      transition={SPRING_SOFT}
      className="flex items-start gap-2.5 rounded-2xl border border-danger/35 bg-danger/12 p-3.5 text-xs font-medium leading-relaxed text-danger shadow-sm"
    >
      <AlertCircle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <span>{message}</span>
    </motion.div>
  );
}

function PasswordInput({
  id,
  value,
  onChange,
  placeholder,
  autoComplete,
  error,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  autoComplete?: string;
  error?: boolean;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-muted-foreground">
        <Lock className="size-4" aria-hidden />
      </div>
      <input
        id={id}
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "••••••••••"}
        autoComplete={autoComplete}
        required
        className={cn(inputClass, "pl-10 pr-11", error && "border-danger/50")}
      />
      <motion.button
        type="button"
        aria-label={show ? "Hide password" : "Show password"}
        whileTap={{ scale: 0.88 }}
        onClick={() => setShow((s) => !s)}
        className="absolute inset-y-0 right-0 flex w-11 items-center justify-center rounded-2xl text-muted-foreground hover:text-foreground transition-colors focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={show ? "off" : "on"}
            initial={{ scale: 0.7, opacity: 0, rotate: -15 }}
            animate={{ scale: 1, opacity: 1, rotate: 0 }}
            exit={{ scale: 0.7, opacity: 0, rotate: 15 }}
            transition={{ duration: 0.15 }}
          >
            {show ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
          </motion.span>
        </AnimatePresence>
      </motion.button>
    </div>
  );
}

const SEED_ACCOUNTS = [
  { role: "Admin", email: "admin@messtest.in", password: "Admin#12345" },
  { role: "Resident", email: "sahid@messtest.in", password: "Resident#12345" },
];

/* ----------------------------------------------------------- Auth Screen */

export interface AuthScreenProps {
  /** Called after a successful sign-in so the session query refetches. */
  onSuccess: () => void;
}

export function AuthScreen({ onSuccess }: AuthScreenProps) {
  const reduced = useReducedMotion();
  const [mode, setMode] = useState<Mode>("signin");

  const [prevMode, setPrevMode] = useState(mode);
  const isModeChange = mode !== prevMode;
  if (isModeChange) {
    setPrevMode(mode);
  }

  return (
    <div className="relative flex min-h-screen w-full flex-col items-center justify-center px-4 py-10 sm:px-6 overflow-hidden">
      {/* Ambient background light canopy */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden -z-10">
        <motion.div
          animate={
            reduced
              ? undefined
              : {
                  scale: [1, 1.15, 1],
                  opacity: [0.25, 0.45, 0.25],
                }
          }
          transition={{ duration: 7, repeat: Infinity, ease: "easeInOut" }}
          className="absolute -top-[10%] left-1/2 -translate-x-1/2 size-[600px] rounded-full bg-primary/20 blur-[120px]"
        />
        <motion.div
          animate={
            reduced
              ? undefined
              : {
                  scale: [1.1, 0.95, 1.1],
                  opacity: [0.15, 0.35, 0.15],
                }
          }
          transition={{ duration: 9, repeat: Infinity, ease: "easeInOut", delay: 1 }}
          className="absolute -bottom-[15%] left-1/2 -translate-x-1/3 size-[540px] rounded-full bg-gold/15 blur-[110px]"
        />
      </div>

      {/* Main Container */}
      <motion.div
        initial={reduced ? undefined : { opacity: 0, y: 22, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ ...SPRING_LIQUID, delay: 0.05 }}
        className="w-full max-w-[440px] flex flex-col items-center"
      >
        {/* Brand Header */}
        <div className="mb-6 flex flex-col items-center text-center space-y-2.5">
          <motion.div
            whileHover={reduced ? undefined : { scale: 1.05 }}
            transition={{ type: "spring", stiffness: 400, damping: 20 }}
            className="relative"
          >
            <div className="absolute -inset-2 rounded-3xl bg-gradient-to-tr from-primary/35 to-gold/25 blur-lg opacity-80" />
            <div className="relative flex size-16 items-center justify-center rounded-2xl border border-white/25 dark:border-white/15 bg-white/15 dark:bg-white/[0.08] backdrop-blur-2xl shadow-[0_16px_36px_-8px_rgba(0,0,0,0.5),inset_0_1.5px_1px_rgba(255,255,255,0.4)]">
              <img
                src="/logo-mark.png"
                alt="Aurora Mess"
                width={44}
                height={44}
                className="size-11 rounded-xl object-cover"
              />
            </div>
          </motion.div>

          <div>
            <h1 className="font-display text-2xl font-bold tracking-tight text-foreground">
              Aurora <span className="text-liquid">Mess</span>
            </h1>
            <p className="text-xs text-muted-foreground font-medium mt-0.5">
              Community living &amp; dining operations
            </p>
          </div>
        </div>

        {/* Liquid Glass Portal Card */}
        <div className="relative w-full rounded-[32px] border border-white/20 dark:border-white/10 bg-surface/55 dark:bg-surface/40 backdrop-blur-2xl p-6 sm:p-8 shadow-[0_24px_70px_-15px_rgba(0,0,0,0.6),inset_0_1.5px_1px_rgba(255,255,255,0.3)] overflow-hidden">
          {/* Top specular reflection bevel */}
          <div
            aria-hidden
            className="absolute inset-x-8 top-0 h-px bg-gradient-to-r from-transparent via-white/50 to-transparent pointer-events-none"
          />

          {/* Sliding Droplet Mode Switcher */}
          <LayoutGroup id="auth-tabs-group">
            <div
              role="tablist"
              aria-label="Authentication option"
              className="relative mb-6 flex h-11 items-center rounded-2xl bg-foreground/[0.05] dark:bg-white/[0.06] p-1 border border-white/10 select-none"
            >
              <button
                type="button"
                role="tab"
                aria-selected={mode === "signin"}
                onClick={() => setMode("signin")}
                className={cn(
                  "relative z-10 flex-1 text-xs font-semibold tracking-wide transition-colors py-2 text-center rounded-xl",
                  mode === "signin" ? "text-primary-foreground font-bold" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {mode === "signin" && (
                  <motion.span
                    layoutId="auth-tab-droplet"
                    layoutDependency={mode}
                    initial={false}
                    className="absolute inset-0 rounded-xl bg-primary shadow-[inset_0_1.5px_1px_0_rgba(255,255,255,0.42),inset_0_-1px_1px_0_rgba(0,0,0,0.2),0_6px_18px_-4px_color-mix(in_oklab,var(--primary)_70%,transparent)] ring-1 ring-primary/60"
                    transition={reduced || !isModeChange ? { duration: 0 } : SPRING_SNAPPY}
                  />
                )}
                <span className="relative z-20">Sign in</span>
              </button>

              <button
                type="button"
                role="tab"
                aria-selected={mode === "register"}
                onClick={() => setMode("register")}
                className={cn(
                  "relative z-10 flex-1 text-xs font-semibold tracking-wide transition-colors py-2 text-center rounded-xl",
                  mode === "register" ? "text-primary-foreground font-bold" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {mode === "register" && (
                  <motion.span
                    layoutId="auth-tab-droplet"
                    layoutDependency={mode}
                    initial={false}
                    className="absolute inset-0 rounded-xl bg-primary shadow-[inset_0_1.5px_1px_0_rgba(255,255,255,0.42),inset_0_-1px_1px_0_rgba(0,0,0,0.2),0_6px_18px_-4px_color-mix(in_oklab,var(--primary)_70%,transparent)] ring-1 ring-primary/60"
                    transition={reduced || !isModeChange ? { duration: 0 } : SPRING_SNAPPY}
                  />
                )}
                <span className="relative z-20">Create account</span>
              </button>
            </div>
          </LayoutGroup>

          {/* Form crossfade */}
          <AnimatePresence mode="wait" initial={false}>
            <motion.div
              key={mode}
              initial={reduced ? undefined : { opacity: 0, x: mode === "signin" ? -14 : 14, scale: 0.99 }}
              animate={{ opacity: 1, x: 0, scale: 1 }}
              exit={reduced ? undefined : { opacity: 0, x: mode === "signin" ? 14 : -14, scale: 0.99 }}
              transition={{ type: "spring", stiffness: 340, damping: 28 }}
            >
              {mode === "signin" ? (
                <SignInForm onSuccess={onSuccess} />
              ) : (
                <RegisterForm onDone={() => setMode("signin")} />
              )}
            </motion.div>
          </AnimatePresence>
        </div>

        {/* Development Quick-Fill Bar */}
        {mode === "signin" && <DevSeedBar />}
      </motion.div>
    </div>
  );
}

/* -------------------------------------------------------------- sign in */

function SignInForm({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const data = await api<{ sessionToken?: string }>("/api/v1/auth/login", {
        method: "POST",
        json: { email: email.trim(), password },
      });
      if (data?.sessionToken) {
        persistSessionToken(data.sessionToken);
      }
      onSuccess();
    } catch (err) {
      if (err instanceof ApiClientError) {
        setError(SIGNIN_ERROR_COPY[err.code] ?? err.message);
      } else {
        setError(SIGNIN_ERROR_COPY.NETWORK);
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <Field label="Email address" htmlFor="signin-email">
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-muted-foreground">
            <Mail className="size-4" aria-hidden />
          </div>
          <input
            id="signin-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@messtest.in"
            required
            className={cn(inputClass, "pl-10")}
          />
        </div>
      </Field>

      <Field label="Password" htmlFor="signin-password">
        <PasswordInput
          id="signin-password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />
      </Field>

      <AnimatePresence>{error && <ErrorSurface message={error} />}</AnimatePresence>

      <GlassButton
        type="submit"
        size="lg"
        variant="primary"
        fullWidth
        loading={pending}
        className="mt-2 h-12 rounded-2xl text-sm font-semibold tracking-wide shadow-[0_8px_24px_-6px_color-mix(in_oklab,var(--primary)_60%,transparent)]"
      >
        Sign in
      </GlassButton>
    </form>
  );
}

/* -------------------------------------------------------------- register */

interface RegisterFormState {
  fullName: string;
  email: string;
  phone: string;
  room: string;
  password: string;
  confirm: string;
}

const EMPTY_REGISTER: RegisterFormState = {
  fullName: "",
  email: "",
  phone: "",
  room: "",
  password: "",
  confirm: "",
};

function passwordProblemText(pw: string): string | null {
  const problems: string[] = [];
  if (pw.length < 10) problems.push("at least 10 characters");
  if (!/[a-z]/.test(pw)) problems.push("a lowercase letter");
  if (!/[A-Z]/.test(pw)) problems.push("an uppercase letter");
  if (!/[0-9]/.test(pw)) problems.push("a number");
  return problems.length ? `Password needs ${problems.join(", ")}.` : null;
}

function RegisterForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState<RegisterFormState>(EMPTY_REGISTER);
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<keyof RegisterFormState, string>>>({});
  const [accepted, setAccepted] = useState<Record<string, boolean>>({});
  const [fallbackAccepted, setFallbackAccepted] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const policiesQuery = useApiQuery<unknown>("/api/v1/auth/policies");
  const policies = useMemo(
    () => (policiesQuery.data ? normalizePolicies(policiesQuery.data) : []),
    [policiesQuery.data]
  );
  const policiesUnavailable =
    policiesQuery.isError || (policiesQuery.isSuccess && policies.length === 0);

  const set = (key: keyof RegisterFormState) => (v: string) =>
    setForm((f) => ({ ...f, [key]: v }));

  function validate(): boolean {
    const errs: Partial<Record<keyof RegisterFormState, string>> = {};
    if (form.fullName.trim().length < 2) errs.fullName = "Enter your full name.";
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.email.trim()))
      errs.email = "Enter a valid email address.";
    if (form.phone.trim() !== "" && !/^[+0-9 ()-]{6,18}$/.test(form.phone.trim()))
      errs.phone = "Enter a valid phone number.";
    const pwProblem = passwordProblemText(form.password);
    if (pwProblem) errs.password = pwProblem;
    if (form.confirm !== form.password) errs.confirm = "Passwords don't match.";
    if (!policiesUnavailable && policies.some((p) => !accepted[p.policyId])) {
      setError("Please accept the community policies to continue.");
    } else if (policiesUnavailable && !fallbackAccepted) {
      setError("Please confirm you agree to the mess rules to continue.");
    }
    setFieldErrors(errs);
    return Object.keys(errs).length === 0;
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (pending) return;
    setError(null);
    if (!validate()) return;
    setPending(true);
    try {
      await api("/api/v1/auth/register", {
        method: "POST",
        json: {
          fullName: form.fullName.trim(),
          email: form.email.trim().toLowerCase(),
          phone: form.phone.trim() || undefined,
          room: form.room.trim() || undefined,
          password: form.password,
          acceptances: policies.map((p) => ({
            policyId: p.policyId,
            policyVersionId: p.policyVersionId,
          })),
        },
      });
      setSubmitted(true);
    } catch (err) {
      if (err instanceof ApiClientError) {
        if (err.fields) {
          const errs: Partial<Record<keyof RegisterFormState, string>> = {};
          for (const [k, v] of Object.entries(err.fields)) {
            const key = k as keyof RegisterFormState;
            if (key in EMPTY_REGISTER) errs[key] = v;
          }
          setFieldErrors((prev) => ({ ...prev, ...errs }));
          if (Object.keys(errs).length === 0) setError(err.message);
        } else {
          setError(err.message);
        }
      } else {
        setError(SIGNIN_ERROR_COPY.NETWORK);
      }
    } finally {
      setPending(false);
    }
  }

  if (submitted) {
    return (
      <motion.div
        initial={{ opacity: 0, scale: 0.94, y: 14 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={SPRING_SOFT}
        className="flex flex-col items-center py-5 text-center"
      >
        <motion.span
          initial={{ scale: 0, rotate: -25 }}
          animate={{ scale: 1, rotate: 0 }}
          transition={{ type: "spring", stiffness: 420, damping: 18, delay: 0.15 }}
          className="flex size-14 items-center justify-center rounded-2xl border border-success/35 bg-success/15 text-success shadow-[0_10px_30px_-10px_color-mix(in_oklab,var(--success)_60%,transparent)] [&_svg]:size-7"
        >
          <CheckCircle2 aria-hidden />
        </motion.span>
        <h3 className="font-display mt-4 text-lg font-bold text-foreground">Application submitted</h3>
        <p className="mt-1.5 max-w-xs text-xs leading-relaxed text-muted-foreground">
          Waiting for approval — the administrator will review your application. You&apos;ll be
          able to sign in once approved.
        </p>
        <GlassButton variant="primary" className="mt-5 rounded-2xl" onClick={onDone}>
          Back to sign in
        </GlassButton>
      </motion.div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-3.5" noValidate>
      <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
        <Field label="Full name" htmlFor="reg-name" error={fieldErrors.fullName}>
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-muted-foreground">
              <User className="size-3.5" aria-hidden />
            </div>
            <input
              id="reg-name"
              type="text"
              autoComplete="name"
              value={form.fullName}
              onChange={(e) => set("fullName")(e.target.value)}
              placeholder="Sahid Khan"
              className={cn(inputClass, "pl-9 text-xs")}
            />
          </div>
        </Field>
        <Field label="Room (optional)" htmlFor="reg-room">
          <div className="relative">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-muted-foreground">
              <DoorOpen className="size-3.5" aria-hidden />
            </div>
            <input
              id="reg-room"
              type="text"
              value={form.room}
              onChange={(e) => set("room")(e.target.value)}
              placeholder="B-204"
              className={cn(inputClass, "pl-9 text-xs")}
            />
          </div>
        </Field>
      </div>

      <Field label="Email address" htmlFor="reg-email" error={fieldErrors.email}>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-muted-foreground">
            <Mail className="size-3.5" aria-hidden />
          </div>
          <input
            id="reg-email"
            type="email"
            inputMode="email"
            autoComplete="email"
            value={form.email}
            onChange={(e) => set("email")(e.target.value)}
            placeholder="you@example.com"
            className={cn(inputClass, "pl-9 text-xs")}
          />
        </div>
      </Field>

      <Field label="Phone number (optional)" htmlFor="reg-phone" error={fieldErrors.phone}>
        <div className="relative">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-muted-foreground">
            <Phone className="size-3.5" aria-hidden />
          </div>
          <input
            id="reg-phone"
            type="tel"
            autoComplete="tel"
            value={form.phone}
            onChange={(e) => set("phone")(e.target.value)}
            placeholder="+91 98765 43210"
            className={cn(inputClass, "pl-9 text-xs")}
          />
        </div>
      </Field>

      <Field label="Password" htmlFor="reg-password" error={fieldErrors.password}>
        <PasswordInput
          id="reg-password"
          value={form.password}
          onChange={set("password")}
          autoComplete="new-password"
          error={!!fieldErrors.password}
        />
      </Field>

      <Field label="Confirm password" htmlFor="reg-confirm" error={fieldErrors.confirm}>
        <PasswordInput
          id="reg-confirm"
          value={form.confirm}
          onChange={set("confirm")}
          autoComplete="new-password"
          error={!!fieldErrors.confirm}
        />
      </Field>

      {/* Community Policy Acknowledgement */}
      <div className="rounded-2xl border border-white/10 bg-foreground/[0.03] dark:bg-white/[0.04] p-3 space-y-2">
        <p className="text-[11px] font-semibold text-muted-foreground">Community Policies</p>
        {policiesQuery.isLoading && <div className="glass-skeleton h-4 w-3/4 rounded-md" />}
        {policies.map((p) => (
          <label key={p.policyId} className="flex cursor-pointer items-start gap-2 text-xs text-foreground/80">
            <input
              type="checkbox"
              checked={!!accepted[p.policyId]}
              onChange={(e) =>
                setAccepted((a) => ({ ...a, [p.policyId]: e.target.checked }))
              }
              className="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)] rounded"
            />
            <span className="leading-tight">
              I accept the {p.title}
              {p.version ? <span className="ml-1 text-[10px] text-muted-foreground">v{p.version}</span> : null}
            </span>
          </label>
        ))}
        {policiesUnavailable && (
          <label className="flex cursor-pointer items-start gap-2 text-xs text-foreground/80">
            <input
              type="checkbox"
              checked={fallbackAccepted}
              onChange={(e) => setFallbackAccepted(e.target.checked)}
              className="mt-0.5 size-3.5 shrink-0 accent-[var(--primary)] rounded"
            />
            <span className="leading-tight">
              I agree to follow the mess rules and payment policies.
            </span>
          </label>
        )}
      </div>

      <AnimatePresence>{error && <ErrorSurface message={error} />}</AnimatePresence>

      <GlassButton
        type="submit"
        size="lg"
        variant="primary"
        fullWidth
        loading={pending}
        className="mt-2 h-12 rounded-2xl text-sm font-semibold tracking-wide"
      >
        Submit application
      </GlassButton>
    </form>
  );
}

/* ------------------------------------------------- Dev Quick-Fill Pill */

function DevSeedBar() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...SPRING_SOFT, delay: 0.2 }}
      className="mt-5 flex flex-wrap items-center justify-center gap-2"
    >
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground/75 px-1">
        <Terminal className="size-3 text-warning" aria-hidden />
        Quick fill:
      </span>
      {SEED_ACCOUNTS.map((acc) => (
        <SeedPillButton key={acc.email} role={acc.role} email={acc.email} password={acc.password} />
      ))}
    </motion.div>
  );
}

function SeedPillButton({
  role,
  email,
  password,
}: {
  role: string;
  email: string;
  password: string;
}) {
  const [filled, setFilled] = useState(false);

  function fill() {
    const emailInput = document.getElementById("signin-email") as HTMLInputElement | null;
    const pwInput = document.getElementById("signin-password") as HTMLInputElement | null;
    if (emailInput) {
      emailInput.value = email;
      emailInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    if (pwInput) {
      pwInput.value = password;
      pwInput.dispatchEvent(new Event("input", { bubbles: true }));
    }
    setFilled(true);
    window.setTimeout(() => setFilled(false), 1400);
  }

  return (
    <button
      type="button"
      onClick={fill}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11px] font-semibold transition-all select-none cursor-pointer",
        "border border-white/15 dark:border-white/10 bg-white/10 dark:bg-white/[0.06] backdrop-blur-md",
        "hover:bg-white/20 dark:hover:bg-white/10 active:scale-95",
        filled ? "text-success border-success/30 bg-success/10" : "text-foreground/80"
      )}
    >
      {filled ? <Check className="size-3 text-success" /> : null}
      <span>{role}</span>
    </button>
  );
}

export default AuthScreen;
