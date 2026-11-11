import type { LineKind, PaymentFlag, PaymentMethod } from "./types";

export const KIND_LABEL: Record<LineKind, string> = {
  hours: "Hours",
  fixed: "Fixed fee",
  expense: "Expense",
};

export const METHOD_LABEL: Record<PaymentMethod, string> = {
  demo: "Demo",
  stripe: "Card",
  manual: "Manual",
};

export const FLAG_LABEL: Record<PaymentFlag, string> = {
  amount_mismatch: "Amount didn't match",
  invoice_void: "Invoice was void",
  duplicate_payment: "Duplicate payment",
};
