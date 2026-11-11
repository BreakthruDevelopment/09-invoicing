"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DataList, type Column, Panel } from "@/components/ui";
import { buttonDanger, buttonPrimary, buttonSecondary, inputClass, labelClass } from "@/components/ui/styles";
import {
  copyInvoice,
  quoteDraft,
  recordPayment,
  removeDraft,
  rotateLink,
  saveDraft,
  sendInvoice,
  voidInvoice,
} from "@/app/invoices/actions";
import { formatCentsInput, formatQuantity, formatTaxPercent } from "@/lib/form-money";
import { formatCents } from "@/lib/money";
import { DraftFromNotes } from "./draft-from-notes";
import { Alert, SavedNote } from "./feedback";
import { InvoiceStatusBadge } from "./invoice-status";
import { FLAG_LABEL, KIND_LABEL, METHOD_LABEL } from "./labels";
import { MoneyRows } from "./money-rows";
import type { ClientInvoice, ClientOption, LineKind, LineSource, ServerTotals } from "./types";

type FormLine = {
  key: string;
  kind: LineKind;
  description: string;
  quantity: string;
  unitPrice: string;
  source: LineSource;
};

type EditorForm = {
  clientId: string;
  issueDate: string;
  dueDate: string;
  taxPercent: string;
  memo: string;
  lines: FormLine[];
};

function toForm(invoice: ClientInvoice): EditorForm {
  return {
    clientId: invoice.clientId ?? "",
    issueDate: invoice.issueDate,
    dueDate: invoice.dueDate,
    taxPercent: formatTaxPercent(invoice.taxBp),
    memo: invoice.memo,
    lines: invoice.lines.map((line) => ({
      key: line.id,
      kind: line.kind,
      description: line.description,
      quantity: formatQuantity(line.quantityX100),
      unitPrice: formatCentsInput(line.unitPriceCents),
      source: line.source,
    })),
  };
}

function payloadOf(form: EditorForm) {
  return {
    clientId: form.clientId,
    issueDate: form.issueDate,
    dueDate: form.dueDate,
    taxPercent: form.taxPercent,
    memo: form.memo,
    lines: form.lines.map((line) => ({
      kind: line.kind,
      description: line.description,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      source: line.source,
    })),
  };
}

function mailtoHref(email: string | null, number: string | null, url: string): string {
  const subject = number ? `Invoice ${number}` : "Invoice";
  return `mailto:${email ? encodeURIComponent(email) : ""}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(url)}`;
}

