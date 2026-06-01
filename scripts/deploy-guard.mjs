#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const REQUIRED_MARKERS = [
  {
    label: 'Issue #214 PDF preflight result event',
    marker: 'pdf_preflight_result',
    paths: ['src/queue/chat-event-handler.ts', 'tests/chat-event-handler.test.ts'],
  },
  {
    label: 'Issue #214 pending PDF approval key',
    marker: 'pendingPdfPreflightApprovalKey',
    paths: ['src/queue/chat-event-handler.ts'],
  },
];

export const PRODUCTION_BRANCHES = ['main', 'master'];

function readText(file) {
  return readFileSync(file, 'utf8');
}

function runGit(root, args, options = {}) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeoutMs ?? 30_000,
  }).trim();
}

function tryGit(root, args, fallback = '') {
  try {
    return runGit(root, args);
  } catch {
    return fallback;
  }
}

export function readDeployTarget(root) {
  const packageJson = JSON.parse(readText(path.join(root, 'package.json')));
  const wranglerPath = path.join(root, 'wrangler.jsonc');
  const wrangler = readText(wranglerPath);
  const workerName = wrangler.match(/^\s*"name"\s*:\s*"([^"]+)"/m)?.[1] ?? '(unknown)';
  return {
    packageName: packageJson.name ?? '(unknown)',
    packageVersion: packageJson.version ?? '(unknown)',
    workerName,
    wranglerPath,
  };
}

export function checkRequiredMarkers(root, requirements = REQUIRED_MARKERS) {
  return requirements.map((req) => {
    const matches = [];
    const missingPaths = [];
    for (const relPath of req.paths) {
      const absPath = path.join(root, relPath);
      if (!existsSync(absPath)) {
        missingPaths.push(relPath);
        continue;
      }
      if (readText(absPath).includes(req.marker)) {
        matches.push(relPath);
      }
    }
    return {
      ...req,
      ok: matches.length > 0,
      matches,
      missingPaths,
    };
  });
}

export function collectGitContext(root, options = {}) {
  const worktree = runGit(root, ['rev-parse', '--show-toplevel']);
  const branch = tryGit(root, ['branch', '--show-current'], '(detached HEAD)') || '(detached HEAD)';
  const head = runGit(root, ['rev-parse', 'HEAD']);
  const headShort = runGit(root, ['rev-parse', '--short=12', 'HEAD']);
  const status = runGit(root, ['status', '--porcelain']);
  const statusCount = status === '' ? 0 : status.split('\n').filter(Boolean).length;
  let upstream = tryGit(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!upstream) upstream = 'origin/main';

  let fetchError = '';
  if (options.fetchRemote !== false) {
    const remote = upstream.includes('/') ? upstream.split('/')[0] : 'origin';
    try {
      runGit(root, ['fetch', '--quiet', remote], { timeoutMs: 45_000 });
    } catch (err) {
      fetchError = err instanceof Error ? err.message : String(err);
    }
  }

  const upstreamSha = tryGit(root, ['rev-parse', upstream]);
  const upstreamShort = upstreamSha ? tryGit(root, ['rev-parse', '--short=12', upstream]) : '';
  let containsUpstream = false;
  let freshnessError = '';
  if (upstreamSha) {
    try {
      runGit(root, ['merge-base', '--is-ancestor', upstream, 'HEAD']);
      containsUpstream = true;
    } catch (err) {
      freshnessError = err instanceof Error ? err.message : String(err);
    }
  }

  return {
    worktree,
    branch,
    head,
    headShort,
    upstream,
    upstreamSha,
    upstreamShort,
    containsUpstream,
    fetchError,
    freshnessError,
    dirty: statusCount > 0,
    statusCount,
  };
}

export function evaluateBranchPolicy(git, env = process.env) {
  const githubRefName = env.GITHUB_REF_NAME || '';
  const effectiveBranch = git.branch === '(detached HEAD)' && githubRefName ? githubRefName : git.branch;
  const isProductionBranch = PRODUCTION_BRANCHES.includes(effectiveBranch);
  const overrideEnabled = env.DEPLOY_GUARD_ALLOW_NON_MAIN === '1';
  const overrideReason = (env.DEPLOY_GUARD_OVERRIDE_REASON || '').trim();
  const overrideAccepted = !isProductionBranch && overrideEnabled && overrideReason.length > 0;

  return {
    effectiveBranch,
    isProductionBranch,
    overrideEnabled,
    overrideReason,
    overrideAccepted,
    ok: isProductionBranch || overrideAccepted,
  };
}

