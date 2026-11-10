/**
 * Shared by the demo loader and the auth hooks that stop public users faking a demo identity.
 * Set MARKER per app (`urn:breakthru:<slug>-demo:v1`): the loader stores it in `user.image` so it only ever
 * replaces accounts it created, and refuses to touch an unrelated account that has a demo email.
 */
export const MARKER = "urn:breakthru:demo:v1";
export const DEMO_EMAIL_DOMAIN = "demo.breakthru.test";

export function isDemoEmail(email: unknown): boolean {
  return typeof email === "string" && email.trim().toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);
}
