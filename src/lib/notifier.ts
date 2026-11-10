/**
 * The seam for sending invoices by email. There is no email in this app (the owner copies the share link or opens
 * a `mailto:` in their own mail app), so the only implementation does nothing. If email is added later, implement
 * this interface; app 11's in-app outbox is the pattern to follow.
 */
export type InvoiceNotice = { invoiceId: string; kind: "sent" | "paid" | "voided" };

export interface Notifier {
  notify(notice: InvoiceNotice): Promise<void>;
}

export const noopNotifier: Notifier = { notify: () => Promise.resolve() };
