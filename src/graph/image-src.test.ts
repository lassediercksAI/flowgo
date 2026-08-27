import { describe, expect, it } from "vitest";
import { isSafeImageSrc } from "./image-src";

describe("isSafeImageSrc", () => {
  it("accepts a relative content-addressed upload path", () => {
    expect(isSafeImageSrc("flowgo-media/abc123def4567890.png")).toBe(true);
  });

  it("accepts a protocol-relative URL", () => {
    expect(isSafeImageSrc("//example.com/icon.png")).toBe(true);
  });

  it("accepts http and https URLs", () => {
    expect(isSafeImageSrc("http://example.com/icon.png")).toBe(true);
    expect(isSafeImageSrc("https://example.com/icon.png")).toBe(true);
  });

  it("accepts base64 data: URIs of every type upload accepts", () => {
    expect(isSafeImageSrc("data:image/png;base64,aGVsbG8=")).toBe(true);
    expect(isSafeImageSrc("data:image/jpeg;base64,aGVsbG8=")).toBe(true);
    expect(isSafeImageSrc("data:image/jpg;base64,aGVsbG8=")).toBe(true);
    expect(isSafeImageSrc("data:image/gif;base64,aGVsbG8=")).toBe(true);
    expect(isSafeImageSrc("data:image/webp;base64,aGVsbG8=")).toBe(true);
  });

  it("rejects a javascript: URL", () => {
    expect(isSafeImageSrc("javascript:alert(document.cookie)")).toBe(false);
  });

  it("rejects a vbscript: URL", () => {
    expect(isSafeImageSrc("vbscript:msgbox(1)")).toBe(false);
  });

  it("rejects a file: URL", () => {
    expect(isSafeImageSrc("file:///etc/passwd")).toBe(false);
  });

  it("rejects a data: URI carrying inline SVG", () => {
    expect(
      isSafeImageSrc("data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9ImFsZXJ0KDEpIi8+"),
    ).toBe(false);
  });

  it("rejects a data: URI with a non-image MIME type", () => {
    expect(
      isSafeImageSrc("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="),
    ).toBe(false);
  });

  it("rejects an unencoded (non-base64) data: URI", () => {
    expect(isSafeImageSrc("data:image/png,<svg onload=alert(1)>")).toBe(false);
  });

  it("rejects path traversal in a relative src", () => {
    expect(isSafeImageSrc("../../../../etc/passwd")).toBe(false);
    expect(isSafeImageSrc("flowgo-media/../../secret.png")).toBe(false);
  });

  it("rejects an absolute filesystem path", () => {
    expect(isSafeImageSrc("/etc/passwd")).toBe(false);
    expect(isSafeImageSrc("\\\\evilshare\\payload.png")).toBe(false);
  });

  it("rejects a Windows drive-letter path", () => {
    expect(isSafeImageSrc("C:\\Windows\\System32\\evil.png")).toBe(false);
  });

  it("rejects an empty src", () => {
    expect(isSafeImageSrc("")).toBe(false);
  });
});
