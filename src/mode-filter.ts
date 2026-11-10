/**
 * `IMAP_ALLOW_MODES` / `IMAP_DENY_MODES` — the tool filter's cut, one level
 * down.
 *
 * The tool filter answers which *tools* may run; this one answers which
 * *modes* of one tool may. `move_messages` is a single tool that both moves
 * and copies, and the line between the two is worth drawing on its own:
 * moving is the workflow step, copying is the mode that hands every named
 * message to everyone who can read the destination while the source folder
 * keeps no trace — the disclosure argument the approval guide makes in
 * full. An allowlist-driven caller that may file mail but must not publish
 * it had no way to say so: denying the tool removed both.
 *
 * Deliberately not a second `mcp-tool-allowlist`. That package earns its
 * size with patterns and a preset across a catalogue of names; there are
 * two modes, they are fixed, and the same fail-loud rule fits in a file
 * small enough to read whole.
 */

/** The modes `move_messages` accepts, as its schema spells them. */
export type MoveMode = 'move' | 'copy';

/** Every mode there is, in the order the tool's description lists them. */
export const MOVE_MODES: readonly MoveMode[] = ['move', 'copy'];

/** A mode list that names a mode `move_messages` does not have. */
export class ModeFilterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModeFilterError';
  }
}

export interface ModeFilter {
  /** The modes that survive the lists, in catalogue order. */
  readonly allowed: readonly MoveMode[];
  /** Whether one mode of `move_messages` survives the lists. */
  allows(mode: MoveMode): boolean;
  /**
   * The refusal for a mode this filter blocks, as the sentence for
   * `ToolInputError`. It names the mode that remains — a schema refusal
   * could not, which is why the cut is at the tool boundary and not in the
   * enum.
   */
  refusal(mode: MoveMode): string;
}

/**
 * How a rejected entry is quoted back — the tool filter's rule, with its
 * reason. These variables sit beside `IMAP_PASSWORD` in every compose file,
 * and a paste into the wrong one must not be printed into the log: anything
 * mode-shaped is quoted in full, anything else is described by length.
 */
function describeEntry(entry: string): string {
  const longest = MOVE_MODES.reduce((max, mode) => Math.max(max, mode.length), 0);
  return entry.length <= longest && /^[a-z]+$/.test(entry)
    ? `"${entry}"`
    : `an entry of ${entry.length} characters that is not mode-shaped ` +
      '(redacted — if you pasted a credential here, it is not in this log)';
}

/**
 * One raw variable value into the modes it names — the tool lists' rules,
 * whole: comma-separated, trimmed, case-insensitive, empty entries ignored,
 * a value that is empty after all of that counts as unset. An entry that
 * matches no mode is fatal rather than ignored, because the alternative is
 * a mode quietly missing and nobody tracing an absence back to an
 * environment variable.
 */
function parseModes(
  raw: string | undefined,
  variable: string,
  tool: string
): Set<MoveMode> | undefined {
  if (raw === undefined) return undefined;
  const modes = new Set<MoveMode>();
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;
    const mode = MOVE_MODES.find((m) => m === trimmed.toLowerCase());
    if (mode === undefined) {
      throw new ModeFilterError(
        `${variable}: no mode of ${tool} matches ${describeEntry(trimmed)}. ` +
          `Valid modes: ${MOVE_MODES.join(', ')}.`
      );
    }
    modes.add(mode);
  }
  return modes.size === 0 ? undefined : modes;
}

export function buildModeFilter(options: {
  /** Raw value of `IMAP_ALLOW_MODES`, exactly as read from the environment. */
  allowModes: string | undefined;
  /** Raw value of `IMAP_DENY_MODES`. */
  denyModes: string | undefined;
  /** The tool the modes belong to, for the messages. */
  tool: string;
  /** How the server is called, for the refusal the tool hands back. */
  server: string;
}): ModeFilter {
  const allow = parseModes(
    options.allowModes,
    'IMAP_ALLOW_MODES',
    options.tool
  );
  const deny = parseModes(options.denyModes, 'IMAP_DENY_MODES', options.tool);
  const allowed = MOVE_MODES.filter(
    (mode) =>
      (allow === undefined || allow.has(mode)) &&
      (deny === undefined || !deny.has(mode))
  );
  if (allowed.length === 0) {
    throw new ModeFilterError(
      `the mode lists leave ${options.tool} with no mode at all — a ` +
        'narrower tool that can do nothing is a dead one. Keep ' +
        `at least one of: ${MOVE_MODES.join(', ')}.`
    );
  }
  return {
    allowed,
    allows: (mode) => allowed.includes(mode),
    refusal: (mode) => {
      // Two modes, and the lists cannot leave both out, so when one is
      // blocked the other is always there to name — which is the reason
      // the refusal is built here rather than left to the caller.
      const other = MOVE_MODES.find((m) => m !== mode) ?? 'move';
      return (
        `${options.server}: the "${mode}" mode of ${options.tool} is ` +
        `switched off on this server. Nothing was changed. The "${other}" ` +
        'mode is allowed; the policy is set through IMAP_ALLOW_MODES and ' +
        'IMAP_DENY_MODES, and get_server_info lists the modes this server ' +
        'allows.'
      );
    },
  };
}
