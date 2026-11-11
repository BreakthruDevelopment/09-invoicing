"use client";

import { useState } from "react";
import { buttonPrimary } from "@/components/ui/styles";
import { Alert } from "./feedback";

/** Starts checkout through the public route, which enforces the per-invoice limit, then follows the returned URL. */
export function PayButton({ token, mode }: { token: string; mode: "demo" | "stripe" }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = mode === "demo" ? "Pay (demo)" : "Pay invoice";

  async function pay() {
    setError(null);
    setPending(true);
    try {
      const response = await fetch(`/i/${token}/checkout`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await response.json().catch(() => null)) as { error?: unknown; url?: unknown } | null;
      if (!response.ok || typeof body?.url !== "string") {
        setError(typeof body?.error === "string" ? body.error : "Payment couldn’t be started. Try again.");
        setPending(false);
        return;
      }
      window.location.assign(body.url);
    } catch {
      setError("Payment couldn’t be started. Try again.");
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <button type="button" className={`${buttonPrimary} w-full sm:w-auto`} disabled={pending} onClick={() => void pay()}>
        {pending ? "Starting payment…" : label}
      </button>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
