"use client";

/**
 * AppRoot — the single-page application shell (BoardOps architecture).
 * Auth gate (loading curtain → AuthScreen → role shell), hash routing with
 * keyed page transitions (quick 200ms opacity + 6px rise). Navigation at
 * EVERY viewport: the FIXED floating bottom bar — four destinations +
 * "More" (ADMIN: Home · Meals · Money · Residents · More; RESIDENT:
 * Home · Meals · Billing · Payments · More) — plus the top-left hamburger
 * that always opens the grouped More panel (drawer). Content is a centered
 * max-w-6xl column with a sticky footer and the ⌘K command palette.
 */

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { ComponentType } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { useSession } from "@/hooks/use-session";
import { navigateTo } from "@/hooks/use-hash-route";
import { useApiQuery } from "@/hooks/use-api-query";
import { api } from "@/lib/api";
import { getNotificationTargetRoute } from "@/lib/notification-routes";
import { onNotificationBroadcast } from "@/lib/broadcast";
import { cn } from "@/lib/utils";
import AuthScreen from "./AuthScreen";
import { bottomBarItems, navItemByKey } from "./nav";
import { useRoute, type AppRoute } from "./router";

import TopBar from "@/components/glass/TopBar";
import BottomNav from "@/components/glass/BottomNav";
import MobileSidebar from "@/components/glass/MobileSidebar";
import CommandPalette from "@/components/glass/CommandPalette";
import SplashScreen from "@/components/glass/SplashScreen";

/* ---- views ---- */
import AdminDashboard from "./admin/dashboard";
import AdminMeals from "./admin/meals";
import AdminMealConfiguration from "./admin/meal-configuration";
import AdminPayments from "./admin/payments";
import AdminFunds from "./admin/funds";
import AdminExpenses from "./admin/expenses";
import AdminBilling from "./admin/billing";
import AdminResidents from "./admin/residents";
import AdminResident360 from "./admin/resident360";
import AdminTasks from "./admin/tasks";
import AdminCalendar from "./admin/calendar";
import AdminAnnouncements from "./admin/announcements";
import AdminNotifications from "./admin/notifications";
import AdminFormulas from "./admin/formulas";
import AdminSettings from "./admin/settings";
import AdminAudit from "./admin/audit";

import ResidentDashboard from "./resident/dashboard";
import ResidentMeals from "./resident/meals";
import ResidentBilling from "./resident/billing";
import ResidentPayments from "./resident/payments";
import ResidentTasks from "./resident/tasks";
import ResidentProfile from "./resident/profile";
import ResidentNotifications from "./resident/notifications";

const ADMIN_VIEWS: Record<string, ComponentType> = {
  dashboard: AdminDashboard,
  meals: AdminMeals,
  "meal-configuration": AdminMealConfiguration,
  payments: AdminPayments,
  funds: AdminFunds,
  expenses: AdminExpenses,
  billing: AdminBilling,
  residents: AdminResidents,
  tasks: AdminTasks,
  calendar: AdminCalendar,
  announcements: AdminAnnouncements,
  notifications: AdminNotifications,
  formulas: AdminFormulas,
  settings: AdminSettings,
  audit: AdminAudit,
};

const RESIDENT_VIEWS: Record<string, ComponentType> = {
  dashboard: ResidentDashboard,
  meals: ResidentMeals,
  billing: ResidentBilling,
  payments: ResidentPayments,
  tasks: ResidentTasks,
  profile: ResidentProfile,
  notifications: ResidentNotifications,
};

function RouteViewByKey({
  routeKey,
  currentRoute,
}: {
  routeKey: string;
  currentRoute: AppRoute;
}) {
  const [key, param] = routeKey.split(":");
  if (key.startsWith("admin-")) {
    const viewName = key.slice("admin-".length);
    if (viewName === "resident360") {
      return <AdminResident360 id={param ?? currentRoute.param} />;
    }
    const View = ADMIN_VIEWS[viewName];
    return View ? <View /> : null;
  }
  if (key.startsWith("app-")) {
    const viewName = key.slice("app-".length);
    const View = RESIDENT_VIEWS[viewName];
    return View ? <View /> : null;
  }
  return null;
}

