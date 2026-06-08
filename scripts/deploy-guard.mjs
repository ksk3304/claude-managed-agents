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
export const MUST_PRESERVE_FILE = 'deploy-must-preserve.json';
export const ACTIVE_CHAT_TURN_LIMIT = 5;
export const DEFAULT_BLOCKED_LABELS = ['no-prod-deploy', 'no-deploy', 'poc', 'proof-of-concept'];

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

function isHexCommit(value) {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

function shortCommit(value) {
  return value.slice(0, 12);
}

function splitCommitList(value = '') {
  return value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeCommitEntry(entry) {
  if (typeof entry === 'string') return { commit: entry, issue: '', pr: '', reason: '' };
  return {
    commit: String(entry?.commit ?? ''),
    issue: String(entry?.issue ?? ''),
    pr: String(entry?.pr ?? ''),
    reason: String(entry?.reason ?? ''),
  };
}

function normalizeLabel(value) {
  return String(value ?? '').trim().toLowerCase();
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

export function extractCfRepoCommit(message = '') {
  return message.match(/(?:^|\s)cf-repo=([0-9a-f]{7,40})(?:\s|$)/i)?.[1] ?? '';
}

function annotationMessage(item) {
  return (
    item?.annotations?.['workers/message'] ??
    item?.annotations?.workers_message ??
    item?.message ??
    ''
  );
}

function deploymentVersionIds(deployment) {
  if (!Array.isArray(deployment?.versions)) return [];
  return deployment.versions
    .map((version) => version?.version_id ?? version?.id ?? '')
    .filter(Boolean);
}

function deploymentMessage(deployment, versionsById = new Map()) {
  const ownMessage = annotationMessage(deployment);
  if (ownMessage) return ownMessage;

  for (const versionId of deploymentVersionIds(deployment)) {
    const versionMessage = annotationMessage(versionsById.get(versionId));
    if (versionMessage) return versionMessage;
  }
  return '';
}

function deploymentCreatedAt(deployment) {
  const value = deployment?.created_on ?? deployment?.createdAt ?? deployment?.created_at ?? '';
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : 0;
}

function versionMap(versions) {
  const byId = new Map();
  if (!Array.isArray(versions)) return byId;
  for (const version of versions) {
    if (version?.id) byId.set(version.id, version);
  }
  return byId;
}

function readD1DatabaseName(root) {
  const wranglerPath = path.join(root, 'wrangler.jsonc');
  if (!existsSync(wranglerPath)) return 'DB';
  const wrangler = readText(wranglerPath);
  return wrangler.match(/^\s*"database_name"\s*:\s*"([^"]+)"/m)?.[1] ?? 'DB';
}

export function activeChatTurnSql(nowMs, limit = ACTIVE_CHAT_TURN_LIMIT) {
  const safeNowMs = Number.isFinite(nowMs) ? Math.max(0, Math.floor(nowMs)) : Date.now();
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit)));
  return [
    'SELECT event_key, claim_owner, lease_version, lease_expires_at_ms, committed_at_ms',
    'FROM dedupe',
    "WHERE event_key LIKE 'chat_turn_processing:chat:%'",
    `AND COALESCE(lease_expires_at_ms, 0) > ${safeNowMs}`,
    'AND committed_at_ms IS NULL',
    'ORDER BY lease_expires_at_ms DESC',
    `LIMIT ${safeLimit}`,
  ].join(' ');
}

function rowsFromD1Json(raw) {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  const first = parsed[0];
  return Array.isArray(first?.results) ? first.results : [];
}

