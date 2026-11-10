import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createSafeFetch, safeFetch, SafeFetchError } from "@/lib/safe-fetch";

const code = (p: Promise<unknown>) => p.then(() => "ok", (e: unknown) => (e instanceof SafeFetchError ? e.code : `other:${String(e)}`));

describe("safeFetch (real guard, no network needed)", () => {
  it.each([
    "http://127.0.0.1/",
    "http://127.0.0.1:80/",
    "http://[::1]/",
    "http://10.0.0.5/",
    "http://169.254.169.254/latest/meta-data/",
    "http://168.63.129.16/",
    "http://2130706433/", // decimal loopback
    "http://0x7f.1/", // hex loopback
    "http://[::ffff:127.0.0.1]/",
    "https://[fd00::1]/",
  ])("refuses the literal %s before connecting", async (url) => {
    expect(await code(safeFetch(url))).toBe("blocked");
  });

  it("refuses a hostname that resolves to loopback", async () => {
    expect(await code(safeFetch("http://localhost/"))).toBe("blocked");
  });

  it.each(["ftp://example.com/", "file:///etc/passwd", "not a url", "http://user:pw@example.com/", "http:///"])("rejects %s", async (url) => {
    expect(await code(safeFetch(url))).toBe("bad_url");
  });

  it("refuses ports other than 80 and 443", async () => {
    expect(await code(safeFetch("http://93.184.216.34:6379/"))).toBe("blocked");
  });
});

describe("safeFetch (guard against a local server)", () => {
  let server: http.Server;
  let base: string;
  const hits: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url ?? "");
      const url = req.url ?? "";
      if (url === "/ok") return void res.end("hello");
      if (url === "/big") return void res.end("x".repeat(5000));
      if (url === "/big-stream") {
        res.write("x".repeat(3000));
        return void res.write("y".repeat(3000)); // never ends, and has no Content-Length
      }
      if (url === "/hang") return;
      if (url === "/r1") return void res.writeHead(302, { location: "/r2" }).end();
      if (url === "/r2") return void res.writeHead(302, { location: "/ok" }).end();
      if (url === "/loop") return void res.writeHead(302, { location: "/loop" }).end();
      if (url === "/to-private") return void res.writeHead(302, { location: "http://10.1.2.3/secret" }).end();
      if (url === "/to-meta-host") return void res.writeHead(302, { location: "http://meta.test/" }).end();
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    base = `http://public.test:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server.close());

  // "public.test" resolves to the local server; "meta.test" resolves to a private address. Only 127.0.0.1 counts as public here.
  const fetcher = createSafeFetch({
    resolve: async (host) => (host === "meta.test" ? [{ address: "10.9.9.9", family: 4 }] : [{ address: "127.0.0.1", family: 4 }]),
    isPublic: (a) => a === "127.0.0.1",
  });
  const opts = () => ({ allowedPorts: [Number(new URL(base).port)] });

  it("returns status, headers and body", async () => {
    const res = await fetcher(`${base}/ok`, opts());
    expect(res.status).toBe(200);
    expect(res.body.toString()).toBe("hello");
    expect(res.url).toBe(`${base}/ok`);
  });

  it("follows redirects by hand up to the limit", async () => {
    expect((await fetcher(`${base}/r1`, opts())).body.toString()).toBe("hello");
    expect(await code(fetcher(`${base}/loop`, { ...opts(), maxRedirects: 3 }))).toBe("too_many_redirects");
  });

  it("re-checks every hop: a redirect to a private literal or to a host that resolves privately is refused", async () => {
    expect(await code(fetcher(`${base}/to-private`, { ...opts(), allowedPorts: [80, Number(new URL(base).port)] }))).toBe("blocked");
    expect(hits).not.toContain("/secret");
    expect(await code(fetcher(`${base}/to-meta-host`, { ...opts(), allowedPorts: [80, Number(new URL(base).port)] }))).toBe("blocked");
  });

  it("refuses a name that resolves to a private address, and one with a mix of public and private answers", async () => {
    expect(await code(createSafeFetch({ resolve: async () => [{ address: "10.0.0.1", family: 4 }] })("http://rebind.test/"))).toBe("blocked");
    const mixed = createSafeFetch({ resolve: async () => [{ address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 }] });
    expect(await code(mixed("http://mixed.test/"))).toBe("blocked");
  });

  it("caps the body, by Content-Length and by counting a stream", async () => {
    expect(await code(fetcher(`${base}/big`, { ...opts(), maxBytes: 1000 }))).toBe("too_large");
    expect(await code(fetcher(`${base}/big-stream`, { ...opts(), maxBytes: 4000 }))).toBe("too_large");
    expect((await fetcher(`${base}/big`, { ...opts(), maxBytes: 5000 })).body.length).toBe(5000);
  });

  it("times out on a server that never answers", async () => {
    expect(await code(fetcher(`${base}/hang`, { ...opts(), timeoutMs: 200 }))).toBe("timeout");
  });

  it("errors never contain the URL", async () => {
    const err = await fetcher(`${base}/big?token=secret-canary`, { ...opts(), maxBytes: 10 }).catch((e: Error) => e);
    expect(String((err as Error).message)).not.toContain("secret-canary");
  });
});
