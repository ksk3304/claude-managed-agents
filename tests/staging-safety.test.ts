import { describe, expect, it } from 'vitest';

import {
  externalSideEffectsDisabled,
  isChatQueueName,
} from '../src/lib/staging-safety';

describe('staging-safety', () => {
  it('keeps the production chat queue name as the default', () => {
    expect(isChatQueueName('makoto-chat-queue', {})).toBe(true);
    expect(isChatQueueName('makoto-agentmail-events', {})).toBe(false);
  });

  it('allows environment-specific chat queue names', () => {
    const env = {
      MAKOTO_CHAT_QUEUE_NAME: 'makoto-chat-queue-stg',
      MAKOTO_CHAT_QUEUE_NAMES: 'makoto-chat-queue-preview, makoto-chat-queue-shadow',
    };

    expect(isChatQueueName('makoto-chat-queue', env)).toBe(true);
    expect(isChatQueueName('makoto-chat-queue-stg', env)).toBe(true);
    expect(isChatQueueName('makoto-chat-queue-preview', env)).toBe(true);
    expect(isChatQueueName('makoto-chat-queue-shadow', env)).toBe(true);
    expect(isChatQueueName('makoto-agentmail-events-stg', env)).toBe(false);
  });

  it('parses external side-effect disable flags conservatively', () => {
    expect(externalSideEffectsDisabled({ MAKOTO_EXTERNAL_SIDE_EFFECTS_DISABLED: '1' })).toBe(true);
    expect(externalSideEffectsDisabled({ MAKOTO_EXTERNAL_SIDE_EFFECTS_DISABLED: 'true' })).toBe(true);
    expect(externalSideEffectsDisabled({ MAKOTO_EXTERNAL_SIDE_EFFECTS_DISABLED: 'off' })).toBe(false);
    expect(externalSideEffectsDisabled({})).toBe(false);
  });
});