export function collectActiveChatTurnGuard(root, options = {}) {
  const env = options.env ?? process.env;
  const nowMs = options.nowMs ?? Date.now();
  const overrideEnabled = env.DEPLOY_GUARD_SKIP_ACTIVE_CHAT_TURN_CHECK === '1';
  const overrideReason = (env.DEPLOY_GUARD_ACTIVE_CHAT_TURN_REASON || '').trim();
  const overrideAccepted = overrideEnabled && overrideReason.length > 0;
  const usingFixture =
    options.activeChatTurns ||
    options.activeChatTurnsJson ||
    options.activeChatTurnsError ||
    options.deployments ||
    options.deploymentsJson;
  let rows = [];
  let readbackError = '';
  let source = usingFixture ? 'fixture' : 'cloudflare-d1';

  if (options.activeChatTurns) {
    rows = options.activeChatTurns;
  } else if (options.activeChatTurnsJson) {
    try {
      rows = rowsFromD1Json(options.activeChatTurnsJson);
    } catch (err) {
      readbackError = err instanceof Error ? err.message : String(err);
    }
  } else if (options.activeChatTurnsError) {
    readbackError = options.activeChatTurnsError;
  } else if (!usingFixture) {
    try {
      const raw = execFileSync(
        'npx',
        [
          'wrangler',
          'd1',
          'execute',
          readD1DatabaseName(root),
          '--remote',
          '--json',
          '--command',
          activeChatTurnSql(nowMs, options.activeChatTurnLimit ?? ACTIVE_CHAT_TURN_LIMIT),
        ],
        {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: options.cloudflareTimeoutMs ?? 30_000,
        },
      );
      rows = rowsFromD1Json(raw);
    } catch (err) {
      readbackError = err instanceof Error ? err.message : String(err);
    }
  }

  const active = rows
    .filter((row) => Number(row?.lease_expires_at_ms ?? 0) > nowMs && row?.committed_at_ms == null)
    .map((row) => ({
      eventKey: String(row.event_key ?? ''),
      leaseExpiresAtMs: Number(row.lease_expires_at_ms ?? 0),
      leaseVersion: Number(row.lease_version ?? 0),
      claimOwner: String(row.claim_owner ?? ''),
    }));
  const failures = [];
  if (readbackError && !overrideAccepted) {
    failures.push(`could not read active Chat turn leases from D1: ${readbackError}`);
  }
  if (active.length > 0 && !overrideAccepted) {
    failures.push(`active Chat turn processing leases exist (${active.length}); wait for completion or lease expiry before deploy`);
  }
  return {
    ok: failures.length === 0,
    source,
    nowMs,
    active,
    readbackError,
    overrideEnabled,
    overrideReason,
    overrideAccepted,
    failures,
  };
}

export function findEffectiveServingCommit(deployments, versions = []) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    return {
      ok: false,
      latestHadCfRepo: false,
      source: 'missing',
      commit: '',
      latestDeploymentId: '',
      codeDeploymentId: '',
    };
  }
  const versionsById = versionMap(versions);
  const ordered = [...deployments].sort((a, b) => deploymentCreatedAt(b) - deploymentCreatedAt(a));
  const latest = ordered[0];
  const latestCommit = extractCfRepoCommit(deploymentMessage(latest, versionsById));
  if (latestCommit) {
    return {
      ok: true,
      latestHadCfRepo: true,
      source: 'latest_deployment',
      commit: latestCommit,
      latestDeploymentId: latest?.id ?? '',
      codeDeploymentId: latest?.id ?? '',
    };
  }
  for (const deployment of ordered.slice(1)) {
    const commit = extractCfRepoCommit(deploymentMessage(deployment, versionsById));
    if (commit) {
      return {
        ok: true,
        latestHadCfRepo: false,
        source: 'previous_code_deployment',
        commit,
        latestDeploymentId: latest?.id ?? '',
        codeDeploymentId: deployment?.id ?? '',
      };
    }
  }
  return {
    ok: false,
    latestHadCfRepo: false,
    source: 'unmarked',
    commit: '',
    latestDeploymentId: latest?.id ?? '',
    codeDeploymentId: '',
  };
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
  const upstream = options.upstreamRef ?? process.env.DEPLOY_GUARD_UPSTREAM_REF ?? 'origin/main';

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

