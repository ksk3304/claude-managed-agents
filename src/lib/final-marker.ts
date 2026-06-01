export const FINAL_BRIEF_MARKER = '===BRIEF_FINAL===';

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
