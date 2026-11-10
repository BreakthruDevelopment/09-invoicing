"use client";

import { useState, useTransition } from "react";
import { DemoBadge, Panel } from "@/components/ui";
import { buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import { addNotesLines, draftFromNotes } from "@/app/invoices/actions";
import { formatCents } from "@/lib/money";
import { formatCentsInput, formatQuantity } from "@/lib/form-money";
import { Alert } from "./feedback";
import { KIND_LABEL } from "./labels";
import type { ClientInvoice, NotesReview } from "./types";

/**
 * Review table for "Draft from notes". Each line shows the evidence the guardrails kept.
 * Nothing is saved until the owner checks lines and presses Add to invoice.
 * A 409 (the price changed) tells them to draft again.
 */
export function DraftFromNotes({
  invoiceId,
  clientId,
  version,
  dirty,
  onApplied,
}: {
  invoiceId: string;
  clientId: string | null;
  version: number;
  dirty: boolean;
  onApplied: (invoice: ClientInvoice) => void;
}) {
  const [notes, setNotes] = useState("");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [review, setReview] = useState<NotesReview | null>(null);
  const [picked, setPicked] = useState<boolean[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function draft() {
    if (!clientId) return;
    setError(null);
    startTransition(async () => {
      const result = await draftFromNotes({ invoiceId, clientId, notes, periodFrom, periodTo });
      if (!result.ok) {
        setReview(null);
        setError(result.error);
        return;
      }
      setReview(result.review);
      setPicked(result.review.lines.map(() => true));
    });
  }

  function add() {
    if (!review) return;
    const lineIndexes = picked.flatMap((on, index) => (on ? [index] : []));
    if (lineIndexes.length === 0) {
      setError("Choose at least one line.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await addNotesLines({ invoiceId, draftId: review.draftId, lineIndexes, version });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setReview(null);
      setNotes("");
      onApplied(result.invoice);
    });
  }

  return (
    <Panel
      title="Draft from notes"
      action={review?.demo ? <DemoBadge label="Demo answer" /> : undefined}
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          Paste project notes. The draft quotes the evidence for each line. Totals are calculated on the server, and
          nothing is added until you confirm.
        </p>
        {!clientId && (
          <p className="text-sm text-muted">Choose a client and save the draft before drafting from notes.</p>
        )}
        <label className={labelClass}>
          <span>Notes</span>
          <textarea
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={6000}
            rows={6}
            disabled={!clientId || pending}
            className={`${inputClass} min-h-32 py-2`}
            placeholder="Mon 9:00–12:30 API work"
          />
        </label>
        <p className="text-sm text-muted">{notes.length} / 6000</p>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={labelClass}>
            <span>Period from (optional)</span>
            <input type="date" value={periodFrom} onChange={(event) => setPeriodFrom(event.target.value)} disabled={pending} className={inputClass} />
          </label>
          <label className={labelClass}>
            <span>Period to (optional)</span>
            <input type="date" value={periodTo} onChange={(event) => setPeriodTo(event.target.value)} disabled={pending} className={inputClass} />
          </label>
        </div>
        <button type="button" className={buttonSecondary} disabled={!clientId || pending || notes.trim() === ""} onClick={draft}>
          {pending && !review ? "Drafting…" : "Draft lines"}
        </button>
        {error && <Alert>{error}</Alert>}
        {review && review.lines.length === 0 && (
          <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">No billable lines in these notes.</p>
        )}
        {review && review.lines.length > 0 && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              {review.period.from} to {review.period.to}. Subtotal {formatCents(review.subtotalCents)}, before tax.
            </p>
            <ul className="grid gap-3" aria-label="Drafted lines">
              {review.lines.map((line, index) => (
                <li key={`${line.evidence}-${index}`} className="rounded-card border border-border p-3">
                  <label className="flex min-h-11 items-start gap-3">
                    <input
                      type="checkbox"
                      className="mt-1 size-5 accent-accent"
                      checked={picked[index] ?? false}
                      onChange={(event) =>
                        setPicked((current) => current.map((on, i) => (i === index ? event.target.checked : on)))
                      }
                    />
                    <span className="min-w-0 space-y-1">
                      <span className="block font-medium break-words">{line.description}</span>
                      <span className="block text-sm text-muted">
                        {KIND_LABEL[line.kind]} · {formatQuantity(line.quantityX100)} × {formatCentsInput(line.unitPriceCents)} ·{" "}
                        {formatCents(line.amountCents)}
                      </span>
                    </span>
                  </label>
                  <p className="mt-2 text-sm break-words">
                    <span className="text-muted">Evidence ({line.sourceLines.join(", ")}): </span>
                    “{line.evidence}”
                  </p>
                </li>
              ))}
            </ul>
            {dirty && (
              <p className="text-sm text-muted">Save your line edits before adding these, or those edits will be dropped.</p>
            )}
            <button type="button" className={buttonPrimary} disabled={pending || dirty} onClick={add}>
              {pending ? "Adding…" : "Add to invoice"}
            </button>
          </div>
        )}
        {review && review.assumptions.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">Assumptions</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
              {review.assumptions.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {review && review.unbillable.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">Not billed</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
              {review.unbillable.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
          </div>
        )}
        {review && review.dropped.length > 0 && (
          <div>
            <h3 className="text-sm font-semibold">Left out</h3>
            <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-muted">
              {review.dropped.map((item) => (
                <li key={`${item.description}-${item.reason}`}>
                  {item.description ? `${item.description}: ` : ""}
                  {item.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Panel>
  );
}
