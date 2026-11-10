import {
  InMemoryTransport,
  isJSONRPCErrorResponse,
  isJSONRPCResultResponse,
} from '@modelcontextprotocol/client';
import type {
  JSONRPCMessage,
  JSONRPCRequest,
} from '@modelcontextprotocol/client';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { describe, expect, it } from 'vitest';

import { createServer } from '../src/server.js';
import { FakeImap } from './fake-imap.js';
import { defaultMailboxes, testConfig } from './harness.js';

/**
 * A minimal JSON-RPC 2.0 client over the in-memory wire: initialize,
 * notifications/initialized, tools/list, tools/call — and nothing else.
 *
 * This is the shape of the small stdio clients the compatibility question is
 * about, and the SDK's own client cannot stand in for it: in the legacy mode a
 * plain handshake lands in it offers the revision it pins rather than the one
 * a caller wants observed, and its probing modes send traffic a minimal
 * client never sends. What such a client gets answered is what this suite
 * has to see.
 */
class RawClient {
  private nextId = 0;

  private readonly pending = new Map<string, (reply: JSONRPCMessage) => void>();

  constructor(private readonly transport: InMemoryTransport) {
    transport.onmessage = (message) => {
      if (
        !isJSONRPCResultResponse(message) &&
        !isJSONRPCErrorResponse(message)
      ) {
        // A minimal client answers no requests, and the read tools send
        // none; anything else on the wire is not ours to wait for.
        return;
      }
      const settle = this.pending.get(String(message.id));
      if (settle === undefined) {
        return;
      }
      this.pending.delete(String(message.id));
      settle(message);
    };
  }

  /** Sends a request and resolves with the raw JSON-RPC answer. */
  async request(
    method: string,
    params: Record<string, unknown>
  ): Promise<JSONRPCMessage> {
    const id = ++this.nextId;
    const answer = new Promise<JSONRPCMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(String(id));
        reject(new Error(`no answer to ${method} within 5 seconds`));
      }, 5_000);
      this.pending.set(String(id), (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
    });
    try {
      await this.transport.send({
        jsonrpc: '2.0',
        id,
        method,
        params,
      } as unknown as JSONRPCRequest);
    } catch (error) {
      // The answer promise only ever rejects on the timeout, and a send
      // that threw never reaches a caller who could catch that rejection.
      answer.catch(() => undefined);
      throw error;
    }
    return answer;
  }

  /** Sends a notification, which is answered with nothing. */
  async notify(method: string): Promise<void> {
    await this.transport.send({
      jsonrpc: '2.0',
      method,
    } as unknown as JSONRPCMessage);
  }
}

/**
 * Boots the real stdio entry — serveStdio, the same call src/index.ts makes,
 * so the era decision is the one a client over stdio actually gets — against
 * the fake mailbox, with a raw client on the other end of the wire.
 */
async function boot(): Promise<{
  client: RawClient;
  close: () => Promise<void>;
}> {
  const imap = new FakeImap(defaultMailboxes());
  const server = createServer(testConfig(), { imapFactory: () => imap });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const handle = serveStdio(() => server, { transport: serverTransport });
  await clientTransport.start();
  return {
    client: new RawClient(clientTransport),
    close: async () => {
      await clientTransport.close();
      await handle.close();
    },
  };
}

/** Runs a test body against a raw client, closing the wire either way. */
async function withRawClient(
  run: (client: RawClient) => Promise<void>
): Promise<void> {
  const { client, close } = await boot();
  try {
    await run(client);
  } finally {
    await close();
  }
}

/**
 * The initialize handshake a minimal client sends — no envelope claim, no
 * probe — answered with the raw result, so the revision it settled on is
 * there to read.
 */
async function initialize(
  client: RawClient,
  offered: string
): Promise<Record<string, unknown>> {
  const answer = await client.request('initialize', {
    protocolVersion: offered,
    capabilities: {},
    clientInfo: { name: 'raw-client', version: '0.0.0' },
  });
  return resultObjectOf(answer, 'initialize');
}

/**
 * Narrows a raw answer to its result object, refusing an error answer by
 * quoting it, so a failure says what the server actually said.
 */
function resultObjectOf(
  answer: JSONRPCMessage,
  method: string
): Record<string, unknown> {
  if (isJSONRPCErrorResponse(answer)) {
    throw new Error(`${method} answered an error: ${answer.error.message}`);
  }
  if (!isJSONRPCResultResponse(answer)) {
    throw new Error(`${method} answered neither a result nor an error`);
  }
  return answer.result as Record<string, unknown>;
}

/** The revision the handshake settled on, out of a raw initialize result. */
function protocolVersionOf(result: Record<string, unknown>): string {
  const version = result['protocolVersion'];
  if (typeof version !== 'string') {
    throw new Error('initialize answered no protocolVersion');
  }
  return version;
}

/**
 * tools/list and tools/call on the negotiated revision — the negotiation is
 * only worth its answer if the tools still answer too.
 */
async function expectToolsWork(client: RawClient): Promise<void> {
  await client.notify('notifications/initialized');

  const listed = resultObjectOf(
    await client.request('tools/list', {}),
    'tools/list'
  );
  const tools = listed['tools'];
  if (!Array.isArray(tools)) {
    throw new Error('tools/list answered no tools array');
  }
  const names = tools.map((tool) => nameOf(tool));
  expect(names).toContain('list_mailboxes');
  expect(names).toContain('get_message');

  const called = resultObjectOf(
    await client.request('tools/call', {
      name: 'list_mailboxes',
      arguments: {},
    }),
    'tools/call'
  );
  const text = firstTextOf(called['content']);
  expect(text).toContain('INBOX');
  expect(text).toContain('Archive');
}

/** The name of a listed tool, or the empty string when it has none. */
function nameOf(tool: unknown): string {
  const name = (tool as Record<string, unknown>)['name'];
  return typeof name === 'string' ? name : '';
}

/** The first text block of a tools/call result, the part a client shows. */
function firstTextOf(content: unknown): string {
  if (!Array.isArray(content)) {
    throw new Error('tools/call answered no content array');
  }
  const text = content.find(
    (part): part is Record<string, unknown> =>
      typeof part === 'object' &&
      part !== null &&
      (part as Record<string, unknown>)['type'] === 'text'
  );
  const value = text?.['text'];
  if (typeof value !== 'string') {
    throw new Error('tools/call answered no text block');
  }
  return value;
}

describe('protocol revision negotiation over stdio', () => {
  // The revision minimal clients pinned in 2025: it is echoed, and the tools
  // answer on it.
  it('echoes a 2025-06-18 offer, then serves tools on it', async () => {
    await withRawClient(async (client) => {
      const answer = await initialize(client, '2025-06-18');
      expect(protocolVersionOf(answer)).toBe('2025-06-18');
      await expectToolsWork(client);
    });
  });

  // The seam a v1.13-style client exercises: it offers the newest revision
  // and continues on the counteroffer the server names.
  it('answers a 2026-07-28 offer with the 2025-11-25 counteroffer', async () => {
    await withRawClient(async (client) => {
      const answer = await initialize(client, '2026-07-28');
      expect(protocolVersionOf(answer)).toBe('2025-11-25');
      await expectToolsWork(client);
    });
  });

  // An unknown revision — a typo or a future one — gets the same
  // counteroffer; the handshake never errors and never hangs.
  it('answers an unknown revision the same way, never a hang', async () => {
    await withRawClient(async (client) => {
      const answer = await initialize(client, '1999-01-01');
      expect(protocolVersionOf(answer)).toBe('2025-11-25');
      await expectToolsWork(client);
    });
  });
});
