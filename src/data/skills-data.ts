import type { SkillsData } from '../lib/intent-detector';

/**
 * Slash command skill registry bundled into the Worker.
 *
 * Full Cloud Run `cma_skills.json` also contains long system prompts/templates.
 * For Phase 2 runtime, this registry covers deterministic `/help` output and
 * minimal slash dispatch metadata. Natural-language mail/schedule intent is
 * handled separately by `intent-detector.ts`.
 */
export const SLASH_SKILLS_DATA: SkillsData = {
  skills: {
    '/調査': {
      name: '調査',
      description: 'テーマを渡すと構造化された調査レポートを返す',
      template: '以下のテーマについて調査してください。\n\nテーマ: {query}',
    },
    '/mail': {
      name: 'メール送信',
      description: '自然言語でメールを送信',
      attach_memory: false,
      template: '以下の依頼に従いメールを送信してください。\n\n依頼: {query}',
    },
    '/schedule': {
      name: '定期実行ジョブ管理',
      description: 'ジョブの登録・停止・再開・削除・一覧・即時実行',
      attach_memory: false,
      template: '以下の依頼に従い定期実行ジョブを操作してください。\n\n依頼: {query}',
    },
    '/costguard': {
      name: 'Cost Guard',
      description: '予算ガード状態確認。/costguard または /costguard status',
    },
    '/help': {
      name: 'ヘルプ',
      description: '利用可能なスキル一覧を表示',
    },
  },
};
