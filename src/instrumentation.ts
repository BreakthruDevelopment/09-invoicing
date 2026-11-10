/**
 * Runs once when a server instance starts. With MIGRATE_ON_START=true it applies
 * pending database migrations before the server takes traffic. A Postgres advisory
 * lock makes it safe when several instances start at once. Then it starts the background
 * job worker (a no-op until an app registers handlers in src/lib/jobs/handlers.ts).
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  if (process.env.MIGRATE_ON_START === "true") {
    const { migrateOnStart } = await import("./lib/db/migrate-on-start");
    await migrateOnStart();
  }
  // Not awaited: while migrations retry in the background the server must still start.
  const { startJobs } = await import("./lib/jobs/start");
  startJobs().catch(async (err) => {
    const [{ log }, { safeErrorFields }] = await Promise.all([import("./lib/log"), import("./lib/safe-error")]);
    log.error("jobs.start_failed", safeErrorFields(err));
  });
}
