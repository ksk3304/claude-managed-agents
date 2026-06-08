#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const wranglerPath = path.join(repoRoot, 'wrangler.jsonc');
const stagingSecretManifestPath = path.join(repoRoot, 'config', 'staging-secrets.manifest.json');

const args = new Set(process.argv.slice(2));
const allowMissing = args.has('--allow-missing-staging');
const allowUnprovisioned = args.has('--allow-unprovisioned');
const checkSecrets = args.has('--check-secrets');
const envArg = process.argv.find((arg) => arg.startsWith('--env='));
const envName = envArg ? envArg.slice('--env='.length) : 'staging';
const phaseArg = process.argv.find((arg) => arg.startsWith('--phase='));
const phaseName = phaseArg ? phaseArg.slice('--phase='.length) : 'base';

function stripJsonc(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
    .replace(/,\s*([}\]])/g, '$1');
}

function parseConfig() {
  return JSON.parse(stripJsonc(readFileSync(wranglerPath, 'utf8')));
}

function loadSecretManifest() {
  return JSON.parse(readFileSync(stagingSecretManifestPath, 'utf8'));
}

function parseWranglerJsonArray(output) {
  const start = output.indexOf('[');
  const end = output.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error(`wrangler output did not contain a JSON array: ${output.slice(0, 120)}`);
  }
  return JSON.parse(output.slice(start, end + 1));
}

