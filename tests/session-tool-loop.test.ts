/**
 * Unit tests for `sendAndStreamWithToolDispatch` (`src/lib/session.ts`).
 *
 * Drives the loop with a fake Anthropic SDK client whose `events.stream`
 * yields a scripted sequence of events. Verifies:
 *   - text events accumulate into assistantText
 *   - `agent.custom_tool_use` events trigger the dispatcher and the
 *     result is posted back as `user.custom_tool_result`
 *   - terminal `session.status_idle` / `session.status_terminated` end the loop
 *   - tool-call soft cap breaks the loop with the cap label
 */

import { describe, it, expect } from 'vitest';
import {
  sendAndStreamWithToolDispatch,
  type ToolDispatcher,
} from '../src/lib/session';
import type Anthropic from '@anthropic-ai/sdk';

interface FakeEvent {
  type: string;
  [k: string]: unknown;
}

interface FakeClientOptions {
  events: FakeEvent[];
  /** Capture each events.send payload here. */
  onSend?: (payload: unknown) => void;
}

function makeFakeClient(opts: FakeClientOptions): Anthropic {
  async function* stream(): AsyncIterable<FakeEvent> {
    for (const ev of opts.events) yield ev;
  }
  return {
    beta: {
      sessions: {
        events: {
          async send(_sessionId: string, payload: unknown): Promise<void> {
            opts.onSend?.(payload);
          },
          async stream(_sessionId: string, _opts: unknown): Promise<AsyncIterable<FakeEvent>> {
            return stream();
          },
        },
      },
    },
  } as unknown as Anthropic;
}

