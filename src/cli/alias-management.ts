#!/usr/bin/env node
/**
 * CHAT_POST alias 台帳 (`src/data/cma_gchat_aliases.json`) を扱う CLI。
 *
 * Python `scripts/cma_gchat_send.py` の以下 2 関数の TS port:
 *  - `append_alias_atomic(alias, space_id)` → `add-alias` サブコマンド
 *  - `validate_aliases_file()` → `validate` サブコマンド
 *
 * Node.js 環境で動かす運用 CLI (Cloudflare Worker runtime ではなく、
 * `npx tsx src/cli/alias-management.ts <subcommand> ...` で起動)。
 * Worker 側 alias resolver (= follow-up) は同じ JSON file を bundle して
 * 読むため、書き込み破損を防ぐ atomic write (tmp + rename) を採用する。
 *
 * Usage:
 *   npx tsx src/cli/alias-management.ts add-alias --name "瀬戸DM" --space "spaces/AAA"
 *   npx tsx src/cli/alias-management.ts validate
 *
 * 終了コード:
 *   0  成功
 *   1  引数不正 / atomic write 失敗 / validate NG
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { fileURLToPath } from "node:url";

// -------------------------------------------------------------------------
// 定数 / 型
// -------------------------------------------------------------------------

/** 予約 key (JSON 内の comment 等)。alias として扱わない (Python `_RESERVED_ALIAS_KEYS`)。 */
const RESERVED_ALIAS_KEYS: ReadonlySet<string> = new Set(["_comment"]);

/** alias 台帳 JSON のデフォルト配置 (Python 側 `cma_gchat_aliases.json` の TS port)。
 *
 * 既知 #7 alias resolver subagent もここを bundle する想定 (= 単一正本)。
 */
const __dirname =
  typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>).__dirname
    ? ((globalThis as Record<string, unknown>).__dirname as string)
    : (() => {
        // ESM 環境: import.meta.url から導出
        try {
          const url = (globalThis as { __aliasModuleUrl?: string }).__aliasModuleUrl
            ?? (typeof import.meta !== "undefined" ? import.meta.url : undefined);
          if (url) {
            return path.dirname(fileURLToPath(url));
          }
        } catch {
          // fallthrough
        }
        return path.resolve(process.cwd(), "src/cli");
      })();

/** repo root からの src/data/cma_gchat_aliases.json. */
const DEFAULT_ALIASES_PATH = path.resolve(__dirname, "..", "data", "cma_gchat_aliases.json");

/** 1 つの alias 台帳 file を表す内部型。値は spaces/... 形式の string。 */
type AliasesMap = Record<string, string>;

/** validate_aliases_file が返す結果。OK/NG と人間向けメッセージ。 */
export interface ValidateResult {
  ok: boolean;
  /** NG の場合の理由 (1 行)。OK の場合は空配列。 */
  errors: string[];
}

/** add-alias の結果。採用された alias 名 (suffix が付くことあり)。 */
export interface AppendResult {
  /** 採用された alias 名 (重複時 `_2`, `_3` ... が付く)。 */
  finalAlias: string;
  /** 同じ space_id の既存 alias を再利用したか。true なら write 発生せず。 */
  reusedExisting: boolean;
}

// -------------------------------------------------------------------------
// alias map load (重複 key 検出 + 形式検査)
// -------------------------------------------------------------------------

/** JSON.parse の reviver で重複 key を検出する補助。
 *
 * 標準 JSON.parse は後勝ち上書きだが、Python `_no_duplicate_keys` と同様に
 * 「重複 key は壊れた台帳」として fail-fast したい。本実装では
 * JSON テキストを parse 前に正規表現で粗く検査する (key だけ取り出して
 * 重複検出) — string 値内の "key": が偽 hit する可能性は無視できない、
 * という制約のもとで「最大限の検出」を行う。完全な fail-fast には
 * stream parser が必要だが、運用上は手で alias を追加するだけなので
 * 軽量実装で足りる。
 */
function detectDuplicateKeys(jsonText: string): string[] {
  // top-level object のみ対象 (alias 台帳は flat object)。
  // value 内の network resource string ("spaces/...") には ":" が出ないが
  // 値が文字列で `"key":` を含むケースは検出 false-positive になる。
  // alias 台帳の値は `spaces/<id>` 形式のみなので発生しない想定。
  const re = /"((?:[^"\\]|\\.)*)"\s*:/g;
  const seen = new Set<string>();
  const dups: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(jsonText)) !== null) {
    const k = m[1];
    if (seen.has(k)) {
      dups.push(k);
    } else {
      seen.add(k);
    }
  }
  return dups;
}

