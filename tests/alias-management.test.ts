/**
 * Tests for `src/cli/alias-management.ts` (= Python `cma_gchat_send.py` の
 * `append_alias_atomic` / `validate_aliases_file` の TS port)。
 *
 * 4 ケース:
 *   1. 追加 (新規 alias を追記し file 内容を検証)
 *   2. 重複拒否 (同じ space_id は既存 alias 再利用 / 同じ alias 名は suffix 採番)
 *   3. 不正 format (validate が `spaces/` 始まりでない値を検出)
 *   4. validate (健全な台帳が OK を返す)
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  appendAliasAtomic,
  validateAliasesFile,
  loadAliases,
} from "../src/cli/alias-management";

// 各テストで使う一時 file。並列衝突しないよう PID + random で隔離。
let tmpDir: string;
let aliasesPath: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "alias-mgmt-test-"));
  aliasesPath = path.join(tmpDir, "cma_gchat_aliases.json");
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("appendAliasAtomic", () => {
  it("ケース 1: 新規 alias を追加して file を作成", async () => {
    // 開始時点: file 不在
    await expect(fs.access(aliasesPath)).rejects.toThrow();

    const result = await appendAliasAtomic("瀬戸DM", "spaces/AAA", aliasesPath);

    expect(result.finalAlias).toBe("瀬戸DM");
    expect(result.reusedExisting).toBe(false);

    // 実 file を読んで検証
    const loaded = await loadAliases(aliasesPath);
    expect(loaded).toEqual({ "瀬戸DM": "spaces/AAA" });

    // 末尾改行 + indent=2 で書かれていること (Python と format 合わせ)
    const raw = await fs.readFile(aliasesPath, "utf-8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(raw).toContain('  "瀬戸DM"'); // indent=2
  });

  it("ケース 2: 同 space_id 再利用 + 同 alias 名衝突は suffix 採番", async () => {
    // 事前に 1 件登録
    await appendAliasAtomic("瀬戸DM", "spaces/AAA", aliasesPath);

    // 2-a: 同 space_id を別名で追加しようとすると既存 alias を返す (write skip)
    const reuse = await appendAliasAtomic("別名", "spaces/AAA", aliasesPath);
    expect(reuse.finalAlias).toBe("瀬戸DM");
    expect(reuse.reusedExisting).toBe(true);

    // file 内容は変わってない
    let loaded = await loadAliases(aliasesPath);
    expect(loaded).toEqual({ "瀬戸DM": "spaces/AAA" });

    // 2-b: 同じ alias 名 + 別 space_id → suffix `_2` で採番
    const suffix = await appendAliasAtomic("瀬戸DM", "spaces/BBB", aliasesPath);
    expect(suffix.finalAlias).toBe("瀬戸DM_2");
    expect(suffix.reusedExisting).toBe(false);

    loaded = await loadAliases(aliasesPath);
    expect(loaded).toEqual({ "瀬戸DM": "spaces/AAA", "瀬戸DM_2": "spaces/BBB" });

    // 2-c: さらに同名 + 別 space_id → `_3`
    const suffix3 = await appendAliasAtomic("瀬戸DM", "spaces/CCC", aliasesPath);
    expect(suffix3.finalAlias).toBe("瀬戸DM_3");

    loaded = await loadAliases(aliasesPath);
    expect(loaded["瀬戸DM_3"]).toBe("spaces/CCC");
  });

  it("predicate: 不正引数を拒否 (空 alias / 予約 key / 非 spaces/ 値)", async () => {
    await expect(appendAliasAtomic("", "spaces/AAA", aliasesPath)).rejects.toThrow(
      /空文字不可/,
    );
    await expect(appendAliasAtomic("_comment", "spaces/AAA", aliasesPath)).rejects.toThrow(
      /予約済み/,
    );
    await expect(appendAliasAtomic("瀬戸", "AAA", aliasesPath)).rejects.toThrow(
      "spaces/...' 形式である必要がある",
    );
  });

  it("予約 key (_comment) を持つ既存 file を壊さない", async () => {
    // template と同じ形 (Python `cma_gchat_aliases.example.json` 互換)
    const initial = {
      _comment: "このファイルは alias 台帳。`spaces/...` 形式で書く。",
      既存: "spaces/EXISTING",
    };
    await fs.writeFile(aliasesPath, JSON.stringify(initial, null, 2) + "\n", "utf-8");

    const r = await appendAliasAtomic("新規", "spaces/NEW", aliasesPath);
    expect(r.finalAlias).toBe("新規");
    expect(r.reusedExisting).toBe(false);

    const loaded = await loadAliases(aliasesPath);
    expect(loaded).toEqual({
      _comment: initial._comment,
      既存: "spaces/EXISTING",
      新規: "spaces/NEW",
    });
  });
});

describe("validateAliasesFile", () => {
  it("ケース 3: 不正 format を検出 (値が spaces/ で始まらない)", async () => {
    // 手で broken file を書く
    await fs.writeFile(
      aliasesPath,
      JSON.stringify({ 瀬戸DM: "INVALID_NO_PREFIX" }, null, 2),
      "utf-8",
    );

    const r = await validateAliasesFile(aliasesPath);
    expect(r.ok).toBe(false);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatch(/瀬戸DM/);
    expect(r.errors[0]).toContain("'spaces/...' 形式でない");
  });

  it("ケース 4: 健全な台帳は OK を返す (予約 key 混在 + 複数 alias)", async () => {
    const ok = {
      _comment: "テンプレ comment",
      瀬戸DM: "spaces/AAA",
      IT開発: "spaces/BBB",
    };
    await fs.writeFile(aliasesPath, JSON.stringify(ok, null, 2) + "\n", "utf-8");

    const r = await validateAliasesFile(aliasesPath);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("file 不在は空 dict 扱いで OK (Python と同じ)", async () => {
    const r = await validateAliasesFile(aliasesPath);
    expect(r.ok).toBe(true);
    expect(r.errors).toEqual([]);
  });

  it("JSON parse 失敗 / 非 object は NG", async () => {
    await fs.writeFile(aliasesPath, "{ broken json", "utf-8");
    let r = await validateAliasesFile(aliasesPath);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/JSON パース/);

    // 配列は object でない
    await fs.writeFile(aliasesPath, JSON.stringify(["a", "b"]), "utf-8");
    r = await validateAliasesFile(aliasesPath);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/JSON object である必要がある/);
  });

  it("重複 key は load 時点で reject", async () => {
    // JSON 標準は重複 key を後勝ち上書きするが本 CLI は fail-fast
    const raw = `{\n  "瀬戸DM": "spaces/AAA",\n  "瀬戸DM": "spaces/BBB"\n}\n`;
    await fs.writeFile(aliasesPath, raw, "utf-8");

    const r = await validateAliasesFile(aliasesPath);
    expect(r.ok).toBe(false);
    expect(r.errors[0]).toMatch(/重複定義/);
  });
});
