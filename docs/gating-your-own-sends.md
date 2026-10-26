# Gating a send draftgate cannot see: wrap it as a local MCP tool

draftgate's hook matches MCP tool names. Everything else an agent can use to put prose in front of a
person -- `Bash` and `curl`, a repo's own CLI, a Python script, a cron job, code in your own agent
loop -- is invisible to it. A send through an allowlisted Bash command does not even prompt: if an
agent posts Jira internal notes through a script that `.claude/settings.json` allowlists, every note
goes out unreviewed and unlogged, with draftgate installed in the same session.

When you own the send, give it a tool name: wrap it in a one-tool local stdio MCP server, mirror the
destination profile's input shape, add the tool to the map, and close the old path.

## A local stdio server is small

Claude Code spawns it as a child process and talks newline-delimited JSON-RPC over stdin and stdout:
no port, nothing to deploy, and it exits when Claude Code does. For one tool, raw JSON-RPC
(`initialize`, `tools/list`, `tools/call`) is about 60 lines with no dependency;
`@modelcontextprotocol/sdk` is optional.

```json
{ "mcpServers": { "jsm": { "type": "stdio", "command": "node",
  "args": ["/absolute/path/to/your/send-tool.js"] } } }
```

On Claude Code 2.1.263, a `.mcp.json` server is spawned only when Claude Code starts from the
directory holding it. Started from a subdirectory, it reports `Pending approval` and the tool is
absent, which looks like a bug in your server and is not.

## Step 1: mirror the destination profile

draftgate reads the body out of the payload by name and writes the approved one back the same way
(`cli/src/payload.ts`). Match the profile and your tool needs one map entry and no code:

| destination | `bodyField` | `extraToolInput` set on approve | `mode` | what your tool receives |
|---|---|---|---|---|
| jira | `commentBody` | `{ contentFormat: 'adf' }` | `convert-and-replace` | an ADF document as a JSON string |
| slack | `message` | `{}` | `preview-only` | markdown |
| linear | `body` | `{}` | `preview-only` | markdown |
| github | `body` | `{}` | `preview-only` | markdown |

`buildUpdatedInput` returns the complete input with `extraToolInput` set over it. So a Jira-bound
tool **must accept `contentFormat: "adf"`** and parse `commentBody` as a JSON string. Jira takes the
document that way (probed on a real Jira Cloud issue: 201, stored correctly); a tool that ignores
the field posts the JSON as literal text.

Give a Jira tool two branches, keyed on that field: with `contentFormat: "adf"` it posts the
document as given (the gated path); without it, it takes markdown, for a person at a terminal or
anyone without draftgate.

## Step 2: add it to the tool map, then run setup

`~/.draftgate/tools.json`:

```json
{ "mcp__jsm__jira_add_internal_note": { "destination": "jira", "contextFields": ["*"] } }
```

The key is the full tool name, `mcp__<your .mcp.json server key>__<tool>`. `"contextFields": ["*"]`
shows the reviewer every field the call sends beyond the profile's own `contextFields`, read-only
beside the draft, as every default route does. `"jira"` alone works too and shows only the profile's
fields.

Name the tool `jira_add_internal_note` only if it posts internal notes. With your `tools.json`
entry, its review says "Internal note" and that the reporter never sees it. The default map has no
such entry, because the server key is yours. The same name under a server nobody mapped is still
reviewed, with the audience shown as unknown.

Or let setup write it: `/draftgate:setup`, run where your server is loaded, offers the send tools of
servers you set up yourself, asks where each one sends, and adds the entry with the field its
message is in (`draftgate propose-tools --add <tool> <destination> <field>`).

Then run `/draftgate:setup` in Claude Code. The plugin's matcher covers every tool half draftgate
knows, under any server. For a tool with a new half, setup adds one settings entry whose matcher is
generated from your map; a tool no matcher covers is never reviewed. Run setup again after removing
a tool too: until then the old entry keeps firing, the tool arrives unmapped, and **an unmapped tool
is denied**.

If your tool's body field is optional in its own schema (a worklog-shaped call that usually carries
no prose), add `"bodyOptional": true` to its entry. A call with no body and no prose in another
field is then allowed instead of asked about.

## Step 3: close the old path

Adding the tool changes nothing on its own, because the agent is still told to use the script.
Repoint every caller at the tool, then narrow or drop the allowlist entry for the direct command.
Write the split down where the next person will read it (people use the script, agents use the
tool), or somebody restores the allowlist line because it looks like an oversight.

The allowlisted Bash path was silent, but a new MCP tool with neither draftgate nor an allow rule
prompts on every call. Install draftgate (its `allow` on approval replaces the prompt rather than
adding to it) or allowlist the tool name.

## Three traps

1. Do not let both converters run. If your tool converts markdown itself on the gated path, the
   reviewer approves a preview built by draftgate's converter while another one builds what is
   sent. Hence the ADF branch for Jira.
2. Enrich the text before the review. Anything your sender adds after the body (labelling bare URLs,
   an "AI-generated" header, smart links) is not what the reviewer approved. Put it in the markdown
   the agent writes, where the reviewer sees it. Two costs: a node with no markdown spelling (ADF's
   `inlineCard`) cannot survive the trip, and without a prepended header an empty body is possible
   again, which the destination answers with 400.
3. A route in `tools.json` asks on a missing body instead of allowing it. The allow is for a
   vendor's connector renaming its body field, not for a schema you wrote. (An entry that only
   repeats a default route keeps the default's behaviour.)

## What the gate does not cover

The gate reviews prose; it does not make your sender correct: escape a key that goes into a URL
path, and do not exit while a request is in flight. It does block a body a reader would see as
empty (`body/empty`, and for Jira `jira/empty-body`).

Wrapping one send makes one send reviewable. An agent that picks another tool, or shells out to
something nobody wrapped, still goes around the gate. Wrap the sends that matter: outbound messages
to people, on paths you own.
