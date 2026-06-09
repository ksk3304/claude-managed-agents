#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = new Set(process.argv.slice(2));
const yes = args.has('--yes');
const dryRun = args.has('--dry-run') || !yes;
const migrate = args.has('--migrate');
const phaseArg = process.argv.find((arg) => arg.startsWith('--phase='));
const phase = phaseArg ? phaseArg.slice('--phase='.length) : 'base';

function run(command, commandArgs, options = {}) {
  const rendered = [command, ...commandArgs].join(' ');
  console.log(`[staging-deploy] ${rendered}`);
  if (options.skip) return;
  execFileSync(command, commandArgs, {
    cwd: repoRoot,
    stdio: 'inherit',
    env: { ...process.env, CI: process.env.CI ?? '1' },
  });
}

run('node', ['scripts/check-staging-safety.mjs', `--phase=${phase}`]);
run('npm', ['run', 'build']);

if (dryRun) {
  console.log('[staging-deploy] dry-run: wrangler deploy not executed; pass --yes to deploy env.staging');
  if (migrate) {
    console.log('[staging-deploy] dry-run: D1 remote migration not executed');
  }
  process.exit(0);
}

run('npx', ['wrangler', 'deploy', '--env', 'staging', '--strict']);

if (migrate) {
  run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'DB', '--env', 'staging', '--remote']);
} else {
  console.log('[staging-deploy] D1 remote migration skipped; pass --migrate --yes only when state change is approved');
}
