import "server-only";
import { asc, count, eq, isNull } from "drizzle-orm";
import { type Actor, assertCan } from "@/lib/auth/rbac";
import { db, schema } from "@/lib/db";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { parseId, writeTx } from "@/lib/invoice-common";
import { MAX_CLIENTS_PER_USER, clientInput, clientPatch } from "@/lib/invoice-schemas";
import { ownedBy } from "@/lib/owned";

const { client } = schema;

export type ClientView = typeof client.$inferSelect;

export async function listClients(actor: Actor, opts: { includeArchived?: boolean } = {}): Promise<ClientView[]> {
  assertCan(actor, "create");
  return db()
    .select()
    .from(client)
    .where(ownedBy(client, actor, opts.includeArchived ? undefined : isNull(client.archivedAt)))
    .orderBy(asc(client.name), asc(client.id))
    .limit(MAX_CLIENTS_PER_USER + 50);
}

export async function getClient(actor: Actor, id: string): Promise<ClientView> {
  const clientId = parseId(id, "Client");
  const [row] = await db().select().from(client).where(ownedBy(client, actor, eq(client.id, clientId)));
  if (!row) throw new NotFoundError("Client not found");
  assertCan(actor, "read", row);
  return row;
}

export async function createClient(actor: Actor, raw: unknown): Promise<ClientView> {
  assertCan(actor, "create");
  const input = clientInput.parse(raw);
  return writeTx(actor, async (tx) => {
    const [{ n }] = await tx.select({ n: count() }).from(client).where(ownedBy(client, actor, isNull(client.archivedAt)));
    if (n >= MAX_CLIENTS_PER_USER) throw new ConflictError(`You can have up to ${MAX_CLIENTS_PER_USER} clients. Archive one first.`);
    const [row] = await tx.insert(client).values({ ...input, ownerId: actor.id }).returning();
    return row;
  });
}

export async function updateClient(actor: Actor, id: string, raw: unknown): Promise<ClientView> {
  const clientId = parseId(id, "Client");
  const input = clientPatch.parse(raw);
  return writeTx(actor, async (tx) => {
    const [row] = await tx
      .update(client)
      .set({ ...input, updatedAt: new Date() })
      .where(ownedBy(client, actor, eq(client.id, clientId), isNull(client.archivedAt)))
      .returning();
    if (!row) throw new NotFoundError("Client not found");
    return row;
  });
}

/** Delete = archive: the client's invoices keep pointing at it. Archiving twice is a 404 the second time. */
export async function archiveClient(actor: Actor, id: string): Promise<void> {
  const clientId = parseId(id, "Client");
  await writeTx(actor, async (tx) => {
    const rows = await tx
      .update(client)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(ownedBy(client, actor, eq(client.id, clientId), isNull(client.archivedAt)))
      .returning({ id: client.id });
    if (rows.length === 0) throw new NotFoundError("Client not found");
  });
}