export function evaluateDeployGuard(root, options = {}) {
  const target = readDeployTarget(root);
  const git = collectGitContext(root, options);
  const branchPolicy = evaluateBranchPolicy(git, options.env ?? process.env);
  const markerChecks = checkRequiredMarkers(root, options.requirements ?? REQUIRED_MARKERS);
  const failures = [];

  if (!branchPolicy.ok) {
    failures.push(
      `production deploys are allowed only from ${PRODUCTION_BRANCHES.join('/')} (current: ${branchPolicy.effectiveBranch}); merge via PR first`,
    );
  }
  if (git.fetchError) {
    failures.push(`could not refresh ${git.upstream}; branch freshness unknown`);
  }
  if (!git.upstreamSha) {
    failures.push(`upstream ref not found: ${git.upstream}`);
  } else if (!git.containsUpstream) {
    failures.push(`HEAD does not contain ${git.upstream} (${git.upstreamShort}); rebase/merge latest main before production deploy`);
  }
  for (const check of markerChecks) {
    if (!check.ok) {
      failures.push(`missing required marker "${check.marker}" (${check.label})`);
    }
  }

  return {
    ok: failures.length === 0,
    target,
    git,
    branchPolicy,
    markerChecks,
    failures,
  };
}

export function renderReport(result) {
  const lines = [];
  lines.push('[deploy-guard] Cloudflare Worker production deploy guard');
  lines.push(`[deploy-guard] worker=${result.target.workerName} package=${result.target.packageName}@${result.target.packageVersion}`);
  lines.push(`[deploy-guard] worktree=${result.git.worktree}`);
  lines.push(`[deploy-guard] branch=${result.git.branch} head=${result.git.headShort}`);
  if (result.branchPolicy) {
    lines.push(
      `[deploy-guard] deploy_branch=${result.branchPolicy.effectiveBranch}` +
        (result.branchPolicy.isProductionBranch ? ' (production)' : ' (non-production)'),
    );
    if (result.branchPolicy.overrideAccepted) {
      lines.push(`[deploy-guard] OVERRIDE non-main deploy allowed: ${result.branchPolicy.overrideReason}`);
    }
  }
  lines.push(
    `[deploy-guard] upstream=${result.git.upstream}` +
      (result.git.upstreamShort ? `@${result.git.upstreamShort}` : '@(missing)'),
  );
  lines.push(
    `[deploy-guard] working_tree=${result.git.dirty ? `dirty(${result.git.statusCount})` : 'clean'}`,
  );
  if (result.git.dirty) {
    lines.push('[deploy-guard] note: dirty working trees are reported because prebuild may patch wrangler.jsonc; marker/freshness checks remain authoritative');
  }
  if (result.git.containsUpstream) {
    lines.push(`[deploy-guard] OK branch contains ${result.git.upstream}`);
  }
  if (result.branchPolicy?.isProductionBranch) {
    lines.push(`[deploy-guard] OK production branch: ${result.branchPolicy.effectiveBranch}`);
  }
  for (const check of result.markerChecks) {
    if (check.ok) {
      lines.push(`[deploy-guard] OK ${check.label}: ${check.matches.join(', ')}`);
    } else {
      lines.push(`[deploy-guard] BLOCK ${check.label}: marker "${check.marker}" not found`);
    }
  }
  if (result.ok) {
    lines.push('[deploy-guard] PASS production deploy allowed');
  } else {
    lines.push('[deploy-guard] BLOCKED production deploy refused');
    for (const failure of result.failures) {
      lines.push(`[deploy-guard] - ${failure}`);
    }
  }
  return lines.join('\n');
}

function main() {
  const root = process.cwd();
  const noFetch = process.env.DEPLOY_GUARD_SKIP_FETCH === '1' || process.argv.includes('--no-fetch');
  const result = evaluateDeployGuard(root, { fetchRemote: !noFetch });
  const output = renderReport(result);
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${output}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
