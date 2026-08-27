// Defense-in-depth scheme check for image `src` values before they are
// ever assigned to an `<img>` element's `.src` property.
//
// The primary defense against a malicious `image` directive lives on
// the server (flowgo-website validates uploads and rejects dangerous
// schemes before a .flowgo file can reference them). This check exists
// because a .flowgo file can also be opened *locally* — dragged into
// the CLI-served editor, loaded from disk, or handed to the read-only
// inline embed by a host page — bypassing server-side validation
// entirely. A hand-crafted file could carry
// `image evil javascript:alert(document.cookie) 0 0 10 10` and, absent
// this check, the renderer would happily set `img.src` to it.
//
// `javascript:`/`vbscript:` are always rejected — they execute
// arbitrary script the instant the browser tries to "load" the image.
//
// `data:` URIs are allowed only for a narrow allowlist of raster image
// MIME types. Plain raster data (PNG/JPEG/GIF/WebP/...) is inert — the
// browser only ever decodes pixels from it — and the inline embed
// (src/render/inline.ts) intentionally supports `data:` image src so a
// map can be fully self-contained with no network fetch at all. But
// `data:image/svg+xml` is NOT inert: SVG can carry a `<script>` or
// `onload` handler that executes in the embedding page's origin, so
// it's excluded even though it's nominally an "image" MIME type. Any
// other data: MIME type (text/html, application/*, unlabeled, ...) is
// rejected too.
//
// http(s) and relative/content-addressed paths are left untouched —
// remote image embedding and the upload flow are legitimate existing
// features handled by resolveImageSrc / the server.

const DANGEROUS_SCHEME = /^[\x00-\x20]*(javascript|vbscript):/i;
const DATA_URL_MIME = /^[\x00-\x20]*data:\s*([^;,]*)/i;

// Raster formats a browser only ever decodes to pixels — never
// executes as markup/script. Deliberately excludes svg+xml.
const SAFE_DATA_IMAGE_MIME =
  /^image\/(png|jpe?g|gif|webp|avif|bmp|x-icon|vnd\.microsoft\.icon)$/i;

// True if `src` is safe to assign to an <img>.src.
export const isSafeImageSrc = (src: string | null | undefined): boolean => {
  if (!src) return true;
  // Per the URL spec, browsers strip ALL tab/newline characters
  // anywhere in a URL (not just leading ones) before parsing the
  // scheme — so "java\tscript:" or "java\nscript:" is parsed
  // identically to "javascript:". Strip those out before matching so
  // that trick can't smuggle a dangerous scheme past this check.
  const clean = src.replace(/[\t\n\r]/g, "");
  if (DANGEROUS_SCHEME.test(clean)) return false;
  const dataMatch = DATA_URL_MIME.exec(clean);
  if (dataMatch) {
    const mime = (dataMatch[1] ?? "").trim().toLowerCase();
    return SAFE_DATA_IMAGE_MIME.test(mime);
  }
  return true;
};
