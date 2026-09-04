import type { Metadata, Viewport } from "next";
import { Geist_Mono, Inter, Sora } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/app/providers";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
});

const sora = Sora({
  subsets: ["latin"],
  display: "swap",
  weight: ["600", "700", "800"],
  variable: "--font-sora",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist-mono",
});

export const metadata: Metadata = {
  title: "Aurora Mess",
  description:
    "Meals, money & operations for Aurora Residency Mess — beautifully kept.",
  icons: { icon: "/logo-mark.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F5F3ED" },
    { media: "(prefers-color-scheme: dark)", color: "#0A0E12" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.variable} ${sora.variable} ${geistMono.variable} font-sans antialiased bg-background text-foreground`}
      >
        {/* calm ambient canopy (liquid_polish) — neutral cloudy base +
            three extremely soft accent fields with a slow drift; sits below
            all content so backdrop-filters have something real to refract */}
        <div className="app-bg" aria-hidden>
          <span className="aurora aurora-a1" />
          <span className="aurora aurora-a2" />
          <span className="aurora aurora-a3" />
          <span className="grain" />
        </div>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
