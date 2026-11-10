/**
 * What the mode lists have to prove.
 *
 * The cut itself is two lines of arithmetic; everything here is about the
 * edges — that it is real in both directions, that a typo is loud at
 * start-up, that what survives keeps the confirmation guard it always had,
 * and that the client can see the policy it is working under.
 */
import { describe, expect, it } from 'vitest';

import { ModeFilterError } from '../src/mode-filter.js';
import { createServer } from '../src/server.js';
import {
  call,
  connect,
  jsonOf,
  testConfig,
  textOf,
  tokenOf,
  toolNames,
} from './harness.js';
import { message } from './fake-imap.js';

function mailboxes() {
  return [
    { path: 'INBOX', messages: [message(1), message(2), message(3)] },
    { path: 'Archive', messages: [] },
  ];
}

const writeConfig = { readOnly: false };

/** Builds a server directly, for the cases where construction is what fails. */
function build(overrides: Parameters<typeof testConfig>[0] = {}): void {
  createServer(testConfig(overrides));
}

describe('the cut, in both directions', () => {
  it('allows moving while denying copying', async () => {
    const harness = await connect({
      config: { ...writeConfig, denyModes: 'copy' },
      mailboxes: mailboxes(),
      elicit: 'accept',
    });
    const moved = await call(harness.client, 'move_messages', {
      uids: [2],
      destination: 'Archive',
    });
    expect(jsonOf(moved)).toMatchObject({ action: 'moved' });
    expect(
      harness.imap.calls.some((entry) => entry.name === 'messageMove')
    ).toBe(true);

    const copied = await call(harness.client, 'move_messages', {
      uids: [3],
      destination: 'Archive',
      mode: 'copy',
    });
    expect(copied.isError).toBe(true);
    // The refusal names the mode that remains, which is why it is an error
    // result rather than a schema rejection.
    expect(textOf(copied)).toContain('The "move" mode is allowed');
    // Refused before the dialog: nobody is asked to approve a call the
    // policy would then refuse.
    expect(harness.prompts).toHaveLength(1);
    expect(
      harness.imap.calls.some((entry) => entry.name === 'messageCopy')
    ).toBe(false);
    await harness.close();
  });

  it('allows copying while denying moving', async () => {
    const harness = await connect({
      config: { ...writeConfig, allowModes: 'copy' },
      mailboxes: mailboxes(),
      elicit: 'accept',
    });
    const copied = await call(harness.client, 'move_messages', {
      uids: [2],
      destination: 'Archive',
      mode: 'copy',
    });
    expect(jsonOf(copied)).toMatchObject({ action: 'copied' });
    expect(
      harness.imap.calls.some((entry) => entry.name === 'messageCopy')
    ).toBe(true);

    // The default mode is "move", so omitting mode is refused rather than
    // silently given the one mode that is left.
    const moved = await call(harness.client, 'move_messages', {
      uids: [3],
      destination: 'Archive',
    });
    expect(moved.isError).toBe(true);
    expect(textOf(moved)).toContain('The "copy" mode is allowed');
    expect(harness.prompts).toHaveLength(1);
    expect(
      harness.imap.calls.some((entry) => entry.name === 'messageMove')
    ).toBe(false);
    await harness.close();
  });
});

describe('what survives the cut keeps its guard', () => {
  it('still asks, token and all, without a dialog client', async () => {
    // The policy narrows the tool, not the confirmation: an allowed mode
    // under a client that cannot ask keeps exactly the two-call token it
    // always had.
    const harness = await connect({
      config: { ...writeConfig, denyModes: 'copy' },
      mailboxes: mailboxes(),
    });
    const first = await call(harness.client, 'move_messages', {
      uids: [2],
      destination: 'Archive',
    });
    expect(textOf(first)).toContain('confirm_token');
    const second = await call(harness.client, 'move_messages', {
      uids: [2],
      destination: 'Archive',
      confirm_token: tokenOf(first),
    });
    expect(jsonOf(second)).toMatchObject({ action: 'moved' });
    await harness.close();
  });
});

describe('refusing an unusable list', () => {
  it('rejects a name no mode has, and says which modes exist', () => {
    // A typo that was merely ignored would leave a mode missing with no
    // trace of why — nobody traces an absence back to an env var.
    expect(() => build({ ...writeConfig, denyModes: 'copi' })).toThrow(
      ModeFilterError
    );
    expect(() => build({ ...writeConfig, denyModes: 'copi' })).toThrow(
      /no mode of move_messages matches "copi"\. Valid modes: move, copy\./
    );
  });

  it('applies the same rule to the allow list', () => {
    expect(() => build({ ...writeConfig, allowModes: 'copies' })).toThrow(
      /IMAP_ALLOW_MODES: no mode of move_messages matches/
    );
  });

  it('rejects a pair of lists that leaves no mode at all', () => {
    expect(() =>
      build({ ...writeConfig, allowModes: 'move', denyModes: 'move' })
    ).toThrow(/no mode at all/);
  });

  it('refuses a bad list under the read-only default too', () => {
    // The write tools are not registered under the default, but a typo in
    // the mode lists is a typo there as well — found at start-up, not on
    // the first write a year later.
    expect(() => build({ denyModes: 'moves' })).toThrow(ModeFilterError);
  });

  it('describes a non-mode-shaped entry rather than printing it', () => {
    // IMAP_PASSWORD sits beside these variables in every compose file, and
    // a paste into the wrong one must not end up quoted in the log.
    let message = '';
    try {
      build({ ...writeConfig, denyModes: 'hunter2' });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('redacted');
    expect(message).not.toContain('hunter2');
  });
});

describe('what the client can see', () => {
  it('does not advertise a switched-off mode as one that works', async () => {
    const harness = await connect({
      config: { ...writeConfig, denyModes: 'copy' },
      mailboxes: mailboxes(),
    });
    const move = (await harness.client.listTools()).tools.find(
      (tool) => tool.name === 'move_messages'
    );
    expect(move?.description).toContain('switched off');
    expect(move?.description).not.toContain('or copies them when mode is');
    await harness.close();
  });

  it('reports the allowed modes in get_server_info', async () => {
    const harness = await connect({
      config: { ...writeConfig, denyModes: 'copy' },
      mailboxes: mailboxes(),
    });
    const info = jsonOf(await call(harness.client, 'get_server_info', {}));
    expect(info).toMatchObject({ allowed_modes: ['move'] });
    await harness.close();
  });

  it('lists both modes when nothing is filtered', async () => {
    const harness = await connect({ config: {} });
    const info = jsonOf(await call(harness.client, 'get_server_info', {}));
    expect(info).toMatchObject({ allowed_modes: ['move', 'copy'] });
    await harness.close();
  });

  it('narrows inside the essential preset', async () => {
    const harness = await connect({
      config: { ...writeConfig, allowTools: 'essential', denyModes: 'copy' },
      mailboxes: mailboxes(),
    });
    expect(await toolNames(harness.client)).toContain('move_messages');
    const refused = await call(harness.client, 'move_messages', {
      uids: [2],
      destination: 'Archive',
      mode: 'copy',
    });
    expect(refused.isError).toBe(true);
    await harness.close();
  });
});