export function readMustPreserveCommits(root, env = process.env) {
  const commits = [];
  for (const commit of splitCommitList(env.DEPLOY_GUARD_MUST_PRESERVE_COMMITS || '')) {
    commits.push({ commit, source: 'env', issue: '', reason: 'DEPLOY_GUARD_MUST_PRESERVE_COMMITS' });
  }

  const ledgerPath = path.join(root, MUST_PRESERVE_FILE);
  if (!existsSync(ledgerPath)) return commits;

  const parsed = JSON.parse(readText(ledgerPath));
  const entries = Array.isArray(parsed) ? parsed : parsed.commits;
  if (!Array.isArray(entries)) return commits;

  for (const entry of entries) {
    const commit = typeof entry === 'string' ? entry : entry?.commit;
    if (!commit) continue;
    const status = typeof entry === 'string' ? 'active' : (entry.status ?? 'active');
    if (status === 'retired' || entry.active === false) continue;
    commits.push({
      commit,
      source: MUST_PRESERVE_FILE,
      issue: typeof entry === 'string' ? '' : (entry.issue ?? ''),
      reason: typeof entry === 'string' ? '' : (entry.reason ?? ''),
    });
  }
  return commits;
}

function commitIsAncestor(root, commit, descendant = 'HEAD') {
  if (!isHexCommit(commit)) {
    return { ok: false, error: `invalid commit marker: ${commit}` };
  }
  try {
    runGit(root, ['merge-base', '--is-ancestor', commit, descendant]);
    return { ok: true, error: '' };
  } catch (err) {
    const exists = tryGit(root, ['rev-parse', '--verify', `${commit}^{commit}`]);
    if (!exists) {
      return { ok: false, error: `commit not found locally: ${commit}` };
    }
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function revParseCommit(root, commit) {
  if (!commit) return '';
  return tryGit(root, ['rev-parse', '--verify', `${commit}^{commit}`]);
}

function commitsInRange(root, base, head = 'HEAD') {
  if (!base) return [];
  const raw = tryGit(root, ['rev-list', '--reverse', `${base}..${head}`]);
  return raw ? raw.split('\n').filter(Boolean) : [];
}

function commitMessage(root, commit) {
  return tryGit(root, ['log', '-1', '--format=%B', commit]);
}

export function readDeployManifest(root, options = {}) {
  const env = options.env ?? process.env;
  const manifestPath = options.manifestPath ?? env.DEPLOY_GUARD_MANIFEST ?? '';
  if (!manifestPath) {
    return {
      ok: false,
      required: true,
      path: '',
      manifest: null,
      failures: ['deploy manifest is required for production deploys; pass --manifest <path> or set DEPLOY_GUARD_MANIFEST'],
    };
  }

  const absPath = path.isAbsolute(manifestPath) ? manifestPath : path.join(root, manifestPath);
  try {
    const manifest = JSON.parse(readText(absPath));
    return {
      ok: true,
      required: true,
      path: absPath,
      manifest,
      failures: [],
    };
  } catch (err) {
    return {
      ok: false,
      required: true,
      path: absPath,
      manifest: null,
      failures: [`could not read deploy manifest ${absPath}: ${err instanceof Error ? err.message : String(err)}`],
    };
  }
}

function manifestCommitEntries(manifest, key) {
  return asArray(manifest?.[key]).map(normalizeCommitEntry).filter((entry) => entry.commit);
}

function manifestLabelsByCommit(manifest) {
  const map = new Map();
  for (const entry of asArray(manifest?.commit_labels)) {
    const commit = String(entry?.commit ?? '');
    if (!commit) continue;
    map.set(commit, asArray(entry?.labels).map(normalizeLabel).filter(Boolean));
  }
  return map;
}

function stateChangeSummary(manifest) {
  const state = manifest?.state_changes ?? {};
  return {
    secrets: asArray(state.secrets).length,
    vars: asArray(state.vars).length,
    d1Migrations: asArray(state.d1_migrations).length,
    kvWrites: asArray(state.kv_writes).length,
    queues: asArray(state.queues).length,
  };
}

export function collectDeployManifestGuard(root, git, servingLineage, options = {}) {
  const read = readDeployManifest(root, options);
  const failures = [...read.failures];
  const manifest = read.manifest;
  const range = [];
  const allowedCommits = new Set();
  const blockedCommits = [];
  const blockedLabels = [];
  const blockedMarkers = [];
  const mustPreserveChecks = [];
  const requiredFields = ['environment', 'issue', 'pr', 'serving_base_commit', 'rollback_target_commit', 'state_changes'];

  if (!manifest) {
    return {
      ok: false,
      path: read.path,
      manifest: null,
      range,
      allowedCommits: [],
      blockedCommits,
      blockedLabels,
      blockedMarkers,
      mustPreserveChecks,
      stateChanges: stateChangeSummary(null),
      failures,
    };
  }

  for (const field of requiredFields) {
    if (manifest[field] === undefined || manifest[field] === null || manifest[field] === '') {
      failures.push(`deploy manifest missing required field: ${field}`);
    }
  }
  if (manifest.environment && manifest.environment !== 'production') {
    failures.push(`deploy manifest environment must be production, got ${manifest.environment}`);
  }

  const servingBase = String(manifest.serving_base_commit ?? servingLineage?.effective?.commit ?? '');
  const rollbackTarget = String(manifest.rollback_target_commit ?? '');
  if (servingBase && !revParseCommit(root, servingBase)) {
    failures.push(`deploy manifest serving_base_commit not found locally: ${servingBase}`);
  }
  if (rollbackTarget && !revParseCommit(root, rollbackTarget)) {
    failures.push(`deploy manifest rollback_target_commit not found locally: ${rollbackTarget}`);
  }
  if (servingLineage?.effective?.commit && servingBase && shortCommit(servingLineage.effective.commit) !== shortCommit(revParseCommit(root, servingBase) || servingBase)) {
    failures.push(
      `deploy manifest serving_base_commit ${shortCommit(servingBase)} does not match current serving cf-repo ${shortCommit(servingLineage.effective.commit)}`,
    );
  }

  if (servingBase && revParseCommit(root, servingBase)) {
    range.push(...commitsInRange(root, servingBase, git.head));
  }

  for (const entry of manifestCommitEntries(manifest, 'allowed_commits')) {
    const resolved = revParseCommit(root, entry.commit);
    if (!resolved) {
      failures.push(`deploy manifest allowed commit not found locally: ${entry.commit}`);
    } else {
      allowedCommits.add(resolved);
    }
  }
  for (const commit of range) {
    if (!allowedCommits.has(commit)) {
      failures.push(`deploy range commit ${shortCommit(commit)} is not listed in deploy manifest allowed_commits`);
    }
  }

  for (const entry of manifestCommitEntries(manifest, 'blocked_commits')) {
    const resolved = revParseCommit(root, entry.commit);
    const inRange = resolved && range.includes(resolved);
    const check = { ...entry, commit: resolved || entry.commit, inRange };
    blockedCommits.push(check);
    if (inRange) {
      failures.push(`deploy range contains blocked commit ${shortCommit(check.commit)}${entry.reason ? ` (${entry.reason})` : ''}`);
    }
  }

  const labelsByCommit = manifestLabelsByCommit(manifest);
  const blockedLabelSet = new Set(
    uniqueStrings([
      ...DEFAULT_BLOCKED_LABELS,
      ...asArray(manifest.blocked_labels).map(normalizeLabel),
    ]),
  );
  for (const commit of range) {
    const labels = asArray(labelsByCommit.get(commit) ?? labelsByCommit.get(shortCommit(commit))).map(normalizeLabel);
    const matches = labels.filter((label) => blockedLabelSet.has(label));
    if (matches.length > 0) {
      const check = { commit, labels, matches };
      blockedLabels.push(check);
      failures.push(`deploy range commit ${shortCommit(commit)} has blocked label(s): ${matches.join(', ')}`);
    }
  }

  const markerList = asArray(manifest.blocked_markers).map(String).filter(Boolean);
  for (const commit of range) {
    const message = commitMessage(root, commit);
    const matches = markerList.filter((marker) => message.includes(marker));
    if (matches.length > 0) {
      const check = { commit, matches };
      blockedMarkers.push(check);
      failures.push(`deploy range commit ${shortCommit(commit)} contains blocked marker(s): ${matches.join(', ')}`);
    }
  }

  for (const entry of manifestCommitEntries(manifest, 'must_preserve_commits')) {
    const check = commitIsAncestor(root, entry.commit, git.head);
    const result = { ...entry, ok: check.ok, error: check.error };
    mustPreserveChecks.push(result);
    if (!check.ok) {
      const detail = [entry.issue, entry.reason].filter(Boolean).join(' ');
      failures.push(
        `deploy manifest must-preserve commit ${shortCommit(entry.commit)} is not contained in HEAD` +
          (detail ? ` (${detail})` : ''),
      );
    }
  }

  return {
    ok: failures.length === 0,
    path: read.path,
    manifest,
    range,
    allowedCommits: [...allowedCommits],
    blockedCommits,
    blockedLabels,
    blockedMarkers,
    mustPreserveChecks,
    stateChanges: stateChangeSummary(manifest),
    failures,
  };
}

export function collectServingLineage(root, target, options = {}) {
  const env = options.env ?? process.env;
  let deployments = null;
  let versions = null;
  let readbackError = '';
  let versionReadbackError = '';
  let readbackSource = 'cloudflare';
  const failures = [];

  if (options.deployments) {
    readbackSource = 'fixture';
    deployments = options.deployments;
  } else if (options.deploymentsJson) {
    readbackSource = 'fixture';
    try {
      deployments = JSON.parse(options.deploymentsJson);
    } catch (err) {
      readbackError = err instanceof Error ? err.message : String(err);
    }
  } else {
    try {
      const raw = execFileSync(
        'npx',
        ['wrangler', 'deployments', 'list', '--name', target.workerName, '--json'],
        {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: options.cloudflareTimeoutMs ?? 30_000,
        },
      );
      deployments = JSON.parse(raw);
    } catch (err) {
      readbackError = err instanceof Error ? err.message : String(err);
    }
  }
  if (options.versions) {
    versions = options.versions;
  } else if (options.versionsJson) {
    try {
      versions = JSON.parse(options.versionsJson);
    } catch (err) {
      versionReadbackError = err instanceof Error ? err.message : String(err);
    }
  } else if (!options.deployments && !options.deploymentsJson) {
    try {
      const raw = execFileSync(
        'npx',
        ['wrangler', 'versions', 'list', '--name', target.workerName, '--json'],
        {
          cwd: root,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: options.cloudflareTimeoutMs ?? 30_000,
        },
      );
      versions = JSON.parse(raw);
    } catch (err) {
      versionReadbackError = err instanceof Error ? err.message : String(err);
    }
  }

  const effective = findEffectiveServingCommit(deployments, versions);
  let mustPreserve = [];
  try {
    mustPreserve = readMustPreserveCommits(root, env);
  } catch (err) {
    failures.push(`could not read must-preserve ledger: ${err instanceof Error ? err.message : String(err)}`);
  }

  if (readbackError) {
    failures.push(`could not read Cloudflare deployments for serving lineage: ${readbackError}`);
  }
  if (versionReadbackError && !effective.ok) {
    failures.push(`could not read Cloudflare Worker versions for serving lineage: ${versionReadbackError}`);
  }
  if (!effective.ok) {
    failures.push('could not determine serving cf-repo from Cloudflare deployment metadata');
  }

  let servingContained = false;
  let servingError = '';
  if (effective.commit) {
    const check = commitIsAncestor(root, effective.commit);
    servingContained = check.ok;
    servingError = check.error;
    if (!check.ok) {
      failures.push(`HEAD does not contain current serving cf-repo (${shortCommit(effective.commit)})`);
    }
  }

  const mustPreserveChecks = mustPreserve.map((entry) => {
    const check = commitIsAncestor(root, entry.commit);
    if (!check.ok) {
      const detail = [entry.issue, entry.reason].filter(Boolean).join(' ');
      failures.push(
        `HEAD does not contain must-preserve commit ${shortCommit(entry.commit)}` +
          (detail ? ` (${detail})` : ''),
      );
    }
    return { ...entry, ok: check.ok, error: check.error };
  });

  return {
    ok: failures.length === 0,
    readbackSource,
    readbackError,
    effective,
    servingContained,
    servingError,
    mustPreserveChecks,
    failures,
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

export function evaluateRunContextPolicy(env = process.env) {
  const inGitHubActions = env.GITHUB_ACTIONS === 'true';
  const localOverrideEnabled = env.DEPLOY_GUARD_ALLOW_LOCAL_DEPLOY === '1';
  const localOverrideReason = (env.DEPLOY_GUARD_LOCAL_DEPLOY_REASON || '').trim();
  const localOverrideAccepted = !inGitHubActions && localOverrideEnabled && localOverrideReason.length > 0;

  return {
    inGitHubActions,
    localOverrideEnabled,
    localOverrideReason,
    localOverrideAccepted,
    ok: inGitHubActions || localOverrideAccepted,
  };
}

export function evaluateDeployGuard(root, options = {}) {
  const target = readDeployTarget(root);
  const git = collectGitContext(root, options);
  const env = options.env ?? process.env;
  const branchPolicy = evaluateBranchPolicy(git, env);
  const runContextPolicy = evaluateRunContextPolicy(env);
  const markerChecks = checkRequiredMarkers(root, options.requirements ?? REQUIRED_MARKERS);
  const servingLineage = collectServingLineage(root, target, options);
  const deployManifest = collectDeployManifestGuard(root, git, servingLineage, options);
  const activeChatTurns = collectActiveChatTurnGuard(root, options);
  const failures = [];

  if (!runContextPolicy.ok) {
    failures.push(
      'production deploys normally run from GitHub Actions; set DEPLOY_GUARD_ALLOW_LOCAL_DEPLOY=1 and DEPLOY_GUARD_LOCAL_DEPLOY_REASON for emergency local deploy',
    );
  }
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
  failures.push(...servingLineage.failures);
  failures.push(...deployManifest.failures);
  failures.push(...activeChatTurns.failures);

  return {
    ok: failures.length === 0,
    target,
    git,
    branchPolicy,
    runContextPolicy,
    markerChecks,
    servingLineage,
    deployManifest,
    activeChatTurns,
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
  if (result.runContextPolicy) {
    lines.push(
      `[deploy-guard] deploy_runner=${result.runContextPolicy.inGitHubActions ? 'github_actions' : 'local'}`,
    );
    if (result.runContextPolicy.localOverrideAccepted) {
      lines.push(`[deploy-guard] OVERRIDE local deploy allowed: ${result.runContextPolicy.localOverrideReason}`);
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
  if (result.runContextPolicy?.inGitHubActions) {
    lines.push('[deploy-guard] OK deploy runner: GitHub Actions');
  }
  for (const check of result.markerChecks) {
    if (check.ok) {
      lines.push(`[deploy-guard] OK ${check.label}: ${check.matches.join(', ')}`);
    } else {
      lines.push(`[deploy-guard] BLOCK ${check.label}: marker "${check.marker}" not found`);
    }
  }
  if (result.servingLineage) {
    const lineage = result.servingLineage;
    lines.push(
      `[deploy-guard] serving_lineage_source=${lineage.readbackSource}` +
        (lineage.effective?.latestDeploymentId ? ` latest=${lineage.effective.latestDeploymentId}` : '') +
        (lineage.effective?.codeDeploymentId ? ` code=${lineage.effective.codeDeploymentId}` : ''),
    );
    if (lineage.effective?.commit) {
      lines.push(
        `[deploy-guard] serving_cf_repo=${shortCommit(lineage.effective.commit)}` +
          ` source=${lineage.effective.source}`,
      );
    }
    if (lineage.effective?.source === 'previous_code_deployment') {
      lines.push('[deploy-guard] note: latest deployment has no cf-repo; using previous marked code deployment as effective lineage');
    }
    if (lineage.servingContained) {
      lines.push('[deploy-guard] OK HEAD contains current serving cf-repo');
    }
    for (const check of lineage.mustPreserveChecks ?? []) {
      const detail = [check.issue, check.reason].filter(Boolean).join(' ');
      lines.push(
        `[deploy-guard] ${check.ok ? 'OK' : 'BLOCK'} must-preserve ${shortCommit(check.commit)}` +
          (detail ? ` ${detail}` : ''),
      );
    }
  }
  if (result.deployManifest) {
    const manifest = result.deployManifest;
    lines.push(
      `[deploy-guard] manifest=${manifest.path || '(missing)'} ` +
        `range_commits=${manifest.range.length} allowed_commits=${manifest.allowedCommits.length}`,
    );
    if (manifest.manifest) {
      lines.push(
        `[deploy-guard] manifest_issue=${manifest.manifest.issue ?? '(missing)'} ` +
          `pr=${manifest.manifest.pr ?? '(missing)'} rollback=${shortCommit(String(manifest.manifest.rollback_target_commit ?? '')) || '(missing)'}`,
      );
      const state = manifest.stateChanges;
      lines.push(
        `[deploy-guard] state_changes secrets=${state.secrets} vars=${state.vars} d1_migrations=${state.d1Migrations} kv_writes=${state.kvWrites} queues=${state.queues}`,
      );
    }
    for (const check of manifest.blockedCommits ?? []) {
      if (check.inRange) {
        lines.push(`[deploy-guard] BLOCK manifest blocked commit ${shortCommit(check.commit)}${check.reason ? ` ${check.reason}` : ''}`);
      }
    }
    for (const check of manifest.blockedLabels ?? []) {
      lines.push(`[deploy-guard] BLOCK manifest blocked label ${shortCommit(check.commit)} ${check.matches.join(', ')}`);
    }
    for (const check of manifest.blockedMarkers ?? []) {
      lines.push(`[deploy-guard] BLOCK manifest blocked marker ${shortCommit(check.commit)} ${check.matches.join(', ')}`);
    }
    for (const check of manifest.mustPreserveChecks ?? []) {
      const detail = [check.issue, check.reason].filter(Boolean).join(' ');
      lines.push(
        `[deploy-guard] ${check.ok ? 'OK' : 'BLOCK'} manifest must-preserve ${shortCommit(check.commit)}` +
          (detail ? ` ${detail}` : ''),
      );
    }
  }
  const chatTurns = result.activeChatTurns;
  if (chatTurns) {
    lines.push(
      `[deploy-guard] active_chat_turns=${chatTurns.active.length} source=${chatTurns.source}`,
    );
    if (chatTurns.overrideAccepted) {
      lines.push(`[deploy-guard] OVERRIDE active chat turn check skipped: ${chatTurns.overrideReason}`);
    }
    for (const turn of chatTurns.active.slice(0, ACTIVE_CHAT_TURN_LIMIT)) {
      lines.push(
        `[deploy-guard] ${chatTurns.overrideAccepted ? 'WARN' : 'BLOCK'} active chat turn ` +
          `${turn.eventKey} lease_expires=${new Date(turn.leaseExpiresAtMs).toISOString()}`,
      );
    }
    if (chatTurns.readbackError) {
      lines.push(`[deploy-guard] ${chatTurns.overrideAccepted ? 'WARN' : 'BLOCK'} active chat turn readback: ${chatTurns.readbackError}`);
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
  const manifestIndex = process.argv.indexOf('--manifest');
  const manifestPath = manifestIndex >= 0 ? process.argv[manifestIndex + 1] : undefined;
  if (manifestIndex >= 0 && !manifestPath) {
    process.stderr.write('ERROR: --manifest requires a path\n');
    process.exit(2);
  }
  const result = evaluateDeployGuard(root, { fetchRemote: !noFetch, manifestPath });
  const output = renderReport(result);
  const stream = result.ok ? process.stdout : process.stderr;
  stream.write(`${output}\n`);
  process.exit(result.ok ? 0 : 1);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
