import "server-only";
import { env } from "@/lib/env";

/** Owner JSON is private to the caller: never cached by a browser or a shared cache. */
export function ok(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export type IdContext = { params: Promise<{ id: string }> };

/** The public link for a share token. The token appears in this URL once, in the response that created it. */
export function shareUrl(token: string): string {
  return `${new URL(env().APP_URL).origin}/i/${token}`;
}

/** Headers for the public (share-token) routes: never cached, never leaks the link in a Referer, never indexed. */
export const PUBLIC_HEADERS = {
  "Cache-Control": "private, no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex",
} as const;
