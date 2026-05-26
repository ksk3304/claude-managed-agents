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
  - `forceFreshSession`
  - `chat_thread_session` key
  - attached skill時の agent-cache 経路
- `src/lib/memory-attach.ts`
  - AgentMail inbound はDM scopeだが、mail skill一般を固定DM扱いしない
- `src/queue/chat-event-handler.ts`
  - mail intent検出と fresh session 化
  - mail skill attach
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
