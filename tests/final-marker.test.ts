import { describe, expect, it } from 'vitest';

import { extractFinalMarkerText, extractHeartbeatNothingText } from '../src/lib/final-marker';

describe('extractFinalMarkerText', () => {
  it('leaves text unchanged when the final marker is absent', () => {
    expect(extractFinalMarkerText('hello')).toEqual({
      text: 'hello',
      markerFound: false,
    });
  });

  it('returns only the text after the last final marker', () => {
    expect(
      extractFinalMarkerText(
        'scratch\n===BRIEF_FINAL===\ndraft\n===BRIEF_FINAL===\nfinal body\n',
      ),
    ).toEqual({
      text: 'final body',
      markerFound: true,
    });
  });
});

describe('extractHeartbeatNothingText', () => {
  it('leaves normal text visible', () => {
    expect(extractHeartbeatNothingText('報告があります')).toEqual({
      text: '報告があります',
      suppress: false,
    });
  });

  it('suppresses heartbeat nothing marker output', () => {
    expect(extractHeartbeatNothingText('===HEARTBEAT_NOTHING===')).toEqual({
      text: '',
      suppress: true,
    });
  });
});
