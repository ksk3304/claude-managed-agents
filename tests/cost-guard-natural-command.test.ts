import { describe, it, expect } from 'vitest';

import { parseNaturalCostGuardCommand } from '../src/lib/cost-guard-natural-command';

describe('parseNaturalCostGuardCommand', () => {
  it('maps natural status requests to status', () => {
    expect(parseNaturalCostGuardCommand('コストガード見せて')).toEqual({
      subcommand: 'status',
      restTokens: [],
    });
    expect(parseNaturalCostGuardCommand('安全装置どうなってる？')).toEqual({
      subcommand: 'status',
      restTokens: [],
    });
  });

  it('maps natural mutation requests to deterministic costguard subcommands', () => {
    expect(parseNaturalCostGuardCommand('安全装置を10分止めて')).toEqual({
      subcommand: 'pause',
      restTokens: ['10m'],
    });
    expect(parseNaturalCostGuardCommand('コストガード再開して')).toEqual({
      subcommand: 'resume',
      restTokens: [],
    });
    expect(parseNaturalCostGuardCommand('コストガード無効化')).toEqual({
      subcommand: 'disable',
      restTokens: [],
    });
  });

  it('maps natural hard-cap updates with axes', () => {
    expect(parseNaturalCostGuardCommand('月額上限を100ドルにして')).toEqual({
      subcommand: 'set',
      restTokens: ['hard-cap', 'month-usd', '100'],
    });
    expect(parseNaturalCostGuardCommand('Chat投稿数上限を50に変更')).toEqual({
      subcommand: 'set',
      restTokens: ['hard-cap', 'chat-daily', '50'],
    });
    expect(parseNaturalCostGuardCommand('外部API上限を20にして')).toEqual({
      subcommand: 'set',
      restTokens: ['hard-cap', 'external-api-daily', '20'],
    });
  });

  it('accepts common voice typo for costguard', () => {
    expect(parseNaturalCostGuardCommand('ポストカードの状態')).toEqual({
      subcommand: 'status',
      restTokens: [],
    });
  });

  it('ignores unrelated text', () => {
    expect(parseNaturalCostGuardCommand('こんにちは')).toBeNull();
  });
});
