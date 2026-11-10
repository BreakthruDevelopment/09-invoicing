import { ZodError } from "zod";
import { errorInfo } from "@/lib/http";

/** A message safe to show next to a form. Never a stack trace or a database detail. */
export function actionMessage(err: unknown): string {
  if (err instanceof ZodError) {
    return err.issues[0]?.message ?? "Check the form and try again.";
  }
  return errorInfo(err).body.error;
}