export function InvoiceScreen({ initial, clients }: { initial: ClientInvoice; clients: ClientOption[] }) {
  const router = useRouter();
  const [invoice, setInvoice] = useState(initial);
  const [form, setForm] = useState(() => toForm(initial));
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [quote, setQuote] = useState<{ key: string; totals: ServerTotals; skipped: number } | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  // "Add to invoice" is in flight: its result replaces the form, so edits made meanwhile would be lost. Lock the editor.
  const [notesPending, setNotesPending] = useState(false);
  const locked = pending || notesPending;
  const [reason, setReason] = useState("");
  const [paymentNote, setPaymentNote] = useState("");

  const savedKey = useMemo(() => JSON.stringify(payloadOf(toForm(invoice))), [invoice]);
  const currentKey = useMemo(() => JSON.stringify(payloadOf(form)), [form]);
  const dirty = currentKey !== savedKey;
  const draft = invoice.status === "draft";

  useEffect(() => {
    if (!draft) return;
    let cancel = false;
    const handle = setTimeout(() => {
      void quoteDraft({ taxPercent: form.taxPercent, lines: payloadOf(form).lines }).then((result) => {
        if (cancel) return;
        if (!result.ok) {
          setQuoteError(result.error);
          return;
        }
        setQuoteError(null);
        setQuote({ key: currentKey, totals: result.totals, skipped: result.skipped });
      });
    }, 400);
    return () => {
      cancel = true;
      clearTimeout(handle);
    };
  }, [draft, currentKey, form]);

  const freshQuote = quote && quote.key === currentKey ? quote : null;
  const totals: ServerTotals | null = freshQuote
    ? freshQuote.totals
    : !dirty
      ? {
          amounts: invoice.lines.map((line) => line.amountCents),
          subtotalCents: invoice.subtotalCents,
          taxCents: invoice.taxCents,
          totalCents: invoice.totalCents,
          taxBp: invoice.taxBp,
        }
      : null;

  function apply(next: ClientInvoice, message?: string) {
    setInvoice(next);
    setForm(toForm(next));
    setError(null);
    setNotice(message ?? null);
  }

  function save() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await saveDraft({ id: invoice.id, version: invoice.version, ...payloadOf(form) });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      apply(result.invoice, "Draft saved. Totals are from the server.");
    });
  }

  function send() {
    setError(null);
    startTransition(async () => {
      const result = await sendInvoice(invoice.id, invoice.version);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      if (result.shareUrl) setShareUrl(result.shareUrl);
      apply(result.invoice, "Sent. Copy the link below; it is shown this once.");
    });
  }

  const clientChoices = clients.filter((client) => !client.archived || client.id === form.clientId);
  const title = invoice.number ?? "Draft";

  return (
    <div className="space-y-2">
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <InvoiceStatusBadge status={invoice.status} overdue={invoice.overdue} />
        <p className="font-mono text-sm text-muted">{title}</p>
        {invoice.clientName && <p className="text-sm break-words">For {invoice.clientName}</p>}
        <a className={buttonSecondary} href={`/api/invoices/${invoice.id}/pdf`}>
          Download PDF
        </a>
      </div>
      {error && (
        <div className="mb-4">
          <Alert>{error}</Alert>
        </div>
      )}
      {notice && (
        <div className="mb-4">
          <SavedNote>{notice}</SavedNote>
        </div>
      )}

      {draft ? (
        <Panel title="Draft">
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className={labelClass}>
                <span>Client</span>
                <select
                  value={form.clientId}
                  onChange={(event) => setForm({ ...form, clientId: event.target.value })}
                  disabled={locked}
                  className={inputClass}
                >
                  <option value="">No client yet</option>
                  {clientChoices.map((client) => (
                    <option key={client.id} value={client.id}>
                      {client.name}
                      {client.archived ? " (archived)" : ""}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                <span>Tax rate (%)</span>
                <input
                  inputMode="decimal"
                  value={form.taxPercent}
                  onChange={(event) => setForm({ ...form, taxPercent: event.target.value })}
                  disabled={locked}
                  className={inputClass}
                  aria-describedby="tax-hint"
                />
              </label>
              <label className={labelClass}>
                <span>Issue date</span>
                <input type="date" value={form.issueDate} onChange={(event) => setForm({ ...form, issueDate: event.target.value })} disabled={locked} className={inputClass} />
              </label>
              <label className={labelClass}>
                <span>Due date</span>
                <input type="date" value={form.dueDate} onChange={(event) => setForm({ ...form, dueDate: event.target.value })} disabled={locked} className={inputClass} />
              </label>
            </div>
            <p id="tax-hint" className="text-sm text-muted">
              8.25 means 8.25%. Line amounts and totals update from the server.
            </p>
            <LineEditor
              lines={form.lines}
              amounts={totals?.amounts ?? null}
              disabled={locked}
              onChange={(lines) => setForm({ ...form, lines })}
            />
            <label className={labelClass}>
              <span>Memo</span>
              <textarea
                value={form.memo}
                onChange={(event) => setForm({ ...form, memo: event.target.value })}
                maxLength={1000}
                rows={3}
                disabled={locked}
                className={`${inputClass} min-h-24 py-2`}
              />
            </label>
            <TotalsReadout totals={totals} skipped={freshQuote?.skipped ?? 0} updating={dirty && !freshQuote} quoteError={quoteError} />
            <div className="flex flex-wrap gap-3">
              <button type="button" className={buttonPrimary} disabled={locked} onClick={save}>
                {pending ? "Saving…" : "Save draft"}
              </button>
              <button type="button" className={buttonSecondary} disabled={locked || dirty || !invoice.clientId || invoice.lines.length === 0 || invoice.totalCents <= 0} onClick={send}>
                Send
              </button>
            </div>
            {dirty && <p className="text-sm text-muted">Save the draft before sending. Send uses the saved invoice.</p>}
          </div>
        </Panel>
      ) : (
        <Panel title="Invoice">
          <div className="mb-4 grid gap-2 text-sm sm:grid-cols-2">
            <p><span className="text-muted">Issued </span><time dateTime={invoice.issueDate}>{invoice.issueDate}</time></p>
            <p><span className="text-muted">Due </span><time dateTime={invoice.dueDate}>{invoice.dueDate}</time></p>
          </div>
          <ReadOnlyLines invoice={invoice} />
          {invoice.memo && <p className="mt-4 text-sm break-words">{invoice.memo}</p>}
          {invoice.voidReason && <p className="mt-3 text-sm text-muted">Voided: {invoice.voidReason}</p>}
          <div className="mt-4 max-w-sm">
            <MoneyRows
              subtotalCents={invoice.subtotalCents}
              taxBp={invoice.taxBp}
              taxCents={invoice.taxCents}
              totalCents={invoice.totalCents}
              paidCents={invoice.paidCents}
              balanceCents={invoice.balanceCents}
            />
          </div>
        </Panel>
      )}

      {draft && (
        <DraftFromNotes
          invoiceId={invoice.id}
          clientId={invoice.clientId}
          version={invoice.version}
          dirty={dirty}
          onPendingChange={setNotesPending}
          onApplied={(next) => apply(next, "Lines added. Totals were recalculated on the server.")}
        />
      )}

      {invoice.status !== "draft" && (
        <SharePanel
          invoice={invoice}
          shareUrl={shareUrl}
          copied={copied}
          pending={pending}
          onCopy={async () => {
            if (!shareUrl) return;
            try {
              await navigator.clipboard.writeText(shareUrl);
              setCopied(true);
            } catch {
              setError("Select the link and copy it.");
            }
          }}
          onRotate={() => {
            setError(null);
            setCopied(false);
            startTransition(async () => {
              const result = await rotateLink(invoice.id);
              if (!result.ok) {
                setError(result.error);
                return;
              }
              setShareUrl(result.shareUrl);
              setInvoice({ ...invoice, hasShareLink: true });
              setNotice("New link ready. The previous one has stopped working.");
            });
          }}
        />
      )}

      <Panel title="Payments">
        <PaymentList invoice={invoice} />
        {invoice.status === "sent" && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-muted">
              Records the full balance ({formatCents(invoice.balanceCents)}) as paid outside this app.
            </p>
            <label className={labelClass}>
              <span>Note (optional)</span>
              <input value={paymentNote} onChange={(event) => setPaymentNote(event.target.value)} maxLength={200} disabled={pending} className={inputClass} />
            </label>
            <button
              type="button"
              className={buttonSecondary}
              disabled={pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await recordPayment(invoice.id, invoice.version, paymentNote);
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  apply(result.invoice, "Payment recorded.");
                  setPaymentNote("");
                });
              }}
            >
              {pending ? "Working…" : "Record payment"}
            </button>
          </div>
        )}
      </Panel>

      <Panel title="More">
        <div className="flex flex-wrap gap-3">
          <button
            type="button"
            className={buttonSecondary}
            disabled={pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await copyInvoice(invoice.id);
                if (!result.ok) {
                  setError(result.error);
                  return;
                }
                router.push(`/invoices/${result.id}`);
              });
            }}
          >
            Duplicate
          </button>
          {draft && (
            <button
              type="button"
              className={buttonDanger}
              disabled={pending}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await removeDraft(invoice.id);
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  router.push("/invoices");
                });
              }}
            >
              Delete draft
            </button>
          )}
        </div>
        {(invoice.status === "draft" || invoice.status === "sent") && (
          <div className="mt-4 space-y-3">
            <label className={labelClass}>
              <span>Reason for voiding</span>
              <input value={reason} onChange={(event) => setReason(event.target.value)} maxLength={200} disabled={pending} className={inputClass} />
            </label>
            <button
              type="button"
              className={buttonDanger}
              disabled={pending || reason.trim() === ""}
              onClick={() => {
                setError(null);
                startTransition(async () => {
                  const result = await voidInvoice(invoice.id, invoice.version, reason);
                  if (!result.ok) {
                    setError(result.error);
                    return;
                  }
                  apply(result.invoice, "Invoice voided.");
                  setReason("");
                });
              }}
            >
              Void invoice
            </button>
          </div>
        )}
      </Panel>
    </div>
  );
}

