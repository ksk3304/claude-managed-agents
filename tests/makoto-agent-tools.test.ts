import { describe, expect, it } from 'vitest';

import {
  MAKOTO_AGENT_CUSTOM_TOOLS,
  ensureMakotoAgentCustomTools,
} from '../src/lib/makoto-agent-tools';

describe('MAKOTO agent custom tools', () => {
  it('does not expose destructive delete tools', () => {
    const names = MAKOTO_AGENT_CUSTOM_TOOLS.map((tool) => tool.name);
    expect(names).not.toContain('drive_delete');
    expect(names).not.toContain('calendar_delete_event');
  });

  it('removes deprecated delete tools from an existing employee agent', () => {
    const ensured = ensureMakotoAgentCustomTools([
      { type: 'custom', name: 'drive_delete' },
      { type: 'custom', name: 'calendar_delete_event' },
      { type: 'custom', name: 'drive_search' },
    ]);

    expect(ensured.removed).toEqual(['drive_delete', 'calendar_delete_event']);
    expect(ensured.tools.map((tool) =>
      tool && typeof tool === 'object' ? (tool as { name?: unknown }).name : undefined,
    )).not.toEqual(expect.arrayContaining(['drive_delete', 'calendar_delete_event']));
  });
});