/* ---- unread count (graceful when the endpoint isn't deployed yet) ---- */

function deriveUnread(data: unknown): number | null {
  if (data == null) return null;
  if (Array.isArray(data)) return data.length;
  if (typeof data === "object") {
    const o = data as Record<string, unknown>;
    for (const key of ["unread", "unreadCount", "count", "total"]) {
      const v = o[key];
      if (typeof v === "number" && Number.isFinite(v)) return v;
    }
    if (Array.isArray(o.items)) return o.items.length;
  }
  return null;
}


/* ---- the root ---- */

export default function AppRoot() {
  const { user, profile, institution, isLoading, refetch, logout } = useSession();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [minSplashElapsed, setMinSplashElapsed] = useState(false);
  const reduced = useReducedMotion();

  useEffect(() => {
    const timer = window.setTimeout(() => setMinSplashElapsed(true), 1000);
    return () => window.clearTimeout(timer);
  }, []);

  const role = user?.role ?? "RESIDENT";
  // ready=false while the session is unresolved — keeps deep links intact.
  const route = useRoute(role, user != null);

  const queryClient = useQueryClient();

  const notificationsQuery = useApiQuery<unknown>(
    user ? "/api/v1/notifications" : null,
    { unread: 1 },
    { refetchInterval: 4_000, staleTime: 2_000, refetchOnWindowFocus: true }
  );
  const unread = deriveUnread(notificationsQuery.data);

  // Cross-tab real-time invalidation via BroadcastChannel
  useEffect(() => {
    return onNotificationBroadcast(() => {
      void queryClient.invalidateQueries({
        predicate: (q) => {
          const first = q.queryKey[0];
          const second = q.queryKey[1];
          return (
            (first === "api" || first === "apiE") &&
            typeof second === "string" &&
            (second === "/api/v1/notifications" || second.startsWith("/api/v1/notifications"))
          );
        },
      });
      if (role === "ADMIN") {
        void queryClient.invalidateQueries({
          predicate: (q) => {
            const first = q.queryKey[0];
            const second = q.queryKey[1];
            return (
              (first === "api" || first === "apiE") &&
              typeof second === "string" &&
              (second.startsWith("/api/v1/admin/payments") ||
                second.startsWith("/api/v1/admin/tasks") ||
                second.startsWith("/api/v1/admin/leave-requests") ||
                second.startsWith("/api/v1/admin/dashboard"))
            );
          },
        });
      }
    });
  }, [queryClient, role]);

  // Alert with instant in-app toast when a new notification arrives
  const prevUnreadRef = useRef<number | null>(null);
  useEffect(() => {
    if (unread != null) {
      if (prevUnreadRef.current !== null && unread > prevUnreadRef.current) {
        const rawList = Array.isArray(notificationsQuery.data)
          ? (notificationsQuery.data as Array<{
              id: string;
              type: string;
              title: string;
              message: string;
              entityRef?: string | null;
            }>)
          : [];
        const latest = rawList[0];
        const targetRoute = latest
          ? getNotificationTargetRoute(latest.type, role, latest.entityRef)
          : role === "ADMIN"
            ? "#/admin/notifications"
            : "#/app/notifications";

        toast.info(latest?.title ?? "New notification received", {
          description:
            latest?.message ??
            (role === "ADMIN"
              ? "A resident action is waiting for review."
              : "You have a new update."),
          action: {
            label: "View",
            onClick: () => {
              if (latest?.id) {
                void api(`/api/v1/notifications/${latest.id}/read`, { method: "POST" });
                void queryClient.invalidateQueries({
                  predicate: (q) => {
                    const first = q.queryKey[0];
                    const second = q.queryKey[1];
                    return (
                      (first === "api" || first === "apiE") &&
                      typeof second === "string" &&
                      second.startsWith("/api/v1/notifications")
                    );
                  },
                });
              }
              navigateTo(targetRoute);
            },
          },
        });
      }
      prevUnreadRef.current = unread;
    }
  }, [unread, role, notificationsQuery.data, queryClient]);

  const showSplash = isLoading || !minSplashElapsed;

  const bottomItems = bottomBarItems(role);
  const title =
    route.key === "admin-resident360"
      ? "Resident 360°"
      : (navItemByKey(route.key)?.label ?? "Aurora Mess");
  const context = role === "ADMIN" ? "Admin Console" : "Workspace";
  const notificationsHash = role === "ADMIN" ? "#/admin/notifications" : "#/app/notifications";
  const activeRouteKey = route.param ? `${route.key}:${route.param}` : route.key;

  const [visitedKeys, setVisitedKeys] = useState<string[]>(() => [activeRouteKey]);
  if (!visitedKeys.includes(activeRouteKey)) {
    setVisitedKeys((prev) => [...prev, activeRouteKey]);
  }

  const [currentUserEmail, setCurrentUserEmail] = useState(user?.email);
  if (user?.email !== currentUserEmail) {
    setCurrentUserEmail(user?.email);
    setVisitedKeys([activeRouteKey]);
  }

  const userCard = profile
    ? { name: profile.fullName, email: user?.email ?? "", role }
    : { name: user?.email ?? "", email: user?.email ?? "", role };

  return (
    <AnimatePresence mode="wait">
      {showSplash ? (
        <SplashScreen key="splash-curtain" message={user ? "Preparing your workspace…" : "Connecting to Aurora…"} />
      ) : !user ? (
        <motion.div
          key="auth-view"
          initial={reduced ? { opacity: 0 } : { opacity: 0, scale: 0.985 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0, scale: 1.02 }}
          transition={{ duration: 0.35, ease: "easeOut" }}
          className="min-h-screen w-full"
        >
          <AuthScreen onSuccess={() => refetch()} />
        </motion.div>
      ) : (
        <motion.div
          key="app-shell"
          initial={reduced ? { opacity: 0 } : { opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={reduced ? { opacity: 0 } : { opacity: 0 }}
          transition={{ duration: 0.25 }}
          className="min-h-screen"
        >
          {/* content column — full width; navigation lives in the floating bar */}
          <div className="flex min-h-screen flex-col">
            <TopBar
              title={title}
              context={context}
              unread={unread}
              onBellClick={() => navigateTo(notificationsHash)}
              onMenuClick={() => setDrawerOpen(true)}
              onSearchClick={() => setPaletteOpen(true)}
              user={userCard}
              onLogout={() => void logout()}
              onProfile={role === "RESIDENT" ? () => navigateTo("#/app/profile") : undefined}
            />

            <div className="flex flex-1 flex-col">
              <main className="flex-1 px-3 pb-28 pt-4 min-[420px]:px-4 sm:px-6">
                <div className="mx-auto w-full max-w-6xl">
                  {visitedKeys.map((k) => {
                    const isActive = k === activeRouteKey;
                    return (
                      <div
                        key={k}
                        role="tabpanel"
                        aria-hidden={!isActive}
                        className={cn("w-full", isActive ? "block" : "hidden")}
                      >
                        <RouteViewByKey routeKey={k} currentRoute={route} />
                      </div>
                    );
                  })}
                </div>
              </main>
            </div>
          </div>

          <BottomNav
            items={bottomItems}
            activeKey={route.key}
            onNavigate={navigateTo}
            onMore={() => setDrawerOpen(true)}
          />

          <MobileSidebar
            open={drawerOpen}
            onOpenChange={setDrawerOpen}
            role={role}
            activeKey={route.key}
            onNavigate={navigateTo}
            onSearch={() => setPaletteOpen(true)}
            institution={institution?.name}
            user={userCard}
            onLogout={() => void logout()}
            onProfile={role === "RESIDENT" ? () => navigateTo("#/app/profile") : undefined}
            unread={unread}
          />

          <CommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            role={role}
            onNavigate={navigateTo}
          />
        </motion.div>
      )}
    </AnimatePresence>
  );
}
