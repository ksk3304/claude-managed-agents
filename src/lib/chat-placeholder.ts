import { ChatApiError, postChatMessage } from './chat-api';
import { executeWithCommit } from './three-stage-precheck';
import { recordRuntimeEvent } from './observability';

export const PLACEHOLDER_TEXT = '... MAKOTOくんが入力中';

export interface PostedChatPlaceholder {
  name: string;
  threadName?: string;
}

export interface PostChatPlaceholderParams {
  spaceName: string;
  threadName: string | null;
  eventKey: string;
  messageId?: string | null;
  claim: { owner: string; version: number };
  source: string;
}

export async function postChatPlaceholder(
  env: Env,
  params: PostChatPlaceholderParams,
): Promise<string> {
  const result = await postChatPlaceholderResult(env, params);
  return result?.name ?? '';
}

export async function postChatPlaceholderResult(
  env: Env,
  params: PostChatPlaceholderParams,
): Promise<PostedChatPlaceholder | null> {
  const saKey = env.CHAT_SA_KEY_JSON;
  if (!saKey) {
    console.warn(
      `[${params.source}] placeholder POST skipped eventKey=${params.eventKey} CHAT_SA_KEY_JSON missing`,
    );
    return null;
  }
  if (!params.spaceName) {
    console.warn(
      `[${params.source}] placeholder POST skipped eventKey=${params.eventKey} empty space`,
    );
    return null;
  }
  try {
    const outcome = await executeWithCommit({
      env,
      parentEventKey: params.eventKey,
      parentOwner: params.claim.owner,
      kind: 'placeholder',
      target: `${params.spaceName}:${params.threadName ?? ''}`,
      sendFn: async () =>
        await postChatMessage(
          { saKeyJson: saKey },
          params.spaceName,
          PLACEHOLDER_TEXT,
          params.threadName
            ? {
                threadName: params.threadName,
                threadFallback: 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD',
              }
            : {},
        ),
    });
    if (outcome.outcome === 'sent') {
      await recordRuntimeEvent(env, {
        eventKey: params.eventKey,
        messageId: params.messageId ?? null,
        eventType: 'chat_placeholder_posted',
        source: params.source,
        detail: { placeholder_name_present: Boolean(outcome.result.name) },
      });
      const result: PostedChatPlaceholder = { name: outcome.result.name };
      if (outcome.result.threadName) result.threadName = outcome.result.threadName;
      return result;
    }
    if (outcome.outcome === 'already') {
      console.log(
        `[${params.source}] placeholder POST already sent eventKey=${params.eventKey} space=${params.spaceName} - skipping`,
      );
      await recordRuntimeEvent(env, {
        eventKey: params.eventKey,
        messageId: params.messageId ?? null,
        eventType: 'chat_placeholder_duplicate',
        source: params.source,
        detail: { outcome: outcome.outcome },
      });
      return null;
    }
    if (outcome.outcome === 'lease_alive') {
      console.warn(
        `[${params.source}] placeholder POST in-flight by another worker eventKey=${params.eventKey} space=${params.spaceName}`,
      );
      return null;
    }
    console.warn(
      `[${params.source}] placeholder POST lease lost eventKey=${params.eventKey} space=${params.spaceName}`,
    );
    return null;
  } catch (err) {
    const reason =
      err instanceof ChatApiError
        ? `chat_api_${err.status}`
        : err instanceof Error
          ? err.message
          : String(err);
    console.warn(
      `[${params.source}] placeholder POST fail eventKey=${params.eventKey} space=${params.spaceName}: ${reason}`,
    );
    await recordRuntimeEvent(env, {
      eventKey: params.eventKey,
      messageId: params.messageId ?? null,
      eventType: 'chat_placeholder_failed',
      level: 'warn',
      source: params.source,
      detail: { reason },
    });
    return null;
  }
}
