import { describe, expect, it } from 'vitest';

import { summarizeDebugSessionEvent } from '../src/index';

describe('summarizeDebugSessionEvent', () => {
  it('redacts raw text/input/content/result fields', () => {
    const r = summarizeDebugSessionEvent({
      id: 'evt_1',
      type: 'agent.custom_tool_use',
      created_at: '2026-06-02T00:00:00Z',
      name: 'docs_get',
      text: 'sensitive user text',
      input: { url: 'https://docs.google.com/document/d/private' },
      content: [{ text: 'private content' }],
      result: { email: 'alice@example.com' },
    });

    expect(r).toEqual({
      id: 'evt_1',
      type: 'agent.custom_tool_use',
      created_at: '2026-06-02T00:00:00Z',
      tool_name: 'docs_get',
      text_chars: 19,
      input_redacted: true,
      content_redacted: true,
      result_redacted: true,
    });
    expect(JSON.stringify(r)).not.toContain('docs.google.com');
    expect(JSON.stringify(r)).not.toContain('alice@example.com');
    expect(JSON.stringify(r)).not.toContain('sensitive user text');
  });
});
