import type {
  CallToolResult,
  InputRequiredResult,
} from '@modelcontextprotocol/server';
import { ConfirmationStore } from 'mcp-approval';

/**
 * The token store, extended to answer one question a caller could not answer
 * before: which token this call issued, as a value rather than as a sentence.
 *
 * `ConfirmationStore.issue` returns the token it minted, but the pending
 * result that carries it is built inside mcp-approval, which quotes it into
 * prose and keeps the value to itself. Prose is enough for a model that reads
 * it; an agent loop on a tool-call budget has to find the requirement in the
 * text before it can act on it. Recording the issue here lets the caller
 * attach the same token as a field, without re-issuing — a second `issue`
 * would *replace* the pending token and silently invalidate the one the prose
 * still quotes.
 */
export class TrackedConfirmations extends ConfirmationStore {
  private readonly issued = new Map<string, string>();

  constructor(ttlMs?: number) {
    super(ttlMs);
  }

  /** Mints (or replaces) the pending token for a resource, and records it. */
  override issue(resource: string): string {
    const token = super.issue(resource);
    this.issued.set(resource, token);
    return token;
  }

  /**
   * The token most recently issued for a resource — the one a pending result
   * for that resource quotes. Absent when this call issued none, which is the
   * dialog path: no token exists there to read back.
   */
  issuedFor(resource: string): string | undefined {
    return this.issued.get(resource);
  }
}

/**
 * The fallback prompt, with the requirement attached as fields.
 *
 * A pending approval is prose a model must re-read and obey: the right guard
 * for a human-driven session, hostile to a bounded agent loop that has to
 * parse a sentence before it can learn the call failed for a reason it can
 * act on. The same result therefore also carries `structuredContent`, and the
 * fields say exactly what to do — call `tool` again with the same arguments
 * plus `confirm_token`, within `expires_in_minutes`.
 *
 * Error results are exempt from the tool's `outputSchema` on both sides of the
 * wire, so the fields ride beside the prompt untouched. Only the fallback
 * path has them: the dialog path returns a question for a person, and a
 * declined or rejected call is an error the caller raises itself, which this
 * never sees.
 */
export function withStructuredConfirmation(
  result: CallToolResult | InputRequiredResult,
  resourceKey: string,
  toolName: string,
  confirmations: TrackedConfirmations
): CallToolResult | InputRequiredResult {
  const token = confirmations.issuedFor(resourceKey);
  // Nothing was issued for this key on this call: the dialog path. There is
  // no token to attach, and inventing one would be the guard removed.
  if (token === undefined) return result;
  // The dialog's question is an input_required result, not an error one.
  if (!('isError' in result) || result.isError !== true) return result;
  return {
    ...result,
    structuredContent: {
      confirmation_required: true,
      tool: toolName,
      confirm_token: token,
      expires_in_minutes: confirmations.ttlMinutes,
    },
  };
}
