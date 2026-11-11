import type { NextConfig } from "next";

const publicInvoiceHeaders = [
  { key: "Cache-Control", value: "private, no-store" },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Robots-Tag", value: "noindex" },
];

const nextConfig: NextConfig = {
  // One self-contained server bundle, so the same Docker image runs on every cloud.
  output: "standalone",
  // The public invoice is what a client opens on a phone. Never cache it, never leak the token in a Referer, never index it.
  async headers() {
    return [
      { source: "/i/:token", headers: publicInvoiceHeaders },
      { source: "/i/:token/demo-pay", headers: publicInvoiceHeaders },
    ];
  },
  // Cache Components stays off in the template: most apps here read the session on
  // nearly every page, and the classic dynamic model keeps that simple. An app can
  // opt in later if it has mostly public, cacheable pages.
  cacheComponents: false,
  // Keep the Postgres driver out of the bundle; it is loaded at runtime.
  serverExternalPackages: ["postgres"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
