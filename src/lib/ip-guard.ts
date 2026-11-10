import { isIP } from "node:net";

/**
 * SSRF guard for the health poller: true only for globally routable addresses.
 * Refuses loopback, RFC1918, link-local, CGNAT, ULA, unspecified, multicast, documentation and
 * other reserved ranges for IPv4 and IPv6, including IPv4-mapped IPv6. Anything unparseable is refused.
 */
export function isPublicIp(address: string): boolean {
  const ip = address.split("%")[0]; // drop any IPv6 zone id
  const kind = isIP(ip);
  if (kind === 4) return isPublicV4(ip.split(".").map(Number));
  if (kind === 6) {
    const groups = parseV6(ip);
    return groups ? isPublicV6(groups) : false;
  }
  return false;
}

function isPublicV4([a, b, c, d]: number[]): boolean {
  if (a === 0) return false; // 0.0.0.0/8 unspecified / "this network"
  if (a === 10) return false; // RFC1918
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT 100.64/10
  if (a === 127) return false; // loopback
  if (a === 168 && b === 63 && c === 129 && d === 16) return false; // Azure wireserver / host services
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false; // RFC1918
  if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
  if (a === 192 && b === 0 && c === 2) return false; // TEST-NET-1
  if (a === 192 && b === 88 && c === 99) return false; // 6to4 relay anycast (deprecated)
  if (a === 192 && b === 168) return false; // RFC1918
  if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
  if (a === 198 && b === 51 && c === 100) return false; // TEST-NET-2
  if (a === 203 && b === 0 && c === 113) return false; // TEST-NET-3
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

/** Expand any valid IPv6 text form into eight 16-bit groups. */
function parseV6(ip: string): number[] | null {
  let text = ip;
  // An embedded dotted IPv4 tail becomes two hex groups.
  const dot = text.lastIndexOf(".");
  if (dot !== -1) {
    const colon = text.lastIndexOf(":");
    const v4 = text.slice(colon + 1).split(".").map(Number);
    if (v4.length !== 4 || v4.some((x) => !Number.isInteger(x) || x < 0 || x > 255)) return null;
    text = text.slice(0, colon + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ":" + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const parts = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  const groups = parts.map((p) => (/^[0-9a-fA-F]{1,4}$/.test(p) ? parseInt(p, 16) : NaN));
  return groups.length === 8 && groups.every((g) => !Number.isNaN(g)) ? groups : null;
}

function isPublicV6(g: number[]): boolean {
  const v4From = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];
  // IPv4-mapped (::ffff:a.b.c.d): judge by the embedded IPv4 address.
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return isPublicV4(v4From(g[6], g[7]));
  // Only global unicast 2000::/3 can be public; this drops ::, ::1, fc00::/7, fe80::/10, ff00::/8, 64:ff9b::/96 and the rest.
  if ((g[0] & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1] === 0x0db8) return false; // documentation
  if (g[0] === 0x2001 && g[1] === 0) return false; // Teredo
  if (g[0] === 0x2001 && g[1] === 2 && g[2] === 0) return false; // 2001:2::/48 benchmarking
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x10) return false; // 2001:10::/28 ORCHID (deprecated)
  if (g[0] === 0x2001 && (g[1] & 0xfff0) === 0x20) return false; // 2001:20::/28 ORCHIDv2
  if (g[0] === 0x3fff && (g[1] & 0xf000) === 0) return false; // 3fff::/20 documentation
  if (g[0] === 0x2002) return isPublicV4(v4From(g[1], g[2])); // 6to4 embeds an IPv4 address
  return true;
}
