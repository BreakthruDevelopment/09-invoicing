"use client";

import { useActionState, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { buttonDanger, buttonPrimary, inputClass, labelClass } from "@/components/ui/styles";
import { archiveClientAction, createClientAction, updateClientAction, type FormState } from "@/app/clients/actions";
import { formatCentsInput } from "@/lib/form-money";
import { Alert, SavedNote } from "./feedback";

const empty: FormState = { error: "" };

export function ClientForm({
  id,
  client,
}: {
  id?: string;
  client?: { name: string; email: string | null; address: string; hourlyRateCents: number; archived: boolean };
}) {
  const update = id ? updateClientAction.bind(null, id) : createClientAction;
  const [state, action, pending] = useActionState(update, empty);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const [archiving, startArchive] = useTransition();
  const router = useRouter();
  const locked = client?.archived === true;

  return (
    <form action={locked ? undefined : action} className="space-y-4">
      <label className={labelClass}>
        <span>Name</span>
        <input name="name" required maxLength={120} defaultValue={client?.name ?? ""} disabled={locked || pending} className={inputClass} />
      </label>
      <label className={labelClass}>
        <span>Email</span>
        <input name="email" type="email" maxLength={254} defaultValue={client?.email ?? ""} disabled={locked || pending} className={inputClass} autoComplete="off" />
      </label>
      <label className={labelClass}>
        <span>Address</span>
        <textarea name="address" maxLength={300} rows={3} defaultValue={client?.address ?? ""} disabled={locked || pending} className={`${inputClass} min-h-24 py-2`} />
      </label>
      <label className={labelClass}>
        <span>Hourly rate (USD)</span>
        <input
          name="hourlyRate"
          inputMode="decimal"
          defaultValue={client ? formatCentsInput(client.hourlyRateCents) : "0.00"}
          disabled={locked || pending}
          className={inputClass}
          aria-describedby="rate-hint"
        />
      </label>
      <p id="rate-hint" className="text-sm text-muted">
        Dollars, from 0 to 1000.00. Hours lines drafted from notes use this rate.
      </p>
      {locked && <p className="text-sm text-muted">This client is archived. Their invoices stay as they are.</p>}
      {state.error && <Alert>{state.error}</Alert>}
      {archiveError && <Alert>{archiveError}</Alert>}
      {state.saved && <SavedNote>Saved.</SavedNote>}
      {!locked && (
        <div className="flex flex-wrap gap-3">
          <button type="submit" className={buttonPrimary} disabled={pending || archiving}>
            {pending ? "Saving…" : id ? "Save client" : "Add client"}
          </button>
          {id && (
            <button
              type="button"
              className={buttonDanger}
              disabled={pending || archiving}
              onClick={() => {
                setArchiveError(null);
                startArchive(async () => {
                  const result = await archiveClientAction(id);
                  if (result.error) {
                    setArchiveError(result.error);
                    return;
                  }
                  router.push("/clients");
                });
              }}
            >
              {archiving ? "Archiving…" : "Archive"}
            </button>
          )}
        </div>
      )}
    </form>
  );
}
