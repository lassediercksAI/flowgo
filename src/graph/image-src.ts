// Client-side mirror of pkg/graph's imageSrcProblem (validate.go): the
// same rules, enforced again at the one point that matters most for
// THIS repo's own users — the DOM assignment that hands img.src an
// Image.src straight from a parsed .flowgo document (render.ts's
// materializeImage, inline.ts's renderFlowgo).
//
// Why duplicate a Go check in TypeScript instead of relying on the
// server-side validator alone: a .flowgo file opened locally (via the
// CLI, VS Code, Obsidian, a `file://` open of the inline embed) never
// goes through any server. Someone hands you a crafted map — an email
// attachment, a repo you cloned, a link to someone else's export — and
// the editor parses and renders it before any server ever sees the
// bytes. This is the last line of defense for exactly that path.
//
// Browsers do not currently execute a javascript: URL or a scripted
// SVG assigned to img.src — but that is a property of today's <img>
// rendering path, not a guarantee this module should lean on. A src
// field has no legitimate reason to carry a scheme that runs code
// instead of painting a picture, so it is rejected here regardless of
// which specific DOM sink happens to be safe this year.

// Accepted data: URI prefixes — base64-encoded raster types, matching
// what the CLI's /media upload endpoint accepts server-side
// (mediaExtByType in cmd/flowgo/main.go). image/svg+xml is
// deliberately excluded: an SVG data URI is an active document, not a
// picture.
const SAFE_DATA_URI_PREFIXES = [
  "data:image/png;base64,",
  "data:image/jpeg;base64,",
  "data:image/jpg;base64,",
  "data:image/gif;base64,",
  "data:image/webp;base64,",
];

// A URI scheme per RFC 3986: a letter, then letters/digits/+/-/.,
// then ":". Matches only the scheme prefix, case-insensitively.
const SCHEME_RE = /^([a-z][a-z0-9+.-]*):/i;

// isSafeImageSrc reports whether `src` is safe to assign to an
// HTMLImageElement's .src: a relative path (no "..", not absolute), a
// protocol-relative or http(s) URL, or a data: URI of an accepted
// raster type. Everything else — javascript:, vbscript:, file:, a
// non-raster or malformed data: URI — is rejected.
export const isSafeImageSrc = (src: string): boolean => {
  if (!src) return false;
  if (src.startsWith("//")) return true; // protocol-relative URL
  const m = SCHEME_RE.exec(src);
  if (m && m[1]) {
    const scheme = m[1].toLowerCase();
    if (scheme === "http" || scheme === "https") return true;
    if (scheme === "data") {
      const lower = src.toLowerCase();
      return SAFE_DATA_URI_PREFIXES.some((p) => lower.startsWith(p));
    }
    return false; // javascript:, vbscript:, file:, blob:, anything else
  }
  // No scheme: must be a path relative to the .flowgo file.
  if (src.includes("..")) return false;
  if (src.startsWith("/") || src.startsWith("\\")) return false;
  if (/^[a-z]:/i.test(src)) return false; // Windows drive-letter path
  return true;
};
