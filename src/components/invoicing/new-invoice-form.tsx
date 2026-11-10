"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { startDraft } from "@/app/invoices/actions";
import { Alert } from "./feedback";
import type { ClientOption } from "./types";

export function NewInvoiceForm({
  clients,
  issueDate,
  dueDate,
}: {
  clients: ClientOption[];
  issueDate: string;
  dueDate: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const active = clients.filter((client) => !client.archived);

  function submit(form: FormData) {
    setError(null);
    startTransition(async () => {
      const result = await startDraft({
        clientId: String(form.get("clientId") ?? ""),
        issueDate: String(form.get("issueDate") ?? ""),
        dueDate: String(form.get("dueDate") ?? ""),
        taxPercent: String(form.get("taxPercent") ?? ""),
        memo: String(form.get("memo") ?? ""),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(`/invoices/${result.id}`);
    });
  }

  return (
    <form action={submit} className="space-y-4">
      <label className={labelClass}>
        <span>Client</span>
        <select name="clientId" defaultValue="" disabled={pending} className={inputClass}>
          <option value="">Choose later</option>
          {active.map((client) => (
            <option key={client.id} value={client.id}>
              {client.name}
            </option>
          ))}
        </select>
      </label>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className={labelClass}>
          <span>Issue date</span>
          <input name="issueDate" type="date" required defaultValue={issueDate} disabled={pending} className={inputClass} />
        </label>
        <label className={labelClass}>
          <span>Due date</span>
          <input name="dueDate" type="date" required defaultValue={dueDate} disabled={pending} className={inputClass} />
        </label>
      </div>
      <label className={labelClass}>
        <span>Tax rate (%)</span>
        <input name="taxPercent" inputMode="decimal" defaultValue="0" disabled={pending} className={inputClass} aria-describedby="new-tax-hint" />
      </label>
      <p id="new-tax-hint" className="text-sm text-muted">
        You’ll add lines next. Totals are calculated on the server when you save.
      </p>
      <label className={labelClass}>
        <span>Memo</span>
        <textarea name="memo" maxLength={1000} rows={3} disabled={pending} className={`${inputClass} min-h-24 py-2`} />
      </label>
      {error && <Alert>{error}</Alert>}
      <button type="submit" className={buttonPrimary} disabled={pending}>
        {pending ? "Creating…" : "Create draft"}
      </button>
    </form>
  );
}
