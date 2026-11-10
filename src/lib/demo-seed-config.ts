import { z } from "zod";

/**
 * The checks `scripts/seed-demo.mts` runs before it imports any database or auth code. The demo seed
 * deletes and recreates demo users' rows, so it must never run against a production origin or database.
 * Call it first, including for CLI refusals. Add your own production hosts to the lists below.
 */
const PRODUCTION_APP_HOSTS = [
  "breakthruventures.ai", // every app's production origin, e.g. app4.breakthruventures.ai
  "sslip.io", // preview URLs of the Oracle VM
  "azurecontainerapps.io", // Azure
  "run.app", // Google Cloud Run
  "on.aws", // AWS Lambda function URLs
  "amazonaws.com", // AWS API Gateway and friends
];

const PRODUCTION_DB_HOST_SUFFIXES = [
  ".postgres.database.azure.com", // Azure Database for PostgreSQL
  ".rds.amazonaws.com", // AWS RDS and Aurora
];

export function demoSeedConfig(values: Record<string, string | undefined> = process.env) {
  if (values.DEMO_SEED !== "yes") throw new Error("Demo seed refused: set DEMO_SEED=yes.");
  const parsedUrl = z.string().url().safeParse(values.APP_URL);
  if (!parsedUrl.success) throw new Error("Demo seed refused: set APP_URL to a valid URL.");
  const appUrl = parsedUrl.data;
  const hostname = normalizeHost(new URL(appUrl).hostname);
  if (PRODUCTION_APP_HOSTS.some((h) => hostname === h || hostname.endsWith(`.${h}`))) {
    throw new Error("Demo seed refused: APP_URL is a production host.");
  }
  // Cloud SQL sockets (`?host=/cloudsql/project:region:instance`) are the Google Cloud production database.
  if (values.DATABASE_URL && /(\/|%2f)cloudsql(\/|%2f)/i.test(values.DATABASE_URL)) {
    throw new Error("Demo seed refused: DATABASE_URL is a production database host.");
  }
  // A URL we can't read is a URL we can't vet: an unencoded # or / in the password, a multi-host list, a typo.
  const dbHost = databaseHost(values.DATABASE_URL);
  if (values.DATABASE_URL && !dbHost) {
    throw new Error("Demo seed refused: DATABASE_URL can't be parsed to a single host (percent-encode special characters in the password).");
  }
  // "postgres" is the compose service name on the Oracle VM, i.e. the production database.
  if (dbHost === "postgres" || (dbHost && PRODUCTION_DB_HOST_SUFFIXES.some((s) => dbHost.endsWith(s)))) {
    throw new Error("Demo seed refused: DATABASE_URL is a production database host.");
  }
  const password = z.string().min(10).max(128).parse(values.DEMO_PASSWORD);
  return { appUrl, password };
}

const normalizeHost = (h: string) => h.toLowerCase().replace(/\.+$/, "");

function databaseHost(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const host = normalizeHost(new URL(url).hostname);
    return host && !host.includes(",") ? host : undefined; // an empty or multi-host value can't be vetted
  } catch {
    return undefined;
  }
}
