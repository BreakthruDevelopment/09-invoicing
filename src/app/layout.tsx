import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { AppShell } from "@/components/app-shell";
import { APP_DESCRIPTION, APP_TITLE } from "@/lib/app-config";
import "./globals.css";

// Self-hosted (src/app/fonts, see its README) so builds work without internet access.
const newsreader = localFont({
  src: "./fonts/newsreader-latin-wght-normal.woff2",
  weight: "200 800",
  style: "normal",
  variable: "--font-newsreader",
  display: "swap",
});
const publicSans = localFont({
  src: "./fonts/public-sans-latin-wght-normal.woff2",
  weight: "100 900",
  style: "normal",
  variable: "--font-public-sans",
  display: "swap",
});
const plexMono = localFont({
  src: [
    { path: "./fonts/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "./fonts/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-plex-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: { default: APP_TITLE, template: `%s · ${APP_TITLE}` },
  description: APP_DESCRIPTION,
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${newsreader.variable} ${publicSans.variable} ${plexMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
