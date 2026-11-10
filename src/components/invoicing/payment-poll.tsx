"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const INTERVAL_MS = 3_000;
const TRIES = 10;

/**
 * After Stripe sends the payer back, the invoice stays "sent" until the webhook lands.
 * Poll the public JSON view every 3 seconds for 30 seconds. The success URL never marks it paid.
 */
export function PaymentPoll({ token }: { token: string }) {
  const router = useRouter();
  const [waiting, setWaiting] = useState(true);

  useEffect(() => {
    let stopped = false;
    let tries = 0;
    let timer = 0;

    const tick = async () => {
      if (stopped) return;
      tries += 1;
      try {
        const response = await fetch(`/api/public/invoices/${encodeURIComponent(token)}`, { cache: "no-store" });
        if (response.ok) {
          const body = (await response.json()) as { invoice?: { status?: string } };
          if (body.invoice?.status === "paid") {
            router.refresh();
            return;
          }
        }
      } catch {
        // Keep the last server render and try again until the window ends.
      }
      if (tries >= TRIES) {
        setWaiting(false);
        return;
      }
      timer = window.setTimeout(() => void tick(), INTERVAL_MS);
    };

    timer = window.setTimeout(() => void tick(), INTERVAL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [router, token]);

  return (
    <p role="status" className="text-sm font-medium">
      {waiting
        ? "Payment processing. This page checks for about 30 seconds."
        : "Payment is still processing. Refresh this page in a moment to check again."}
    </p>
  );
}
