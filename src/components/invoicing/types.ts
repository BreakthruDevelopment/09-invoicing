export type LineKind = "hours" | "fixed" | "expense";
export type LineSource = "manual" | "ai";
export type InvoiceStatus = "draft" | "sent" | "paid" | "void";
export type PaymentMethod = "demo" | "stripe" | "manual";
export type PaymentFlag = "amount_mismatch" | "invoice_void" | "duplicate_payment";

/** An invoice the pages can render. Amounts are the integers the server stored or just returned. */
export type ClientInvoice = {
  id: string;
  version: number;
  status: InvoiceStatus;
  overdue: boolean;
  number: string | null;
  clientId: string | null;
  clientName: string | null;
  issueDate: string;
  dueDate: string;
  taxBp: number;
  memo: string;
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  paidCents: number;
  /** What is still owed. Zero unless the invoice is sent. */
  balanceCents: number;
  hasShareLink: boolean;
  voidReason: string | null;
  mailtoEmail: string | null;
  lines: {
    id: string;
    kind: LineKind;
    description: string;
    quantityX100: number;
    unitPriceCents: number;
    amountCents: number;
    source: LineSource;
  }[];
  payments: {
    id: string;
    method: PaymentMethod;
    amountCents: number;
    note: string;
    flag: PaymentFlag | null;
    receivedAt: string;
  }[];
};

export type ClientOption = {
  id: string;
  name: string;
  email: string | null;
  archived: boolean;
};

/** Totals a server action just computed. The browser only prints them. */
export type ServerTotals = {
  amounts: (number | null)[];
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
  taxBp: number;
};

export type NotesReview = {
  draftId: string;
  demo: boolean;
  subtotalCents: number;
  assumptions: string[];
  unbillable: string[];
  dropped: { reason: string; description: string }[];
  period: { from: string; to: string };
  lines: {
    kind: LineKind;
    description: string;
    quantityX100: number;
    unitPriceCents: number;
    amountCents: number;
    sourceLines: string[];
    evidence: string;
  }[];
};
