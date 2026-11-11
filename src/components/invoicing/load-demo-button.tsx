"use client";

import { useState, useTransition } from "react";
import { buttonPrimary } from "@/components/ui/styles";
import { loadDemoAction } from "@/app/admin/actions";
import { Alert, SavedNote } from "./feedback";

export function LoadDemoButton() {
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Replaces the two demo businesses with sample clients and invoices. This page only gets counts back. A demo
        invoice’s share link works after the owner rotates it.
      </p>
      <button
        type="button"
        className={buttonPrimary}
        disabled={pending}
        onClick={() => {
          setError(null);
          setMessage(null);
          startTransition(async () => {
            const result = await loadDemoAction();
            if (!result.ok) {
              setError(result.error);
              return;
            }
            setMessage(`Loaded ${result.users} users, ${result.clients} clients, ${result.invoices} invoices and ${result.notes} notes.`);
          });
        }}
      >
        {pending ? "Loading…" : "Load demo workspace"}
      </button>
      {error && <Alert>{error}</Alert>}
      {message && <SavedNote>{message}</SavedNote>}
    </div>
  );
}