function TotalsReadout({
  totals,
  skipped,
  updating,
  quoteError,
}: {
  totals: ServerTotals | null;
  skipped: number;
  updating: boolean;
  quoteError: string | null;
}) {
  return (
    <div aria-live="polite" className="max-w-sm rounded-card bg-background px-4 py-3">
      <h3 className="mb-2 text-sm font-semibold">Totals</h3>
      {totals ? (
        <MoneyRows subtotalCents={totals.subtotalCents} taxBp={totals.taxBp} taxCents={totals.taxCents} totalCents={totals.totalCents} />
      ) : (
        <p className="text-sm text-muted">{updating ? "Updating totals…" : "Totals appear when the server answers."}</p>
      )}
      {skipped > 0 && <p className="mt-2 text-sm text-muted">Finish each line to include it. Unfinished lines are not in the total.</p>}
      {quoteError && (
        <div className="mt-2">
          <Alert>{quoteError}</Alert>
        </div>
      )}
    </div>
  );
}

function LineEditor({
  lines,
  amounts,
  disabled,
  onChange,
}: {
  lines: FormLine[];
  amounts: (number | null)[] | null;
  disabled: boolean;
  onChange: (lines: FormLine[]) => void;
}) {
  function update(index: number, patch: Partial<FormLine>) {
    onChange(lines.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  }

  return (
    <fieldset className="space-y-3" disabled={disabled}>
      <legend className="mb-1 text-sm font-semibold">Line items</legend>
      <div className="hidden gap-2 px-1 text-sm font-medium text-muted sm:grid sm:grid-cols-[7.5rem_minmax(0,1fr)_5.5rem_6.5rem_5.5rem_auto]">
        <span>Kind</span>
        <span>Description</span>
        <span>Qty</span>
        <span>Price</span>
        <span>Amount</span>
        <span className="sr-only">Remove</span>
      </div>
      <ul className="grid gap-3">
        {lines.map((line, index) => {
          const amount = amounts?.[index];
          return (
            <li
              key={line.key}
              className="grid gap-3 rounded-card border border-border p-3 sm:grid-cols-[7.5rem_minmax(0,1fr)_5.5rem_6.5rem_5.5rem_auto] sm:items-end sm:gap-2 sm:border-0 sm:p-0"
            >
              <label className={labelClass}>
                <span className="sm:sr-only">Kind</span>
                <select value={line.kind} onChange={(event) => update(index, { kind: event.target.value as LineKind })} className={inputClass}>
                  {(Object.keys(KIND_LABEL) as LineKind[]).map((kind) => (
                    <option key={kind} value={kind}>
                      {KIND_LABEL[kind]}
                    </option>
                  ))}
                </select>
              </label>
              <label className={labelClass}>
                <span className="sm:sr-only">Description</span>
                <input value={line.description} onChange={(event) => update(index, { description: event.target.value })} maxLength={300} className={inputClass} />
              </label>
              <label className={labelClass}>
                <span className="sm:sr-only">Quantity</span>
                <input inputMode="decimal" value={line.quantity} onChange={(event) => update(index, { quantity: event.target.value })} className={inputClass} />
              </label>
              <label className={labelClass}>
                <span className="sm:sr-only">Price (USD)</span>
                <input inputMode="decimal" value={line.unitPrice} onChange={(event) => update(index, { unitPrice: event.target.value })} className={inputClass} />
              </label>
              <p className="flex min-h-11 items-center text-sm font-medium tabular-nums">
                <span className="sr-only">Amount </span>
                {amount === null || amount === undefined ? "—" : formatCents(amount)}
                {line.source === "ai" && <span className="sr-only"> From notes</span>}
              </p>
              <button
                type="button"
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-card border border-border px-3 text-sm font-semibold text-danger"
                onClick={() => onChange(lines.filter((row) => row.key !== line.key))}
              >
                Remove
              </button>
              {line.source === "ai" && <p className="text-xs text-muted sm:col-span-6">From notes</p>}
            </li>
          );
        })}
      </ul>
      {lines.length === 0 && <p className="rounded-card bg-background px-4 py-6 text-center text-sm text-muted">No lines yet.</p>}
      <button
        type="button"
        className="inline-flex min-h-11 items-center text-sm font-semibold text-accent underline underline-offset-2"
        disabled={disabled || lines.length >= 50}
        onClick={() =>
          onChange([
            ...lines,
            { key: `new-${lines.length}-${Date.now()}`, kind: "hours", description: "", quantity: "1", unitPrice: "", source: "manual" },
          ])
        }
      >
        Add line
      </button>
    </fieldset>
  );
}

function ReadOnlyLines({ invoice }: { invoice: ClientInvoice }) {
  const columns: Column<ClientInvoice["lines"][number]>[] = [
    { key: "description", header: "Description", primary: true, cell: (line) => <span className="break-words">{line.description}</span> },
    { key: "kind", header: "Kind", cell: (line) => KIND_LABEL[line.kind] },
    { key: "qty", header: "Qty", cell: (line) => formatQuantity(line.quantityX100) },
    { key: "price", header: "Price", cell: (line) => formatCents(line.unitPriceCents) },
    { key: "amount", header: "Amount", cell: (line) => formatCents(line.amountCents) },
    {
      key: "source",
      header: "Source",
      cell: (line) => (line.source === "ai" ? "From notes" : "Manual"),
    },
  ];
  return <DataList caption="Line items" rows={invoice.lines} rowKey={(line) => line.id} columns={columns} empty="No lines." />;
}

function PaymentList({ invoice }: { invoice: ClientInvoice }) {
  const columns: Column<ClientInvoice["payments"][number]>[] = [
    { key: "when", header: "When", primary: true, cell: (row) => row.receivedAt.slice(0, 10) },
    { key: "method", header: "Method", cell: (row) => METHOD_LABEL[row.method] },
    { key: "amount", header: "Amount", cell: (row) => formatCents(row.amountCents) },
    {
      key: "note",
      header: "Note",
      cell: (row) => row.flag ? FLAG_LABEL[row.flag] : row.note || "—",
    },
  ];
  return <DataList caption="Payments" rows={invoice.payments} rowKey={(row) => row.id} columns={columns} empty="No payments yet." />;
}

function SharePanel({
  invoice,
  shareUrl,
  copied,
  pending,
  onCopy,
  onRotate,
}: {
  invoice: ClientInvoice;
  shareUrl: string | null;
  copied: boolean;
  pending: boolean;
  onCopy: () => void;
  onRotate: () => void;
}) {
  return (
    <Panel title="Share link">
      <div className="space-y-3">
        <p className="text-sm text-muted">
          {invoice.hasShareLink && !shareUrl
            ? "A link is active, but the address was only shown when it was created. Rotate it to copy a new one. The old link stops working right away. Invoices from the demo workspace need this rotate before the link can be opened."
            : "Copy the link or open it in your mail app. The message is the subject and the link only."}
        </p>
        {shareUrl && (
          <>
            <label className={labelClass}>
              <span>Link</span>
              <input readOnly value={shareUrl} className={inputClass} onFocus={(event) => event.currentTarget.select()} />
            </label>
            <div className="flex flex-wrap gap-3">
              <button type="button" className={buttonSecondary} onClick={onCopy}>
                {copied ? "Copied" : "Copy"}
              </button>
              <a className={buttonSecondary} href={mailtoHref(invoice.mailtoEmail, invoice.number, shareUrl)}>
                Email link
              </a>
            </div>
          </>
        )}
        <button type="button" className={buttonSecondary} disabled={pending} onClick={onRotate}>
          {pending ? "Working…" : "Rotate link"}
        </button>
      </div>
    </Panel>
  );
}
