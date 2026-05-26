-- ============================================================================
-- MAKOTO Phase 2 — agent_cache table (TS port of Cloud Run
-- cma_agent_cache Firestore document).
--
-- Cloud Run の `scripts/cma_lib.py:_load_agent_cache` / `_save_agent_cache_entry`
-- (Issue #184 で導入) は Firestore document `cma_agent_cache/lifelog-cma` の
-- `cache` map field に per-key `set(merge=True)` で agent_id / environment_id /
-- tools_hash / skills_hash を永続化している。Cloud Run コンテナの local FS は
-- restart で消えるため、永続化なしでは cold start ごとに `agents.create` が
-- 走り、Anthropic 側に重複 agent が累積する (実測: 5/22=7回, 5/18=12回)。
--
-- Cloudflare Worker (TS) port では Firestore が使えないため、同じ責務を D1
-- (Cloudflare の SQLite) で実装する。row 単位 `INSERT OR REPLACE` で
-- atomic 書込みし、複数 worker instance 間で agent_id を共有する。
-- D1 がダウンしている場合は KV (`agent_cache:<key>` キー) に fallback する
-- (`src/lib/agent-cache.ts` の loadAgentCacheEntry / saveAgentCacheEntry が
-- 順序付け実装)。
--
-- Schema 設計:
--   - PRIMARY KEY: cache_key (= `${agent_name}::${environment_name}::tools-
--     ${tools_hash}::skills-${skills_hash}` — Python cache key と同形式)
--   - user_slug: 将来の per-user agent rotate / multi-tenant 対応のための
--     列。現状は 'default' (= Python の `lifelog-cma` 相当) で埋めるが、
--     #186 follow-up で per-user mapping が入った時に活きる
--   - agent_id / environment_id: Anthropic API が返す ID
--   - memory_store_id: Phase 2 で各 agent に attach 済 memory store の ID
--     (cma_lib.py legacy local cache が memory entries も同 file に保存
--     している部分の TS 側受け皿。現状 NULL 許容で未使用カラム)
--   - tools_hash / skills_hash: cache key にも含まれるが、index / debug 用に
--     別カラム保持。Python の new_entry と同じ形
--   - updated_at_ms: epoch ms。最終書込み時刻 (Python は SERVER_TIMESTAMP)
--
-- Apply timing: Phase 2 #186 で worker code が agent-cache.ts を import した
-- 時点で apply。`wrangler d1 migrations apply DB --remote` で本番反映。
--
-- Rollback: DROP TABLE IF EXISTS agent_cache で行データ消失。worker は KV
-- fallback で継続するため致命ではないが、cold start で全 user agent 再作成
-- される (Anthropic 側に重複 agent 残置、不可視のコスト累積)。
--
-- Issue: ksk3304/makoto-prime#186 (Phase 2 L)
-- Source: scripts/cma_lib.py l.305-595 (#184 で Firestore 化された agent cache)
-- ============================================================================

CREATE TABLE IF NOT EXISTS agent_cache (
    cache_key         TEXT PRIMARY KEY,
    user_slug         TEXT NOT NULL DEFAULT 'default',
    agent_id          TEXT NOT NULL,
    environment_id    TEXT NOT NULL,
    memory_store_id   TEXT,
    tools_hash        TEXT NOT NULL,
    skills_hash       TEXT NOT NULL,
    updated_at_ms     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_agent_cache_user
    ON agent_cache (user_slug, updated_at_ms DESC);
