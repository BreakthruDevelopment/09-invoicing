"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { buttonPrimary } from "@/components/ui/styles";
import { Alert } from "./feedback";

/** Confirms the demo payment through the public route, then returns to the invoice. */
export function DemoPayButton({ token }: { token: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setError(null);
    setPending(true);
    try {
      const response = await fetch(`/api/public/invoices/${encodeURIComponent(token)}/demo-pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      const body = (await response.json().catch(() => null)) as { error?: unknown } | null;
      if (!response.ok) {
        setError(typeof body?.error === "string" ? body.error : "That payment didn’t go through. Try again.");
        setPending(false);
        return;
      }
      router.push(`/i/${token}`);
      router.refresh();
    } catch {
      setError("That payment didn’t go through. Try again.");
      setPending(false);
    }
  }

  return (
    <div className="space-y-2">
      <button type="button" className={`${buttonPrimary} w-full sm:w-auto`} disabled={pending} onClick={() => void confirm()}>
        {pending ? "Confirming…" : "Confirm demo payment"}
      </button>
      {error && <Alert>{error}</Alert>}
    </div>
  );
}
