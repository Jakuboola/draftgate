/**
 * The `PreToolUse` hook's answer.
 *
 * Shape verified against Claude Code 2.1.258, from the hook documentation embedded in the binary:
 *
 *   hookSpecificOutput.hookEventName            required, or the output is rejected outright
 *                                               ("hookSpecificOutput is missing required field
 *                                               \"hookEventName\"")
 *   hookSpecificOutput.permissionDecision       "allow" | "deny" | "ask"   (PreToolUse only)
 *   hookSpecificOutput.permissionDecisionReason
 *   hookSpecificOutput.updatedInput             (PreToolUse only)
 *   hookSpecificOutput.additionalContext
 *   systemMessage
 *
 * The top-level `decision` field is deprecated for `PreToolUse`, so it is not used.
 *
 * ## Who reads each field
 *
 * MEASURED in a scratch session driven by a stub Messages API, so every request the agent received
 * could be read whole, in default and `auto` mode: `deny` and `ask` on Claude Code 2.1.289, `allow` on
 * 2.1.302.
 *
 * | field                      | `allow`                          | `deny`                          | `ask`                                       |
 * |----------------------------|----------------------------------|---------------------------------|---------------------------------------------|
 * | `permissionDecisionReason` | nobody: not drawn, not sent      | the agent, as the tool's error  | the person, inside the permission prompt    |
 * | `systemMessage`            | the person, under the tool call  | the person, under the tool call | the person, under the tool call, and only   |
 * |                            |                                  |                                 | after they approve; a decline shows nothing |
 * | `additionalContext`        | the agent, after the tool result | the agent                       | the agent, and only after an approval       |
 *
 * An `allow` reason is drawn nowhere, not even in the verbose transcript view, and is in no request:
 * only the session's transcript file keeps it, inside the hook's raw stdout. On `ask` nothing in the
 * reason reaches the agent, and a decline tells it only that the user rejected the call. The prompt's own wording ("Hook PreToolUse:<tool> requires confirmation for this tool:",
 * above the reason) cannot be replaced: `PreToolUse` output has no display field. `decide.ts`'s `ask`
 * lays a decision out for this table.
 *
 * So every `allow` carries `additionalContext`, the agent's only word of what draftgate did; its
 * cases are in `hook.md` ("Who reads an `allow`") and `decide.ts`'s `approvalContext` writes them.
 *
 * Stdout carries this object and nothing else, so the adapter reads the CLI's `--decision` file and
 * never pipes the CLI's stdout (`wire.md`).
 */

/** `reason` is `permissionDecisionReason`; who reads each field depends on the decision (above). */
export type HookDecision =
  | {
      permissionDecision: 'allow';
      reason: string;
      /** The complete tool input: `updatedInput` replaces it wholesale. */
      updatedInput: Record<string, unknown>;
      systemMessage?: string;
      /** For the agent, which hears nothing else of an approval: who approved, and any edit. */
      additionalContext: string;
    }
  | { permissionDecision: 'deny'; reason: string; systemMessage?: string }
  | {
      permissionDecision: 'ask';
      reason: string;
      systemMessage?: string;
      /** For the agent, which hears nothing else of an `ask`, and only once the call is approved. */
      additionalContext: string;
    }
  /**
   * No decision: Claude Code's own permission flow, as though the matcher had not fired. Rendered as
   * empty stdout, the documented spelling ("omit the field (exit 0 with no output) for normal
   * permission flow", hooks docs). Not `allow`, which would skip a default-mode prompt. A
   * `systemMessage` beside no decision is undocumented, so none is sent.
   */
  | { permissionDecision: 'none'; reason?: undefined; systemMessage?: undefined };

/** Serialise a decision: one compact line, newline-terminated. */
export function renderHookOutput(decision: HookDecision): string {
  if (decision.permissionDecision === 'none') return '';
  const hookSpecificOutput: Record<string, unknown> = {
    hookEventName: 'PreToolUse',
    permissionDecision: decision.permissionDecision,
    permissionDecisionReason: decision.reason,
  };
  if (decision.permissionDecision === 'allow') {
    hookSpecificOutput.updatedInput = decision.updatedInput;
  }
  if (decision.permissionDecision !== 'deny') {
    hookSpecificOutput.additionalContext = decision.additionalContext;
  }
  const out: Record<string, unknown> = { hookSpecificOutput };
  if (decision.systemMessage) out.systemMessage = decision.systemMessage;
  return JSON.stringify(out) + '\n';
}