/** alias 台帳 file を読み込む。
 *
 * - file 不在 → 空 dict (Python と同じ。新規 alias 追加経路のため)
 * - JSON parse error / 重複 key / 非 object → throw
 *
 * 予約 key (_comment 等) は除外せず保持する。
 */
export async function loadAliases(aliasesPath: string = DEFAULT_ALIASES_PATH): Promise<AliasesMap> {
  let text: string;
  try {
    text = await fs.readFile(aliasesPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw new Error(`${aliasesPath} の読み込みに失敗: ${(err as Error).message}`);
  }
  if (!text.trim()) {
    return {};
  }
  const dups = detectDuplicateKeys(text);
  if (dups.length > 0) {
    throw new Error(
      `aliases.json で alias '${dups[0]}' が重複定義されている (後勝ち上書きで既存運用が壊れる恐れ)`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${aliasesPath} の JSON パースに失敗: ${(err as Error).message}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${aliasesPath} は JSON object である必要がある (got ${typeof parsed})`);
  }
  // 値の型は次の検査 (validate / append) に委ねる。ここでは生 dict を返す。
  return parsed as AliasesMap;
}

/** 予約 key 判定。Python `_is_real_alias`. */
function isRealAlias(key: string): boolean {
  return key.length > 0 && !RESERVED_ALIAS_KEYS.has(key);
}

// -------------------------------------------------------------------------
// validate_aliases_file (TS port)
// -------------------------------------------------------------------------

/** alias 台帳の整合性検査。
 *
 * - 空 key
 * - 値が string でない / `spaces/` で始まらない
 *
 * 予約 key (_comment 等) は値検査スキップ。
 */
export async function validateAliasesFile(
  aliasesPath: string = DEFAULT_ALIASES_PATH,
): Promise<ValidateResult> {
  let aliases: AliasesMap;
  try {
    aliases = await loadAliases(aliasesPath);
  } catch (err) {
    return { ok: false, errors: [(err as Error).message] };
  }
  const errors: string[] = [];
  for (const [alias, value] of Object.entries(aliases)) {
    if (RESERVED_ALIAS_KEYS.has(alias)) {
      continue;
    }
    if (!alias) {
      errors.push("aliases.json: alias 名が空文字");
      continue;
    }
    if (typeof value !== "string" || !value.startsWith("spaces/")) {
      errors.push(
        `aliases.json: alias '${alias}' の値が 'spaces/...' 形式でない (got ${JSON.stringify(value)})`,
      );
    }
  }
  return { ok: errors.length === 0, errors };
}

// -------------------------------------------------------------------------
// append_alias_atomic (TS port)
// -------------------------------------------------------------------------

/** alias 台帳に (alias, space_id) を atomic に追記する。
 *
 * 重複検査 (予約 key は除外):
 *   - 同じ space_id が既登録 → 何もせず既存 alias を返す
 *   - alias 名が既存 alias と衝突 → `_2`, `_3`, ... を採番
 *
 * 既存の予約 key (_comment 等) はそのまま保持して再書き込みする。
 *
 * 並列 process からの同時書込みは fs.rename の atomic 性で部分破損を防ぐが、
 * 競合 write の最終結果は last-writer-wins になる (Python の thread lock 相当の
 * IPC lock は実装しない。CLI は通常人手 1 回起動なので過剰最適化を避けた)。
 */
export async function appendAliasAtomic(
  alias: string,
  spaceId: string,
  aliasesPath: string = DEFAULT_ALIASES_PATH,
): Promise<AppendResult> {
  if (!spaceId.startsWith("spaces/")) {
    throw new Error(`space_id は 'spaces/...' 形式である必要がある: ${JSON.stringify(spaceId)}`);
  }
  if (!alias) {
    throw new Error("alias は空文字不可");
  }
  if (RESERVED_ALIAS_KEYS.has(alias)) {
    throw new Error(`alias 名 ${JSON.stringify(alias)} は予約済みのため使用不可`);
  }

  const current = await loadAliases(aliasesPath);

  // 同 space_id が既登録なら既存 alias を尊重 (予約 key は除外)
  for (const [existingAlias, existingValue] of Object.entries(current)) {
    if (!isRealAlias(existingAlias)) continue;
    if (existingValue === spaceId) {
      return { finalAlias: existingAlias, reusedExisting: true };
    }
  }

  // alias 名重複 (予約 key 含む key set で衝突回避)
  let finalAlias = alias;
  if (finalAlias in current) {
    let counter = 2;
    while (`${alias}_${counter}` in current) {
      counter += 1;
    }
    finalAlias = `${alias}_${counter}`;
  }

  current[finalAlias] = spaceId;

  // atomic write: 同一ディレクトリの一時ファイルに書いて rename
  // (cross-device rename を避けるため必ず同じ dir に作る)
  const dir = path.dirname(aliasesPath);
  await fs.mkdir(dir, { recursive: true });

  // randomized filename で並列衝突を避ける
  const tmpName = `.cma_gchat_aliases.${process.pid}.${Date.now()}.${Math.random()
    .toString(36)
    .slice(2, 10)}.tmp`;
  const tmpPath = path.join(dir, tmpName);

  // Python: json.dump(current, f, ensure_ascii=False, indent=2) + 末尾改行
  const out = JSON.stringify(current, null, 2) + "\n";
  try {
    await fs.writeFile(tmpPath, out, { encoding: "utf-8" });
    await fs.rename(tmpPath, aliasesPath);
  } catch (err) {
    // 失敗時は tmp を掃除 (rename 後の失敗は無いが念のため)
    try {
      await fs.unlink(tmpPath);
    } catch {
      // tmp が既に rename 済 / 元々存在しない場合は無視
    }
    throw err;
  }

  return { finalAlias, reusedExisting: false };
}

// -------------------------------------------------------------------------
// CLI entry
// -------------------------------------------------------------------------

interface ParsedArgs {
  subcommand: "add-alias" | "validate" | "help";
  flags: Record<string, string>;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  if (argv.length === 0) {
    return { subcommand: "help", flags: {} };
  }
  const subRaw = argv[0];
  if (subRaw === "-h" || subRaw === "--help" || subRaw === "help") {
    return { subcommand: "help", flags: {} };
  }
  if (subRaw !== "add-alias" && subRaw !== "validate") {
    throw new Error(`unknown subcommand: ${subRaw} (use add-alias | validate | help)`);
  }
  const flags: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith("--")) {
      throw new Error(`unexpected positional argument: ${tok}`);
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`flag --${key} requires a value`);
    }
    flags[key] = next;
    i += 1;
  }
  return { subcommand: subRaw, flags };
}

function printHelp(): void {
  process.stdout.write(
    [
      "Usage:",
      "  npx tsx src/cli/alias-management.ts add-alias --name <alias> --space <spaces/XXX> [--file <path>]",
      "  npx tsx src/cli/alias-management.ts validate [--file <path>]",
      "",
      "Subcommands:",
      "  add-alias   新規 alias を台帳に追記 (atomic write、重複は suffix 採番)",
      "  validate    台帳 file の整合性検査 (空 key / 値形式 / 重複 key)",
      "",
      `デフォルト台帳: ${DEFAULT_ALIASES_PATH}`,
      "",
    ].join("\n"),
  );
}

export async function runCli(argv: readonly string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    printHelp();
    return 1;
  }

  if (parsed.subcommand === "help") {
    printHelp();
    return 0;
  }

  const aliasesPath = parsed.flags.file ?? DEFAULT_ALIASES_PATH;

  if (parsed.subcommand === "validate") {
    const r = await validateAliasesFile(aliasesPath);
    if (r.ok) {
      process.stdout.write(`OK: ${aliasesPath}\n`);
      return 0;
    }
    for (const e of r.errors) {
      process.stderr.write(`${e}\n`);
    }
    return 1;
  }

  // add-alias
  const name = parsed.flags.name;
  const space = parsed.flags.space;
  if (!name || !space) {
    process.stderr.write("error: add-alias requires --name and --space\n");
    printHelp();
    return 1;
  }
  try {
    const r = await appendAliasAtomic(name, space, aliasesPath);
    if (r.reusedExisting) {
      process.stdout.write(
        `reused: alias '${r.finalAlias}' は同じ space_id で既登録 (write skip)\n`,
      );
    } else {
      process.stdout.write(`added: '${r.finalAlias}' → ${space}\n`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    return 1;
  }
}

// CLI mode: 直接実行されたときのみ run。test から import した時は実行しない。
// ESM の `import.meta.url === pathToFileURL(process.argv[1])` で判定。
const isMain = (() => {
  try {
    if (typeof process === "undefined" || !process.argv[1]) return false;
    const argvUrl = new URL(`file://${path.resolve(process.argv[1])}`).href;
    return typeof import.meta !== "undefined" && import.meta.url === argvUrl;
  } catch {
    return false;
  }
})();

if (isMain) {
  runCli(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`fatal: ${(err as Error).message}\n`);
      process.exit(1);
    });
}

// テスト用に内部定数も export
export const __test__ = {
  RESERVED_ALIAS_KEYS,
  DEFAULT_ALIASES_PATH,
  detectDuplicateKeys,
  isRealAlias,
  tmpDirForTest: () => os.tmpdir(),
};
