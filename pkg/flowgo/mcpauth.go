package flowgo

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"fmt"
	"log"
	"time"
)

// MCP account linking (brain#22c).
//
// Every MCP session is anonymous by default: nothing on the JSON-RPC
// path knows who the human behind the agent is, so a `share` /
// `create_map` call persists an ownerless snapshot even when that same
// human is signed into the hosted site in a browser tab.
//
// This file adds the device-code half of a `gh auth login`-style
// pairing flow. flowgo core has no database and no notion of accounts
// — it can't, it's the library that also runs as a single-user CLI —
// so the actual token table and account lookup live in the host
// application (flowgo-website) behind the MCPAuth interface below.
// When Config.Auth is nil (the CLI, `flowgo serve`, tests) the
// `authenticate` tool simply isn't advertised and every persistence
// path behaves exactly as it did before.
//
// Deliberately NOT implemented here: OAuth 2.1 authorization-server
// compliance (RFC 8414 metadata, RFC 7591 dynamic client registration,
// PKCE authorization-code flow). That's what listing flowgo as an
// official Claude Connector / OpenAI connector would require, and it
// would sit *in front of* this same account-linking seam rather than
// replacing it — the MCPAuth implementation is the reusable half.

// MCPAuth is the host-provided hook that binds an MCP session to an
// account. Implementations must treat sessionID as an opaque,
// attacker-controllable string: hash it before storage and never
// derive trust from its shape.
type MCPAuth interface {
	// BeginPairing mints a short-lived, single-use pairing code for
	// sessionID and returns the browser URL that approves it. Called
	// only from the `authenticate` tool.
	BeginPairing(ctx context.Context, sessionID string) (Pairing, error)

	// SessionOwner reports the account currently linked to sessionID.
	// ok=false means "not linked" and is not an error.
	SessionOwner(ctx context.Context, sessionID string) (Owner, bool, error)

	// EndSession drops any account link for sessionID. Wired to the
	// MCP streamable-HTTP DELETE (session termination) so an agent can
	// sign itself out without waiting for the link's TTL.
	EndSession(ctx context.Context, sessionID string) error
}

// Pairing is what BeginPairing hands back: the approval URL to show a
// human, and when it stops working.
type Pairing struct {
	URL       string
	ExpiresAt time.Time
}

// Owner identifies the linked account. ID is the host's opaque
// identifier (forwarded to the share webhook as owner_id); Label is a
// human-readable handle — an email address in the hosted deployment —
// echoed back to the agent so it can confirm *who* it linked as.
type Owner struct {
	ID    string
	Label string
}

// mcpSessionHeader is the streamable-HTTP transport's session header.
// The server mints a value on `initialize` and compliant clients echo
// it on every subsequent request, which is what gives us a stable
// per-session identity without adding an argument to every tool.
const mcpSessionHeader = "Mcp-Session-Id"

// newMCPSessionID returns a 256-bit URL-safe session identifier. Same
// entropy budget as the website's auth tokens: the id is a bearer
// credential once an account is linked to it, so it has to be
// unguessable.
func newMCPSessionID() string {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand failing is unrecoverable and must not degrade to
		// a predictable id.
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// sessionKey resolves the identity a tool call should be attributed
// to. Preference order:
//
//  1. the transport session id, when the client honours the header;
//  2. "ws:<workspace_id>", so clients that don't round-trip
//     Mcp-Session-Id can still authenticate a workspace they created.
//
// Returning "" means "this call cannot be attributed" — callers treat
// that as anonymous rather than as an error, except in `authenticate`
// where there'd be nothing to link.
func sessionKey(transportID string, args map[string]any) string {
	if transportID != "" {
		return transportID
	}
	if ws := stringArg(args, "workspace_id", ""); ws != "" {
		return "ws:" + ws
	}
	return ""
}

// actAuthenticate is the `authenticate` tool. It doubles as the status
// check: calling it once mints a pairing URL, calling it again after
// the human approves reports the linked account. That keeps the agent
// loop to a single tool (mint → show URL → poll the same tool) instead
// of the two-endpoint dance a literal device flow would need.
func actAuthenticate(ctx context.Context, transportID string, args map[string]any) (any, error) {
	if cfg.Auth == nil {
		return nil, fmt.Errorf("account linking is not enabled on this flowgo server")
	}
	key := sessionKey(transportID, args)
	if key == "" {
		return nil, fmt.Errorf("this MCP client did not send an Mcp-Session-Id header, so there is no session to link. Call start_workspace first and pass its workspace_id to authenticate")
	}

	owner, linked, err := cfg.Auth.SessionOwner(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("could not check sign-in status, try again")
	}
	if linked {
		return mcpToolText(fmt.Sprintf(
			"Already signed in as %s. Maps you share or create from this session are saved to that flowgo account.",
			owner.Label)), nil
	}

	p, err := cfg.Auth.BeginPairing(ctx, key)
	if err != nil {
		return nil, fmt.Errorf("could not start sign-in: %v", err)
	}
	mins := int(time.Until(p.ExpiresAt).Round(time.Minute) / time.Minute)
	if mins < 1 {
		mins = 1
	}
	return mcpToolText(fmt.Sprintf(`Not signed in yet. Show this link to the human and ask them to open it in a browser where they are signed in to flowgo, then approve the request:

%s

The link works once and expires in %d minutes. Only they should open it — approving links THIS agent session to their account. Once they confirm, call authenticate again to verify; from then on share and create_map save maps into their account instead of an anonymous snapshot.`,
		p.URL, mins)), nil
}

// sessionOwnerID resolves the owner id to stamp onto persisted
// content, or "" when the session is unlinked. Deliberately fail-open:
// a database hiccup in the auth lookup must not stop a human from
// getting their share link, it just costs the attribution.
func sessionOwnerID(ctx context.Context, transportID string, args map[string]any) string {
	if cfg.Auth == nil {
		return ""
	}
	key := sessionKey(transportID, args)
	if key == "" {
		return ""
	}
	owner, ok, err := cfg.Auth.SessionOwner(ctx, key)
	if err != nil {
		log.Printf("mcp: session owner lookup failed: %v", err)
		return ""
	}
	if !ok {
		return ""
	}
	return owner.ID
}

// endMCPSession is the DELETE handler's side effect. Errors are logged
// and swallowed — the transport-level answer to "terminate this
// session" is unconditionally "done".
func endMCPSession(ctx context.Context, transportID string) {
	if cfg.Auth == nil || transportID == "" {
		return
	}
	if err := cfg.Auth.EndSession(ctx, transportID); err != nil {
		log.Printf("mcp: ending session failed: %v", err)
	}
}
