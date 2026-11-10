import type { JobHandlers } from "./worker";

/**
 * Register job handlers here: one entry per job `kind`. `instrumentation.ts` hands this map to `startWorker`.
 * The template ships none, so its worker does nothing until an app adds some.
 *
 *   export const handlers: JobHandlers = { "fetch-link": fetchLinkHandler };
 */
export const handlers: JobHandlers = {};
