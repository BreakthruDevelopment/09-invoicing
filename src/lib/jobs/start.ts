import "server-only";

/**
 * Start the job worker once migrations are done. Called from `instrumentation.ts`. With no handlers registered it
 * starts nothing (no timer, no queries), so the template itself is inert. Returns whether a worker was started.
 */
export async function startJobs(): Promise<boolean> {
  const { whenMigrated } = await import("../db/migrate-on-start");
  await whenMigrated();
  const { handlers } = await import("./handlers");
  if (Object.keys(handlers).length === 0) return false;
  const { startWorker } = await import("./worker");
  startWorker({ handlers });
  return true;
}
