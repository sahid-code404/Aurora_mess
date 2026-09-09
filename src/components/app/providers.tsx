"use client";

/**
 * providers — ThemeProvider (next-themes, class-based), TanStack QueryClient
 * (client-only instance, retry:false so unbuilt endpoints fail fast into
 * friendly states), and the glass-styled sonner Toaster.
 *
 * Successful mutations broadcast one application data-change event. Active API
 * read models are immediately re-fetched and inactive ones are invalidated, so
 * variables, formulas, KPIs, funds and OPEN billing previews cannot stay stale
 * after an Admin/Resident changes source data.
 */

import { useEffect, useState } from "react";
import { ThemeProvider, useTheme } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster as SonnerToaster } from "sonner";
import { BOARDOPS_DATA_CHANGED_EVENT } from "@/lib/api";

function GlassToaster() {
  const { resolvedTheme } = useTheme();
  return (
    <SonnerToaster
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      position="top-center"
      offset={72}
      toastOptions={{
        classNames: {
          toast: "glass-strong rounded-md",
          title: "text-sm font-semibold",
          description: "text-[13px] text-muted-foreground",
        },
        style: {
          background: "var(--glass-surface-strong)",
          border: "1px solid var(--glass-border-strong)",
          color: "var(--foreground)",
          backdropFilter: "blur(var(--glass-blur-strong)) saturate(var(--glass-saturate-strong))",
        },
      }}
    />
  );
}

export function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            retry: false,
            refetchOnWindowFocus: false,
            staleTime: 15_000,
          },
          mutations: { retry: false },
        },
      })
  );

  useEffect(() => {
    const refreshLiveReadModels = () => {
      void queryClient.invalidateQueries({
        predicate: (query) => {
          const root = query.queryKey[0];
          return root === "api" || root === "apiE";
        },
        refetchType: "active",
      });
    };

    window.addEventListener(BOARDOPS_DATA_CHANGED_EVENT, refreshLiveReadModels);
    return () => window.removeEventListener(BOARDOPS_DATA_CHANGED_EVENT, refreshLiveReadModels);
  }, [queryClient]);

  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem
      disableTransitionOnChange
    >
      <QueryClientProvider client={queryClient}>
        {children}
        <GlassToaster />
      </QueryClientProvider>
    </ThemeProvider>
  );
}

export default Providers;
