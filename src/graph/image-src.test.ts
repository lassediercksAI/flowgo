import { describe, expect, it } from "vitest";
import { isSafeImageSrc } from "./image-src";

describe("isSafeImageSrc", () => {
  it("accepts the legitimate shapes an image src takes", () => {
    expect(isSafeImageSrc("flowgo-media/abc123.png")).toBe(true);
    expect(isSafeImageSrc("/flowgo-media/abc123.png")).toBe(true);
    expect(isSafeImageSrc("https://example.com/pic.png")).toBe(true);
    expect(isSafeImageSrc("http://example.com/pic.png")).toBe(true);
    expect(isSafeImageSrc("//example.com/pic.png")).toBe(true);
    expect(isSafeImageSrc("")).toBe(true);
  });

  it("rejects javascript: URLs", () => {
    expect(isSafeImageSrc("javascript:alert(document.cookie)")).toBe(false);
    expect(isSafeImageSrc("JAVASCRIPT:alert(1)")).toBe(false);
    expect(isSafeImageSrc("  javascript:alert(1)")).toBe(false);
  });

  it("rejects javascript: URLs smuggled past naive checks with embedded tabs/newlines", () => {
    expect(isSafeImageSrc("java\tscript:alert(1)")).toBe(false);
    expect(isSafeImageSrc("java\nscript:alert(1)")).toBe(false);
    expect(isSafeImageSrc("\tjavascript:alert(1)")).toBe(false);
    expect(isSafeImageSrc("j\r\navascript:alert(1)")).toBe(false);
  });

  it("rejects data:image/svg+xml, even though svg is nominally an image MIME type", () => {
    expect(
      isSafeImageSrc(
        "data:image/svg+xml;base64," +
          Buffer.from("<svg onload=alert(1)></svg>").toString("base64"),
      ),
    ).toBe(false);
    expect(isSafeImageSrc("data:image/svg+xml,<svg onload=alert(1)></svg>")).toBe(
      false,
    );
  });

  it("rejects data: URLs with a non-raster-image or missing MIME type", () => {
    expect(isSafeImageSrc("data:text/html,<script>alert(1)</script>")).toBe(
      false,
    );
    expect(isSafeImageSrc("data:,plain text sneaks in as text/plain")).toBe(
      false,
    );
    expect(isSafeImageSrc("data:application/octet-stream;base64,AAAA")).toBe(
      false,
    );
  });

  it("accepts data: URLs with a safe raster image MIME type — an intentional feature of the read-only embed", () => {
    expect(isSafeImageSrc("data:image/png;base64,AAAA")).toBe(true);
    expect(isSafeImageSrc("data:image/jpeg;base64,AAAA")).toBe(true);
    expect(isSafeImageSrc("data:image/gif;base64,AAAA")).toBe(true);
    expect(isSafeImageSrc("data:image/webp;base64,AAAA")).toBe(true);
  });

  it("treats missing/empty src as safe (nothing to load)", () => {
    expect(isSafeImageSrc(undefined)).toBe(true);
    expect(isSafeImageSrc(null)).toBe(true);
    expect(isSafeImageSrc("")).toBe(true);
  });

  it("rejects vbscript: URLs", () => {
    expect(isSafeImageSrc("vbscript:msgbox(1)")).toBe(false);
  });

  it("does not false-positive on paths merely containing the word javascript", () => {
    expect(isSafeImageSrc("flowgo-media/javascript-logo.png")).toBe(true);
    expect(isSafeImageSrc("https://example.com/javascript:tutorial.png")).toBe(
      true,
    );
  });
});
