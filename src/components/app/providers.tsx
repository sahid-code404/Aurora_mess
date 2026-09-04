"use client";

/**
 * providers — ThemeProvider (next-themes, class-based), TanStack QueryClient
 * (client-only instance, retry:false so unbuilt endpoints fail fast into
 * friendly states), and the glass-styled sonner Toaster.
 */

import { useState } from "react";
import { ThemeProvider, useTheme } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster as SonnerToaster } from "sonner";

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