describe('sendAndStreamWithToolDispatch', () => {
  it('accumulates text events into assistantText', async () => {
    const client = makeFakeClient({
      events: [
        { type: 'agent.message.start' },
        { type: 'agent.message.text_delta', text: 'Hello, ' },
        { type: 'agent.message.text_delta', text: 'world.' },
        { type: 'session.status_idle' },
      ],
    });
    const dispatcher: ToolDispatcher = async () => ({ ok: true, payload: null });
    const r = await sendAndStreamWithToolDispatch(client, {
      sessionId: 'sesn_1',
      userMessage: 'hi',
      toolDispatcher: dispatcher,
    });
    expect(r.assistantText).toBe('Hello, world.');
    expect(r.terminalEventType).toBe('session.status_idle');
  });

  it('dispatches agent.custom_tool_use and posts a user.custom_tool_result', async () => {
    const sent: unknown[] = [];
    const client = makeFakeClient({
      events: [
        {
          type: 'agent.custom_tool_use',
          id: 'tu_1',
          name: 'drive_search',
          input: { query: 'x' },
        },
        { type: 'session.status_idle' },
      ],
      onSend: (p) => sent.push(p),
    });
    const dispatched: { name: string; input: unknown }[] = [];
    const dispatcher: ToolDispatcher = async (name, input) => {
      dispatched.push({ name, input });
      return { ok: true, payload: { files: [] } };
    };
    await sendAndStreamWithToolDispatch(client, {
      sessionId: 'sesn_1',
      userMessage: 'find',
      toolDispatcher: dispatcher,
    });
    expect(dispatched).toEqual([{ name: 'drive_search', input: { query: 'x' } }]);
    // Two sends: 1) the initial user.message, 2) the user.custom_tool_result
    expect(sent).toHaveLength(2);
    const second = sent[1] as { events: Array<Record<string, unknown>> };
    expect(second.events[0]!.type).toBe('user.custom_tool_result');
    expect(second.events[0]!.custom_tool_use_id).toBe('tu_1');
    expect(second.events[0]!.is_error).toBeUndefined();
  });

  it('sets is_error=true on failed dispatch', async () => {
    const sent: unknown[] = [];
    const client = makeFakeClient({
      events: [
        { type: 'agent.custom_tool_use', id: 'tu_1', name: 'drive_search', input: {} },
        { type: 'session.status_idle' },
      ],
      onSend: (p) => sent.push(p),
    });
    const dispatcher: ToolDispatcher = async () => ({
      ok: false,
      payload: { error: 'schema', tool: 'drive_search' },
    });
    await sendAndStreamWithToolDispatch(client, {
      sessionId: 's',
      userMessage: 'x',
      toolDispatcher: dispatcher,
    });
    const second = sent[1] as { events: Array<Record<string, unknown>> };
    expect(second.events[0]!.is_error).toBe(true);
  });

  it('continues past one tool call to terminal', async () => {
    const client = makeFakeClient({
      events: [
        { type: 'agent.custom_tool_use', id: 'tu_1', name: 'drive_search', input: {} },
        { type: 'agent.message.text_delta', text: 'done' },
        { type: 'session.status_idle' },
      ],
    });
    const dispatcher: ToolDispatcher = async () => ({ ok: true, payload: null });
    const r = await sendAndStreamWithToolDispatch(client, {
      sessionId: 's',
      userMessage: 'x',
      toolDispatcher: dispatcher,
    });
    expect(r.terminalEventType).toBe('session.status_idle');
    expect(r.assistantText).toContain('done');
  });

  it('stops on session.status_terminated', async () => {
    const client = makeFakeClient({
      events: [{ type: 'agent.message.text_delta', text: 'partial' }, { type: 'session.status_terminated' }],
    });
    const dispatcher: ToolDispatcher = async () => ({ ok: true, payload: null });
    const r = await sendAndStreamWithToolDispatch(client, {
      sessionId: 's',
      userMessage: 'x',
      toolDispatcher: dispatcher,
    });
    expect(r.terminalEventType).toBe('session.status_terminated');
  });

  it('cap on max tool calls breaks the loop', async () => {
    const tools = Array.from({ length: 5 }, (_, i) => ({
      type: 'agent.custom_tool_use',
      id: `tu_${i}`,
      name: 'drive_search',
      input: {},
    }));
    const client = makeFakeClient({
      events: [...tools, { type: 'session.status_idle' }],
    });
    let dispatched = 0;
    const dispatcher: ToolDispatcher = async () => {
      dispatched++;
      return { ok: true, payload: null };
    };
    const r = await sendAndStreamWithToolDispatch(client, {
      sessionId: 's',
      userMessage: 'x',
      toolDispatcher: dispatcher,
      maxToolCalls: 3,
    });
    expect(dispatched).toBe(3);
    expect(r.terminalEventType).toBe('limit.custom_tool_calls');
  });

  it('catches dispatcher throws and posts error envelope (loop survives)', async () => {
    const sent: unknown[] = [];
    const client = makeFakeClient({
      events: [
        { type: 'agent.custom_tool_use', id: 'tu_1', name: 'drive_search', input: {} },
        { type: 'session.status_idle' },
      ],
      onSend: (p) => sent.push(p),
    });
    const dispatcher: ToolDispatcher = async () => {
      throw new Error('dispatcher exploded');
    };
    const r = await sendAndStreamWithToolDispatch(client, {
      sessionId: 's',
      userMessage: 'x',
      toolDispatcher: dispatcher,
    });
    expect(r.terminalEventType).toBe('session.status_idle');
    const result = sent[1] as { events: Array<Record<string, unknown>> };
    expect(result.events[0]!.is_error).toBe(true);
  });

  it('parses EMAIL_SEND markers from the assistant text', async () => {
    const client = makeFakeClient({
      events: [
        {
          type: 'agent.message.text',
          text:
            'preface\nEMAIL_SEND:{"to":"x@y","subject":"s","body":"b"}\nafter',
        },
        { type: 'session.status_idle' },
      ],
    });
    const dispatcher: ToolDispatcher = async () => ({ ok: true, payload: null });
    const r = await sendAndStreamWithToolDispatch(client, {
      sessionId: 's',
      userMessage: 'x',
      toolDispatcher: dispatcher,
    });
    expect(r.emailSendMarkers).toHaveLength(1);
    expect(r.emailSendMarkers[0]!.to).toBe('x@y');
  });
});
