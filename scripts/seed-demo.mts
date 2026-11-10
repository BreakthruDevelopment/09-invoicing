/**
 * Loads the demo workspace (2 owners, 4 clients, 8 invoices) into a LOCAL database. Refuses production hosts before
 * importing any database or auth code:
 *   DEMO_SEED=yes APP_URL=http://localhost:3000 DEMO_PASSWORD=<10+ chars> DATABASE_URL=... pnpm seed:demo
 */
import { demoSeedConfig } from "../src/lib/demo-seed-config";

try {
  demoSeedConfig();
  const { loadDemoWorkspace } = await import("../src/lib/demo-workspace");
  // A trusted local CLI capability, never accepted from an HTTP request.
  const result = await loadDemoWorkspace({ id: "demo-seed-cli", role: "admin" }, { mode: "cli" });
  console.log(`Loaded ${result.users} demo owners, ${result.clients} clients, ${result.invoices} invoices and ${result.notes} saved notes.`);
} catch (err) {
  console.error(err instanceof Error ? err.message : "Demo seed failed.");
  process.exitCode = 1;
} finally {
  const connection = globalThis as unknown as { sql?: { end(): Promise<void> } };
  await connection.sql?.end();
}
