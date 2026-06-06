export interface AnthropicModelPricingRow {
  model: string;
  aliases: readonly string[];
  displayName: string;
  inputUsdPerMtok: number;
  outputUsdPerMtok: number;
  cacheWrite5mUsdPerMtok: number;
  cacheWrite1hUsdPerMtok: number;
  cacheReadUsdPerMtok: number;
}

export const ANTHROPIC_MODEL_PRICING_METADATA = {
  schemaVersion: 1,
  currency: 'USD',
  unit: 'per_1m_tokens',
  sourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
  cachePricingSourceUrl: 'https://platform.claude.com/docs/en/about-claude/pricing#prompt-caching',
  modelIdsSourceUrl: 'https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions',
  sourceCheckedAt: '2026-06-06T09:42:20+09:00',
  nextReviewDue: '2026-07-06',
  reviewTriggers: [
    'monthly',
    'anthropic_model_update',
    'before_pdf_preflight_gate_change',
  ],
  automationPolicy: 'diff_detection_human_review_only',
} as const;

export const ANTHROPIC_MODEL_PRICING = [
  {
    model: 'claude-opus-4-8',
    aliases: [],
    displayName: 'Claude Opus 4.8',
    inputUsdPerMtok: 5,
    outputUsdPerMtok: 25,
    cacheWrite5mUsdPerMtok: 6.25,
    cacheWrite1hUsdPerMtok: 10,
    cacheReadUsdPerMtok: 0.5,
  },
  {
    model: 'claude-opus-4-7',
    aliases: [],
    displayName: 'Claude Opus 4.7',
    inputUsdPerMtok: 5,
    outputUsdPerMtok: 25,
    cacheWrite5mUsdPerMtok: 6.25,
    cacheWrite1hUsdPerMtok: 10,
    cacheReadUsdPerMtok: 0.5,
  },
  {
    model: 'claude-opus-4-6',
    aliases: [],
    displayName: 'Claude Opus 4.6',
    inputUsdPerMtok: 5,
    outputUsdPerMtok: 25,
    cacheWrite5mUsdPerMtok: 6.25,
    cacheWrite1hUsdPerMtok: 10,
    cacheReadUsdPerMtok: 0.5,
  },
  {
    model: 'claude-opus-4-5',
    aliases: [],
    displayName: 'Claude Opus 4.5',
    inputUsdPerMtok: 5,
    outputUsdPerMtok: 25,
    cacheWrite5mUsdPerMtok: 6.25,
    cacheWrite1hUsdPerMtok: 10,
    cacheReadUsdPerMtok: 0.5,
  },
  {
    model: 'claude-opus-4-1',
    aliases: [],
    displayName: 'Claude Opus 4.1',
    inputUsdPerMtok: 15,
    outputUsdPerMtok: 75,
    cacheWrite5mUsdPerMtok: 18.75,
    cacheWrite1hUsdPerMtok: 30,
    cacheReadUsdPerMtok: 1.5,
  },
  {
    model: 'claude-opus-4',
    aliases: [],
    displayName: 'Claude Opus 4',
    inputUsdPerMtok: 15,
    outputUsdPerMtok: 75,
    cacheWrite5mUsdPerMtok: 18.75,
    cacheWrite1hUsdPerMtok: 30,
    cacheReadUsdPerMtok: 1.5,
  },
  {
    model: 'claude-sonnet-4-6',
    aliases: [],
    displayName: 'Claude Sonnet 4.6',
    inputUsdPerMtok: 3,
    outputUsdPerMtok: 15,
    cacheWrite5mUsdPerMtok: 3.75,
    cacheWrite1hUsdPerMtok: 6,
    cacheReadUsdPerMtok: 0.3,
  },
  {
    model: 'claude-sonnet-4-5',
    aliases: ['claude-sonnet-4-5-20250929'],
    displayName: 'Claude Sonnet 4.5',
    inputUsdPerMtok: 3,
    outputUsdPerMtok: 15,
    cacheWrite5mUsdPerMtok: 3.75,
    cacheWrite1hUsdPerMtok: 6,
    cacheReadUsdPerMtok: 0.3,
  },
  {
    model: 'claude-sonnet-4',
    aliases: [],
    displayName: 'Claude Sonnet 4',
    inputUsdPerMtok: 3,
    outputUsdPerMtok: 15,
    cacheWrite5mUsdPerMtok: 3.75,
    cacheWrite1hUsdPerMtok: 6,
    cacheReadUsdPerMtok: 0.3,
  },
  {
    model: 'claude-haiku-4-5',
    aliases: ['claude-haiku-4-5-20251001'],
    displayName: 'Claude Haiku 4.5',
    inputUsdPerMtok: 1,
    outputUsdPerMtok: 5,
    cacheWrite5mUsdPerMtok: 1.25,
    cacheWrite1hUsdPerMtok: 2,
    cacheReadUsdPerMtok: 0.1,
  },
  {
    model: 'claude-haiku-3-5',
    aliases: [],
    displayName: 'Claude Haiku 3.5',
    inputUsdPerMtok: 0.8,
    outputUsdPerMtok: 4,
    cacheWrite5mUsdPerMtok: 1,
    cacheWrite1hUsdPerMtok: 1.6,
    cacheReadUsdPerMtok: 0.08,
  },
] as const satisfies readonly AnthropicModelPricingRow[];

const MODEL_PRICING_BY_ID = new Map<string, AnthropicModelPricingRow>(
  ANTHROPIC_MODEL_PRICING.flatMap((row): Array<[string, AnthropicModelPricingRow]> => [
    [row.model, row],
    ...row.aliases.map((alias): [string, AnthropicModelPricingRow] => [alias, row]),
  ]),
);

export function resolveAnthropicModelPricing(
  model: string | null | undefined,
): AnthropicModelPricingRow | null {
  const key = (model || '').trim();
  if (!key) return null;
  return MODEL_PRICING_BY_ID.get(key) ?? null;
}
