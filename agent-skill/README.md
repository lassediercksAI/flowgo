# flowgo agent skill / `/map` command

Packaged prompts that teach an agent harness to turn a topic or pasted
content into a flowgo map and hand back a share URL — no manual
`.flowgo`-writing by the user required. Both wrap the same hosted MCP
tool (`create_map`, see `../pkg/flowgo/mcp.go`); they differ only in the
packaging format each client expects.

## Prerequisite (both)

An MCP client connected to flowgo's hosted server at
`https://flowgo-map.com/api/mcp` (streamable HTTP, no auth — see brain#211).
A self-hosted `flowgo serve` MCP works too; point the client at that
instead and the same `.flowgo` text applies unchanged.

## Claude Code

`claude-code/map/SKILL.md` is a standard [Claude Code
Skill](https://docs.claude.com/en/docs/claude-code/skills) — its `name:
map` frontmatter is what makes it invocable as `/map` once installed.

Install (project-scoped):

```
mkdir -p .claude/skills
cp -r agent-skill/claude-code/map .claude/skills/map
```

Or user-scoped (available in every project):

```
mkdir -p ~/.claude/skills
cp -r agent-skill/claude-code/map ~/.claude/skills/map
```

Then either type `/map <topic>` directly, or just describe what you want
mapped in normal conversation — the skill's `description` is
trigger-word-optimized (see brain#212) so Claude Code should also surface
it unprompted on "map this out" / "whiteboard this" / etc.

## Cursor

`cursor/commands/map.md` is a [Cursor custom
command](https://docs.cursor.com/context/@-symbols/commands) — copy it
into your project's (or global) commands directory:

```
mkdir -p .cursor/commands
cp agent-skill/cursor/commands/map.md .cursor/commands/map.md
```

Then invoke with `/map <topic>` in Cursor chat. `$ARGUMENTS` in the file
is replaced with whatever follows the slash command.

(Cursor's custom-command format is newer and may have moved since this was
written — if the copied file doesn't show up as `/map`, check Cursor's
current docs for the expected location/frontmatter.)

## Cline

Not packaged here (task scope was "at least Claude Code and one of
Cursor/Cline" — Cursor was picked). Cline supports both MCP servers and
custom instructions/rules files, so the same prompt body in
`cursor/commands/map.md` should adapt with minimal changes if you want it —
contributions welcome.
