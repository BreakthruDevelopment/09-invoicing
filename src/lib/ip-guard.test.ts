import { describe, expect, it } from "vitest";
import { isPublicIp } from "@/lib/ip-guard";

describe("isPublicIp", () => {
  it.each(["8.8.8.8", "1.1.1.1", "93.184.216.34", "168.63.129.15", "168.63.129.17", "192.88.98.1", "192.88.100.1", "172.15.0.1", "172.32.0.1", "100.63.255.255", "100.128.0.1", "169.253.1.1", "52.1.2.3"])(
    "allows public v4 %s",
    (ip) => expect(isPublicIp(ip)).toBe(true),
  );

  it.each([
    "0.0.0.0", "127.0.0.1", "127.255.255.254", "10.0.0.1", "10.255.255.255", "172.16.0.1", "172.31.255.255",
    "192.168.1.1", "169.254.169.254", "100.64.0.1", "100.127.255.255", "192.0.2.1", "168.63.129.16", "192.88.99.1", "192.88.99.0", "198.18.0.1", "224.0.0.1", "255.255.255.255",
  ])("refuses private/reserved v4 %s", (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each(["2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "2001:4860:4860::8888", "2001:3::1", "2001:30::1", "3fff:1000::1", "2001:4::1"])("allows public v6 %s", (ip) =>
    expect(isPublicIp(ip)).toBe(true),
  );

  it.each([
    "::", "::1", "fe80::1", "fe80::1%eth0", "febf::1", "fc00::1", "fd12:3456:789a::1", "ff02::1",
    "2001:db8::1", "2001:2::1", "2001:10::1", "2001:1f::1", "2001:20::1", "2001:2f::1", "3fff::1", "3fff:fff:ffff::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2", "64:ff9b::7f00:1", "0:0:0:0:0:0:0:1",
  ])("refuses private/reserved v6 %s", (ip) => expect(isPublicIp(ip)).toBe(false));

  it.each(["::ffff:127.0.0.1", "::ffff:7f00:1", "::ffff:10.0.0.1", "::ffff:a9fe:a9fe", "::ffff:192.168.0.1", "0:0:0:0:0:ffff:100.64.0.1", "2002:7f00:1::1", "2002:a9fe:a9fe::"])(
    "refuses v4-mapped or embedded private %s",
    (ip) => expect(isPublicIp(ip)).toBe(false),
  );

  it("allows a v4-mapped public address", () => {
    expect(isPublicIp("::ffff:8.8.8.8")).toBe(true);
    expect(isPublicIp("::ffff:808:808")).toBe(true);
  });

  it.each(["", "not-an-ip", "999.1.1.1", "1.2.3", "1::2::3", "::ffff:999.1.1.1"])("refuses garbage %j", (ip) =>
    expect(isPublicIp(ip)).toBe(false),
  );
});
