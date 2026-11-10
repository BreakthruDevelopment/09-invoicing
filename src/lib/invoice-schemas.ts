import { z } from "zod";
import { INVOICE_STATUSES, LINE_KINDS, LINE_SOURCES } from "@/lib/db/schema";
import { MAX_LINES, MAX_QUANTITY_X100, MAX_TAX_BP, MAX_UNIT_PRICE_CENTS, MIN_QUANTITY_X100 } from "@/lib/money";

/** Caps from the spec's "Rate limits and caps" table. */
export const WRITES_PER_HOUR = 300;
export const MAX_CLIENTS_PER_USER = 200;
export const MAX_INVOICES_PER_USER = 2_000;
export const JSON_LIMIT = 32 * 1024;

export const idSchema = z.string().uuid();

const plainText = (max: number) => z.string().max(max).refine((v) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(v), "Control characters aren't allowed");

/** A real calendar date, `YYYY-MM-DD`. */
export const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use YYYY-MM-DD")
  .refine((v) => {
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  }, "Not a real date");

export const timeZoneSchema = z
  .string()
  .min(1)
  .max(64)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, "Unknown time zone");

export const profileInput = z.object({
  name: plainText(120).transform((v) => v.trim()),
  address: plainText(300).transform((v) => v.trim()),
  contactEmail: z.union([z.literal(""), z.string().trim().max(254).email()]),
  timeZone: timeZoneSchema,
  defaultTermsDays: z.number().int().min(0).max(90),
});

const emailOrNull = z
  .union([z.literal(""), z.string().trim().max(254).email()])
  .nullable()
  .transform((v) => (v ? v : null));

export const clientInput = z.object({
  name: plainText(120).transform((v) => v.trim()).pipe(z.string().min(1, "Name is required")),
  email: emailOrNull.default(null),
  address: plainText(300).transform((v) => v.trim()).default(""),
  hourlyRateCents: z.number().int().min(0).max(100_000).default(0),
});
export const clientPatch = clientInput.partial().refine((v) => Object.keys(v).length > 0, "Nothing to change");

export const lineInput = z.object({
  kind: z.enum(LINE_KINDS),
  description: plainText(300).transform((v) => v.trim()).pipe(z.string().min(1, "Description is required")),
  /** Hundredths of a unit: 350 = 3.5 hours. */
  quantityX100: z.number().int().min(MIN_QUANTITY_X100).max(MAX_QUANTITY_X100),
  unitPriceCents: z.number().int().min(0).max(MAX_UNIT_PRICE_CENTS),
  source: z.enum(LINE_SOURCES).default("manual"),
});
export type LineInput = z.infer<typeof lineInput>;

const linesInput = z.array(lineInput).max(MAX_LINES);
const taxBp = z.number().int().min(0).max(MAX_TAX_BP);
const memo = plainText(1_000);

export const invoiceCreateInput = z
  .object({
    clientId: idSchema.nullable().optional(),
    issueDate: dateSchema.optional(),
    dueDate: dateSchema.optional(),
    taxBp: taxBp.default(0),
    memo: memo.default(""),
    lines: linesInput.default([]),
  })
  .strict();

export const invoicePatchInput = z
  .object({
    version: z.number().int().min(1),
    clientId: idSchema.nullable().optional(),
    issueDate: dateSchema.optional(),
    dueDate: dateSchema.optional(),
    taxBp: taxBp.optional(),
    memo: memo.optional(),
    /** Replaces all lines when present. */
    lines: linesInput.optional(),
  })
  .strict();

export const transitionInput = z
  .object({
    to: z.enum(["sent", "void"]),
    version: z.number().int().min(1),
    reason: plainText(200).transform((v) => v.trim()).optional(),
  })
  .strict()
  .refine((v) => v.to !== "void" || (v.reason !== undefined && v.reason.length > 0), { message: "A reason is required to void an invoice", path: ["reason"] });

export const manualPaymentInput = z
  .object({ version: z.number().int().min(1), note: plainText(200).transform((v) => v.trim()).default("") })
  .strict();

export const listQuery = z.object({
  status: z.enum([...INVOICE_STATUSES, "overdue"]).optional(),
  clientId: idSchema.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(100),
});
