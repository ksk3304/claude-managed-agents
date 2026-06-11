import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const SRC_ROOT = join(process.cwd(), 'src');

const INBOX_LIST_OWNER = 'src/lib/agentmail-api.ts';
const INCLUDE_SPAM_OWNERS = new Set([
  INBOX_LIST_OWNER,
  'src/lib/makoto-capability-registry.ts',
  'src/tools/agentmail-read.ts',
  'src/data/tools-spec.ts',
]);

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) return tsFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function numberedOffenders(
  file: string,
  predicate: (line: string) => boolean,
): Array<{ lineNo: number; line: string }> {
  return readFileSync(file, 'utf8')
    .split('\n')
    .flatMap((line, index) => (predicate(line) ? [{ lineNo: index + 1, line: line.trim() }] : []));
}

describe('AgentMail read path guard', () => {
  it('keeps inbox message listing centralized in AgentMailClient.listMessages', () => {
    const offenders = tsFiles(SRC_ROOT).flatMap((file) => {
      const rel = relative(process.cwd(), file);
      if (rel === INBOX_LIST_OWNER) return [];

      return numberedOffenders(file, (line) => {
        if (!line.includes('/inboxes/') || !line.includes('/messages')) return false;
        if (line.includes('/messages/send')) return false;
        if (line.includes('/reply')) return false;
        if (line.includes('/threads/')) return false;
        return true;
      }).map(({ lineNo, line }) => `${rel}:${lineNo}: ${line}`);
    });

    expect(offenders).toEqual([]);
  });

  it('keeps include_spam query ownership with the shared read path', () => {
    const offenders = tsFiles(SRC_ROOT).flatMap((file) => {
      const rel = relative(process.cwd(), file);
      if (INCLUDE_SPAM_OWNERS.has(rel)) return [];

      return numberedOffenders(file, (line) => line.includes('include_spam')).map(
        ({ lineNo, line }) => `${rel}:${lineNo}: ${line}`,
      );
    });

    expect(offenders).toEqual([]);
  });
});
