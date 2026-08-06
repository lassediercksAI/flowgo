package main

import "bytes"

// liveFlagScript turns on the editor's live-event client (src/editor/
// live.ts). It is injected only by servers that actually serve
// /events — today that is this CLI's --host mode. The hosted service
// embeds the same bundle but has no such route, so the client must
// stay opt-in rather than opt-out.
const liveFlagScript = "<script>window.FLOWGO_LIVE=true;</script>"

// injectLiveFlag inserts the flag before </head> so it runs before the
// bundle boots. If the marker is missing (a bundle shape we don't
// recognise) the HTML is returned untouched: losing live updates is a
// far better failure than corrupting the page.
func injectLiveFlag(html []byte) []byte {
	marker := []byte("</head>")
	i := bytes.Index(html, marker)
	if i < 0 {
		return html
	}
	out := make([]byte, 0, len(html)+len(liveFlagScript))
	out = append(out, html[:i]...)
	out = append(out, liveFlagScript...)
	out = append(out, html[i:]...)
	return out
}
