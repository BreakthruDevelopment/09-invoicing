import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { isPublicIp } from "@/lib/ip-guard";

/**
 * SSRF-safe GET for user-supplied URLs (link savers, webhooks, health pollers).
 *
 * Checking a hostname and then fetching it is not safe: DNS can answer differently the second time (rebinding).
 * So the check lives in the socket's own `lookup`: every address the connection could use is resolved there and
 * `isPublicIp` must pass for ALL of them, so the address checked is the address connected to. Also:
 * - http(s) only, ports 80/443 only (override with `allowedPorts`), no credentials in the URL;
 * - IP-literal hosts never reach `lookup`, so they are checked up front;
 * - redirects are followed by hand (max `maxRedirects`), and every hop goes through the same checks;
 * - the body is capped at `maxBytes` (Content-Length is checked first, then the stream is counted);
 * - one deadline, `timeoutMs`, covers every hop and the whole body.
 * No cookies or authorization are ever sent, and no proxy is used. Self-contained apart from `ip-guard.ts`.
 * Errors carry a fixed message and a `code` only, never the URL or any response content.
 */
export type SafeFetchCode = "bad_url" | "blocked" | "too_large" | "timeout" | "too_many_redirects" | "network";

export class SafeFetchError extends Error {
  constructor(readonly code: SafeFetchCode) {
    super(`safeFetch failed: ${code}`);
    this.name = "SafeFetchError";
  }
}

export type SafeFetchOptions = {
  maxBytes?: number;
  timeoutMs?: number;
  maxRedirects?: number;
  allowedPorts?: number[];
  headers?: Record<string, string>;
};

export type SafeFetchResult = { status: number; url: string; headers: Record<string, string>; body: Buffer };

type Resolve = (hostname: string) => Promise<{ address: string; family: number }[]>;
export type Deps = { resolve?: Resolve; isPublic?: (address: string) => boolean };

const REDIRECTS = new Set([301, 302, 303, 307, 308]);

/** Build a fetcher. Tests inject `resolve`/`isPublic`; production code uses the exported `safeFetch`. */
export function createSafeFetch(deps: Deps = {}) {
  const isPublic = deps.isPublic ?? isPublicIp;
  const resolve: Resolve = deps.resolve ?? ((host) => dns.promises.lookup(host, { all: true, verbatim: true }));

  const lookup: LookupFunction = (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (addresses.length === 0 || !addresses.every((a) => isPublic(a.address))) {
          callback(new SafeFetchError("blocked") as unknown as NodeJS.ErrnoException, "", 0);
          return;
        }
        if (options.all) (callback as unknown as (e: null, a: typeof addresses) => void)(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      (err: unknown) => callback(err as NodeJS.ErrnoException, "", 0),
    );
  };

  function hop(url: URL, headers: Record<string, string>, maxBytes: number, deadline: number) {
    return new Promise<{ status: number; headers: Record<string, string>; body: Buffer }>((resolveHop, reject) => {
      const lib = url.protocol === "https:" ? https : http;
      let finished = false;
      const done = (fn: () => void) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        fn();
      };
      const req = lib.request(
        url,
        { method: "GET", headers: { "user-agent": "30-apps-safe-fetch", accept: "*/*", ...headers }, lookup, agent: false },
        (res) => {
          const status = res.statusCode ?? 0;
          const out: Record<string, string> = {};
          for (const [k, v] of Object.entries(res.headers)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(", ") : v;
          const declared = Number(out["content-length"]);
          if (!REDIRECTS.has(status) && Number.isFinite(declared) && declared > maxBytes) {
            req.destroy();
            return done(() => reject(new SafeFetchError("too_large")));
          }
          const chunks: Buffer[] = [];
          let total = 0;
          res.on("data", (chunk: Buffer) => {
            if (REDIRECTS.has(status)) return; // redirect bodies are discarded
            total += chunk.length;
            if (total > maxBytes) {
              req.destroy();
              return done(() => reject(new SafeFetchError("too_large")));
            }
            chunks.push(chunk);
          });
          res.on("end", () => done(() => resolveHop({ status, headers: out, body: Buffer.concat(chunks) })));
          res.on("error", () => done(() => reject(new SafeFetchError("network"))));
          res.on("aborted", () => done(() => reject(new SafeFetchError("network"))));
        },
      );
      const timer = setTimeout(() => {
        req.destroy();
        done(() => reject(new SafeFetchError("timeout")));
      }, Math.max(1, deadline - Date.now()));
      req.on("error", (err) => done(() => reject(err instanceof SafeFetchError ? err : new SafeFetchError("network"))));
      req.end();
    });
  }

  return async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResult> {
    const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
    const maxRedirects = opts.maxRedirects ?? 3;
    const ports = opts.allowedPorts ?? [80, 443];
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);

    let url = parse(input);
    for (let redirects = 0; ; redirects++) {
      vet(url, ports, isPublic);
      const res = await hop(url, opts.headers ?? {}, maxBytes, deadline);
      const location = res.headers.location;
      if (!REDIRECTS.has(res.status) || !location) return { ...res, url: url.toString() };
      if (redirects >= maxRedirects) throw new SafeFetchError("too_many_redirects");
      url = parse(location, url); // relative locations resolve against the current URL; the next loop vets it
    }
  };
}

function parse(input: string, base?: URL): URL {
  try {
    return new URL(input, base);
  } catch {
    throw new SafeFetchError("bad_url");
  }
}

function vet(url: URL, ports: number[], isPublic: (address: string) => boolean): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("bad_url");
  if (url.username || url.password) throw new SafeFetchError("bad_url");
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!ports.includes(port)) throw new SafeFetchError("blocked");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host) throw new SafeFetchError("bad_url");
  // IP literals skip `lookup`, so vet them here. (WHATWG URL already turns 2130706433 or 0x7f.1 into 127.0.0.1.)
  if (isIP(host) && !isPublic(host)) throw new SafeFetchError("blocked");
}

export const safeFetch = createSafeFetch();
