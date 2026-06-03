export const FINAL_BRIEF_MARKER = '===BRIEF_FINAL===';
export const HEARTBEAT_NOTHING_MARKER = '===HEARTBEAT_NOTHING===';

export interface FinalMarkerExtraction {
  text: string;
  markerFound: boolean;
}

export function extractFinalMarkerText(text: string): FinalMarkerExtraction {
  const idx = text.lastIndexOf(FINAL_BRIEF_MARKER);
  if (idx === -1) {
    return { text, markerFound: false };
  }
  return {
    text: text.slice(idx + FINAL_BRIEF_MARKER.length).trim(),
    markerFound: true,
  };
}

export interface HeartbeatNothingExtraction {
  text: string;
  suppress: boolean;
}

export function extractHeartbeatNothingText(text: string): HeartbeatNothingExtraction {
  if (!text.includes(HEARTBEAT_NOTHING_MARKER)) {
    return { text, suppress: false };
  }
  return { text: text.replaceAll(HEARTBEAT_NOTHING_MARKER, '').trim(), suppress: true };
}