function listRemoteSecretNames(envName) {
  const output = execFileSync(
    'npx',
    ['wrangler', 'secret', 'list', '--env', envName],
    {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, CI: process.env.CI ?? '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const rows = parseWranglerJsonArray(output);
  return new Set(rows.map((row) => row?.name).filter((name) => typeof name === 'string'));
}

function truthy(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function queueBindings(envConfig, kind) {
  return Array.isArray(envConfig?.queues?.[kind]) ? envConfig.queues[kind] : [];
}

function bindings(envConfig, kind) {
  return Array.isArray(envConfig?.[kind]) ? envConfig[kind] : [];
}

function durableObjectBindings(envConfig) {
  return Array.isArray(envConfig?.durable_objects?.bindings) ? envConfig.durable_objects.bindings : [];
}

function isZeroHex(value, length) {
  return typeof value === 'string' && value.length === length && /^0+$/.test(value);
}

function isZeroUuid(value) {
  return value === '00000000-0000-0000-0000-000000000000';
}

function checkRemoteSecretPolicy(failures) {
  const manifest = loadSecretManifest();
  if (manifest.env !== envName) {
    failures.push(`staging secret manifest env must be ${envName}, got ${manifest.env}`);
    return;
  }

  const phase = manifest.phases?.[phaseName];
  if (!phase) {
    failures.push(`unknown staging secret phase: ${phaseName}`);
    return;
  }

  let secretNames;
  try {
    secretNames = listRemoteSecretNames(envName);
  } catch (err) {
    failures.push(
      `failed to list remote secrets for env.${envName}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  for (const name of manifest.forbiddenSecrets ?? []) {
    if (secretNames.has(name)) {
      failures.push(`env.${envName} secret ${name} is forbidden in phase ${phaseName}`);
    }
  }

  for (const name of phase.requiredSecrets ?? []) {
    if (!secretNames.has(name)) {
      failures.push(`env.${envName} secret ${name} is required for phase ${phaseName}`);
    }
  }

  for (const group of phase.requiredAnyOf ?? []) {
    if (!group.some((name) => secretNames.has(name))) {
      failures.push(`env.${envName} requires one of [${group.join(', ')}] for phase ${phaseName}`);
    }
  }

  const allowed = new Set(phase.allowedSecrets ?? []);
  for (const name of secretNames) {
    if (!allowed.has(name)) {
      failures.push(`env.${envName} secret ${name} is not allowed in phase ${phaseName}`);
    }
  }
}

function main() {
  const config = parseConfig();
  const envConfig = config.env?.[envName];
  const failures = [];

  if (!envConfig) {
    if (allowMissing) {
      console.log(`[staging-safety] SKIP: env.${envName} not present yet`);
      return;
    }
    failures.push(`env.${envName} is missing in wrangler.jsonc`);
  }

  const vars = envConfig?.vars ?? {};
  const chatQueueName = String(vars.MAKOTO_CHAT_QUEUE_NAME ?? '').trim();
  const producers = queueBindings(envConfig, 'producers');
  const consumers = queueBindings(envConfig, 'consumers');
  const kvNamespaces = bindings(envConfig, 'kv_namespaces');
  const d1Databases = bindings(envConfig, 'd1_databases');
  const doBindings = durableObjectBindings(envConfig);
  const sideEffectVars = [
    'AGENTMAIL_DEFAULT_INBOX_ID',
    'GCP_SCHEDULER_PROJECT',
    'GCP_SCHEDULER_LOCATION',
    'SCHEDULER_TOPIC_NAME',
    'SCHEDULER_HANDLER_TOPIC_PREFIX',
    'MAKOTO_NOTIFY_SPACE',
    'COST_GUARD_OPERATOR_SPACE',
  ];

  if (envConfig) {
    if (envConfig.workers_dev !== true) {
      failures.push(`env.${envName}.workers_dev must be true so staging has an isolated workers.dev endpoint`);
    }
    if (!truthy(vars.MAKOTO_EXTERNAL_SIDE_EFFECTS_DISABLED)) {
      failures.push(`env.${envName}.vars.MAKOTO_EXTERNAL_SIDE_EFFECTS_DISABLED must be true for initial staging`);
    }
    if (!chatQueueName) {
      failures.push(`env.${envName}.vars.MAKOTO_CHAT_QUEUE_NAME is required`);
    } else if (chatQueueName === 'makoto-chat-queue') {
      failures.push(`env.${envName}.vars.MAKOTO_CHAT_QUEUE_NAME must not be the production queue name`);
    }
    if (!producers.some((entry) => entry?.binding === 'MAKOTO_CHAT_QUEUE' && entry?.queue === chatQueueName)) {
      failures.push(`env.${envName}.queues.producers must bind MAKOTO_CHAT_QUEUE to ${chatQueueName || '<staging queue>'}`);
    }
    const chatConsumer = consumers.find((entry) => entry?.queue === chatQueueName);
    if (!chatConsumer) {
      failures.push(`env.${envName}.queues.consumers must consume ${chatQueueName || '<staging queue>'}`);
    } else if (!chatConsumer.dead_letter_queue || chatConsumer.dead_letter_queue === 'makoto-chat-queue-dlq') {
      failures.push(`env.${envName}.queues.consumers for ${chatQueueName} must set a non-production dead_letter_queue`);
    }
    if (Array.isArray(envConfig.triggers?.crons) && envConfig.triggers.crons.length > 0) {
      failures.push(`env.${envName}.triggers.crons must be empty or omitted for initial staging`);
    }
    const kv = kvNamespaces.find((entry) => entry?.binding === 'MAKOTO_KV');
    if (!kv?.id) {
      failures.push(`env.${envName}.kv_namespaces must bind MAKOTO_KV`);
    } else if (isZeroHex(kv.id, 32) && !allowUnprovisioned) {
      failures.push(
        `env.${envName}.kv_namespaces.MAKOTO_KV id is still the Phase 0 placeholder; use --allow-unprovisioned only before resource creation`,
      );
    }
    const d1 = d1Databases.find((entry) => entry?.binding === 'DB');
    if (!d1?.database_id) {
      failures.push(`env.${envName}.d1_databases must bind DB`);
    } else if (isZeroUuid(d1.database_id) && !allowUnprovisioned) {
      failures.push(
        `env.${envName}.d1_databases.DB database_id is still the Phase 0 placeholder; use --allow-unprovisioned only before resource creation`,
      );
    }
    for (const name of ['MAKOTO_THREAD_LOCK', 'MAKOTO_OAUTH_LEASE']) {
      if (!doBindings.some((entry) => entry?.name === name)) {
        failures.push(`env.${envName}.durable_objects.bindings must include ${name}`);
      }
    }
    if (!args.has('--allow-side-effect-vars')) {
      for (const key of sideEffectVars) {
        if (vars[key] !== undefined && String(vars[key]).trim() !== '') {
          failures.push(`env.${envName}.vars.${key} must be unset unless --allow-side-effect-vars is used`);
        }
      }
    }
  }

  if (envConfig && checkSecrets) {
    checkRemoteSecretPolicy(failures);
  }

  if (failures.length > 0) {
    console.error(`[staging-safety] FAIL (${failures.length})`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exit(1);
  }

  const secretSuffix = checkSecrets ? ` + secret phase ${phaseName}` : '';
  console.log(`[staging-safety] OK: env.${envName} is safe for initial staging${secretSuffix}`);
}

main();
