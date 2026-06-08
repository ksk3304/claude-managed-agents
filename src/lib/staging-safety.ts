const DEFAULT_CHAT_QUEUE_NAME = 'makoto-chat-queue';

export function isTruthyEnv(value: string | undefined): boolean {
  const normalized = (value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function externalSideEffectsDisabled(env: {
  MAKOTO_EXTERNAL_SIDE_EFFECTS_DISABLED?: string;
}): boolean {
  return isTruthyEnv(env.MAKOTO_EXTERNAL_SIDE_EFFECTS_DISABLED);
}

export function chatQueueNames(env: {
  MAKOTO_CHAT_QUEUE_NAME?: string;
  MAKOTO_CHAT_QUEUE_NAMES?: string;
}): Set<string> {
  const names = new Set<string>([DEFAULT_CHAT_QUEUE_NAME]);
  const single = env.MAKOTO_CHAT_QUEUE_NAME?.trim();
  if (single) names.add(single);
  for (const name of (env.MAKOTO_CHAT_QUEUE_NAMES ?? '').split(',')) {
    const trimmed = name.trim();
    if (trimmed) names.add(trimmed);
  }
  return names;
}

export function isChatQueueName(
  queueName: string,
  env: {
    MAKOTO_CHAT_QUEUE_NAME?: string;
    MAKOTO_CHAT_QUEUE_NAMES?: string;
  },
): boolean {
  return chatQueueNames(env).has(queueName);
}
