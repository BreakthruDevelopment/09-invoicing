/**
 * Shared by the demo loader and the auth hooks that stop public users faking a demo identity.
 * Set MARKER per app (`urn:breakthru:<slug>-demo:v1`): the loader stores it in `user.image` so it only ever
 * replaces accounts it created, and refuses to touch an unrelated account that has a demo email.
 *
 * The pattern:
 * - `databaseHooks.user.create.before` / `update.before` in src/lib/auth/index.ts call `refuseDemoIdentity`.
 *   They run for every Better Auth write path: public sign-up, /update-user, /admin/create-user and
 *   /admin/update-user. A demo email, or any `image` starting with `urn:breakthru:` (not only this app's
 *   MARKER, so a typo or another app's marker can't slip through), is refused with 400.
 * - The demo loader (src/lib/demo.ts, when an app has one) writes users directly with Drizzle. That never goes
 *   through Better Auth, so the hooks don't affect it.
 * - The loader must map Postgres 23505 (unique violation, e.g. `user_email_unique`) to a 409 rather than a
 *   500: a real account may already hold the demo email, and the admin should see "conflict", not a crash.
 */
import { APIError } from "better-auth/api";

export const MARKER = "urn:breakthru:demo:v1";
export const DEMO_EMAIL_DOMAIN = "demo.breakthru.test";
/** Every app's marker starts with this; no public user may write an `image` that does. */
export const DEMO_IMAGE_PREFIX = "urn:breakthru:";

export function isDemoEmail(email: unknown): boolean {
  return typeof email === "string" && email.trim().toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);
}

export function isDemoImage(image: unknown): boolean {
  return typeof image === "string" && image.trim().toLowerCase().startsWith(DEMO_IMAGE_PREFIX);
}

/** Better Auth `databaseHooks.user.*.before` handler: throws 400 for a demo identity, else passes data through. */
export function refuseDemoIdentity<T extends { email?: unknown; image?: unknown }>(data: T) {
  if (isDemoEmail(data.email) || isDemoImage(data.image)) {
    throw new APIError("BAD_REQUEST", { message: "That email or image is reserved." });
  }
  return Promise.resolve({ data });
}
