/**
 * Deterministic Trust Boundary pre-check.
 *
 * Claude Console skill auto-invoke is useful, but not a hard safety boundary.
 * This helper mirrors the provenance-check skill's six-axis idea enough to
 * inject `external_data` guidance before the model sees the user message.
 */

export type ProvenanceAxis =
  | 'long_block'
  | 'quote_marker'
  | 'forwarded_header'
  | 'url_density'
  | 'reported_speech'
  | 'first_person_absent';

export interface ProvenanceDetection {
  classification: 'trusted' | 'external_data';
  hitAxes: ProvenanceAxis[];
  score: number;
  summary: string;
}

const FIRST_PERSON_RE = /(私|わたし|自分|俺|僕|ぼく|うち|弊社|当社|当方)/;
const URL_RE = /https?:\/\/[^\s<>"）)]+/g;
const FORWARDED_HEADER_RE =
  /(^|\n)\s*(Forwarded|From|Subject|Date|To|Cc|差出人|送信者|件名|宛先|日時)\s*[:：]/i;
const QUOTE_MARKER_RE = /(^|\n)\s*>|```|「[^」\n]{20,}」|『[^』\n]{20,}』/;
const REPORTED_SPEECH_RE =
  /(さん|氏|くん|ちゃん|君|先方|お客様|顧客|取引先|相手)(が|は|から|より).{0,40}[「『]/;

export function detectExternalDataProvenance(text: string): ProvenanceDetection {
  const body = (text || '').trim();
  const hitAxes: ProvenanceAxis[] = [];
  if (!body) {
    return {
      classification: 'trusted',
      hitAxes,
      score: 0,
      summary: 'empty',
    };
  }

  const longestBlock = longestContinuousBlockLength(body);
  if (longestBlock >= 300) hitAxes.push('long_block');
  const hasQuoteMarker = QUOTE_MARKER_RE.test(body);
  const hasForwardedHeader = FORWARDED_HEADER_RE.test(body);
  if (hasQuoteMarker) hitAxes.push('quote_marker');
  if (hasForwardedHeader) hitAxes.push('forwarded_header');
  if (hasUrlDensity(body)) hitAxes.push('url_density');
  if (REPORTED_SPEECH_RE.test(body)) hitAxes.push('reported_speech');
  if ((body.length >= 120 || hasForwardedHeader) && !FIRST_PERSON_RE.test(body)) {
    hitAxes.push('first_person_absent');
  }

  const score = hitAxes.length;
  return {
    classification: score >= 2 ? 'external_data' : 'trusted',
    hitAxes,
    score,
    summary: score >= 2 ? `external_data axes=${hitAxes.join(',')}` : `trusted axes=${hitAxes.join(',') || 'none'}`,
  };
}

function longestContinuousBlockLength(text: string): number {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.trim().length)
    .reduce((max, len) => Math.max(max, len), 0);
}

function hasUrlDensity(text: string): boolean {
  const urls = text.match(URL_RE) ?? [];
  if (urls.length >= 2) return true;
  if (urls.length === 0) return false;
  const urlChars = urls.reduce((sum, url) => sum + url.length, 0);
  return urlChars / Math.max(1, text.length) > 0.05;
}
