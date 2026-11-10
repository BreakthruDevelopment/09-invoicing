import "server-only";
import { log } from "@/lib/log";

/**
 * Which payment provider is live. `demo` is the default and needs nothing. `stripe` is used only when BOTH
 * STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set AND the key is a test-mode key (`sk_test_` or `rk_test_`).
 * Anything else, including a live key, falls back to `demo`: live mode is impossible by construction.
 */
export type PaymentsConfig = { mode: "demo" } | { mode: "stripe"; secretKey: string; webhookSecret: string };
export type PaymentsMode = PaymentsConfig["mode"];

const TEST_KEY = /^(sk|rk)_test_[A-Za-z0-9_]+$/;

let fallbackLogged = false;

export function paymentsConfig(): PaymentsConfig {
  // Read straight from the environment (not env()): the health check calls this and must not depend on the rest of
  // the app's settings. Cloud consoles set unused variables to "", which counts as unset.
  const secretKey = process.env.STRIPE_SECRET_KEY?.trim() || undefined;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET?.trim() || undefined;
  if (secretKey && webhookSecret && TEST_KEY.test(secretKey)) return { mode: "stripe", secretKey, webhookSecret };

  // Only say something when Stripe was at least partly configured, and only once per process. Names, never values.
  if ((secretKey || webhookSecret) && !fallbackLogged) {
    fallbackLogged = true;
    const reasons: string[] = [];
    if (!secretKey) reasons.push("STRIPE_SECRET_KEY missing");
    else if (!TEST_KEY.test(secretKey)) reasons.push("STRIPE_SECRET_KEY is not a test-mode key");
    if (!webhookSecret) reasons.push("STRIPE_WEBHOOK_SECRET missing");
    log.warn("payments.provider.fallback", { to: "demo", reasons });
  }
  return { mode: "demo" };
}

/** `demo` or `stripe`, for the health check. Never includes a secret. */
export function paymentsMode(): PaymentsMode {
  return paymentsConfig().mode;
}

/** For tests. */
export function resetPaymentsFallbackLog(): void {
  fallbackLogged = false;
}
