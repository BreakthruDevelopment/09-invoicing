/**
 * Nobody can sign up as a demo identity or turn an account into one, on any Better Auth write path
 * (sign-up, /update-user, /admin/create-user, /admin/update-user), while code that writes rows
 * directly with Drizzle (the demo loader) is unaffected.
 */
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.TEST_DATABASE_URL;
const PASSWORD = "correct-horse-battery";
const MARKER = "urn:breakthru:demo:v1";
const OTHER_APP_MARKER = "urn:breakthru:some-other-app-demo:v1";

describe.skipIf(!url)("demo identity hooks (Better Auth + Postgres)", () => {
  let sql: postgres.Sql;
  let handler: (req: Request) => Promise<Response>;
  let userCookie: string;
  let adminCookie: string;
  let targetId: string;

  const call = (path: string, body: unknown, cookie?: string) =>
    handler(
      new Request(`http://localhost:3000/api/auth${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
        body: JSON.stringify(body),
      }),
    );

  const cookieOf = (res: Response) =>
    res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const cleanup = () =>
    sql`delete from "user" where email like 'di-%@test.local' or email like 'di-%@demo.breakthru.test'`;
  const count = async (like: string) => {
    const [{ n }] = await sql`select count(*)::int as n from "user" where email ilike ${like}`;
    return n as number;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    process.env.BETTER_AUTH_SECRET ??= "x".repeat(32);
    process.env.APP_URL = "http://localhost:3000";
    sql = postgres(url!, { max: 1, onnotice: () => {} });
    await cleanup();
    const { auth } = await import("@/lib/auth");
    handler = auth().handler;

    const plain = await call("/sign-up/email", { name: "Plain", email: "di-plain@test.local", password: PASSWORD });
    expect(plain.status).toBe(200);
    userCookie = cookieOf(plain);

    const adm = await call("/sign-up/email", { name: "Adm", email: "di-admin@test.local", password: PASSWORD });
    expect(adm.status).toBe(200);
    await sql`update "user" set role = 'admin' where email = 'di-admin@test.local'`;
    adminCookie = cookieOf(await call("/sign-in/email", { email: "di-admin@test.local", password: PASSWORD }));

    const target = await call("/sign-up/email", { name: "Target", email: "di-target@test.local", password: PASSWORD });
    targetId = ((await target.json()) as { user: { id: string } }).user.id;
  });

  afterAll(async () => {
    await cleanup();
    await sql.end();
  });

  const imageOf = async (email: string) => (await sql`select image from "user" where email = ${email}`)[0]?.image;

  it("refuses public sign-up with a demo email, in any case, and creates no user", async () => {
    for (const email of ["di-a@demo.breakthru.test", "DI-B@Demo.Breakthru.Test"]) {
      const res = await call("/sign-up/email", { name: "Fake", email, password: PASSWORD });
      expect(res.status).toBe(400);
    }
    expect(await count("di-%@demo.breakthru.test")).toBe(0);
  });

  it("refuses sign-up that carries a urn:breakthru: image, this app's or another's", async () => {
    for (const [i, image] of [MARKER, OTHER_APP_MARKER].entries()) {
      const email = `di-marker${i}@test.local`;
      const res = await call("/sign-up/email", { name: "Fake", email, password: PASSWORD, image });
      expect(res.status).toBe(400);
      expect(await count(email)).toBe(0);
    }
  });

  it("allows an ordinary sign-up with a normal image", async () => {
    const res = await call("/sign-up/email", {
      name: "Fine", email: "di-fine@test.local", password: PASSWORD, image: "https://example.test/a.png",
    });
    expect(res.status).toBe(200);
  });

  it("refuses /update-user setting the marker or a demo email, and leaves the row alone", async () => {
    expect((await call("/update-user", { image: MARKER }, userCookie)).status).toBe(400);
    expect((await call("/update-user", { image: OTHER_APP_MARKER }, userCookie)).status).toBe(400);
    expect(await imageOf("di-plain@test.local")).not.toBe(MARKER);
    // Ordinary updates still work.
    expect((await call("/update-user", { name: "Plain Two" }, userCookie)).status).toBe(200);
  });

  it("refuses /admin/create-user with a demo email or marker image, and allows an ordinary user", async () => {
    const make = (email: string, extra: object = {}) =>
      call("/admin/create-user", { name: "Made", email, password: PASSWORD, role: "user", ...extra }, adminCookie);
    expect((await make("di-c1@demo.breakthru.test")).status).toBe(400);
    expect((await make("di-c2@test.local", { data: { image: MARKER } })).status).toBe(400);
    expect(await count("di-c1@demo.breakthru.test")).toBe(0);
    expect(await count("di-c2@test.local")).toBe(0);
    expect((await make("di-c3@test.local")).status).toBe(200);
  });

  it("refuses /admin/update-user setting a demo email or marker image", async () => {
    const upd = (data: object) => call("/admin/update-user", { userId: targetId, data }, adminCookie);
    // Admins lack the `set-email` permission (permissions.ts), so an email change is refused even earlier (403).
    expect([400, 403]).toContain((await upd({ email: "di-t@demo.breakthru.test" })).status);
    expect((await upd({ image: MARKER })).status).toBe(400);
    expect(await imageOf("di-target@test.local")).not.toBe(MARKER);
    expect(await count("di-t@demo.breakthru.test")).toBe(0);
    expect((await upd({ name: "Target Two" })).status).toBe(200);
  });

  it("does not affect direct Drizzle-style writes, which is how the demo loader works", async () => {
    await sql`insert into "user" (id, name, email, email_verified, image)
      values ('di-loader', 'Demo', 'di-loader@demo.breakthru.test', true, ${MARKER})`;
    expect(await count("di-loader@demo.breakthru.test")).toBe(1);
    // A second insert of the same email is the 23505 the loader must map to 409.
    await expect(
      sql`insert into "user" (id, name, email, email_verified) values ('di-loader2', 'Demo', 'di-loader@demo.breakthru.test', true)`,
    ).rejects.toMatchObject({ code: "23505" });
  });
});
