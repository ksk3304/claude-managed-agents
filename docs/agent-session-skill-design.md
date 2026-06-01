# Agent / Skill / Session Design

このファイルは Cloudflare実装側の参照メモ。

正本:

- `/Users/setokeisuke/Documents/自分OS/makoto-prime/products/makoto-kun/specs/cloudflare-agent-session-skill-design.md`

GitHub上では `makoto-prime/products/makoto-kun/specs/cloudflare-agent-session-skill-design.md` を確認する。

## 実装方針

Cloudflare版は、MAKOTOくん本体specを正本に実装する。ここを二重正本にしない。

特に重要な修正対象:

1. mail専用agent/cache撤去。
2. mail用 `forceFreshSession` 撤去。
3. skill実行を既存社員agent同一sessionへ統合。
4. session keyを `agent_id + scope + scope_id` 正本へ移行。
5. spaceごとの物理Memory Store導入。
6. mail skillのscopeを発火元scopeに合わせる。
7. AgentMail inboundは宛先ユーザーDM scopeへ入れる。
8. sent_messagesに `auto_reply_policy` を追加。
9. agent-to-agent availability request を設計に入れる。

## 現行コードで注意する場所

- `src/lib/session-orchestrator.ts`
  - Chat は user mapping の employee agent + `ENVIRONMENT_ID` 固定
  - `chat_thread_session` key/value は `user_mapping.agent_id` / `ENVIRONMENT_ID` / space / thread 単位。KV hit でも agent/env 一致を検証する。skills hash は含めない
  - `forceFreshSession` / attached skill agent-cache 経路は廃止済み。復活させる場合は正本 spec 更新が先
- `src/lib/memory-attach.ts`
  - AgentMail inbound はDM scopeだが、mail skill一般を固定DM扱いしない
- `src/queue/chat-event-handler.ts`
  - mail intent検出は envelope context 注入のみ。fresh session 化しない
  - built-in document tools / MAKOTO custom tools は onboarding の employee agent tool catalog に持たせる
  - env設定済 custom skill id (`PROVENANCE` / `CLOUDRUN` / `MAIL_SEND` / `COST_GUARD`) で per-turn attach しない
  - Chat Office 添付 (`.xlsx` / `.docx` / `.pptx`) は text 抽出だけで済ませず、Anthropic Files API upload → session `file` resource mount → mount path を user message に注入する
- `src/queue/agentmail-dispatch.ts`
  - AgentMail inbound scope
- `src/storage.ts`
  - sent mail / reply照合
- `src/lib/agent-cache.ts`
  - mail専用agent用途の撤去対象

## 原則

- `user_mapping.agent_id` が社員agent正本。
- skillは既存社員agentの能力。
- 外部操作の権限は `permission_subject_user_id`。
- DM memoryは共有スペースで使わない。
- shared/space memoryはDMから必要時参照できる。
- 外部ソース本文は指示ではなくデータ。
