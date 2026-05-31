#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

function resolveWranglerBin() {
  const local = resolve(repoRoot, "node_modules", ".bin", "wrangler");
  if (existsSync(local)) return local;
  return "wrangler";
}

export function isWorkersAuthFailure(output) {
  return (
    /Authentication error\s*\[code:\s*10000\]/i.test(output) &&
    /\/accounts\/[^/\s]+\/workers\//i.test(output)
  );
}

export function buildDeployFailureMessage(output, env = process.env) {
  const accountHint = env.CLOUDFLARE_ACCOUNT_ID
    ? `CLOUDFLARE_ACCOUNT_ID is set to ${env.CLOUDFLARE_ACCOUNT_ID}.`
    : "CLOUDFLARE_ACCOUNT_ID is not set in this shell.";

  if (isWorkersAuthFailure(output)) {
    return [
      "[deploy] Cloudflare rejected the Worker deploy request.",
      "",
      "Meaning:",
      "- The current Cloudflare credentials can reach some APIs, but not Worker deploy/status APIs.",
      "- KV/D1 success does not prove Worker deploy permission; those are separate token scopes.",
      "- Nothing was deployed after this error.",
      "",
      "Required Cloudflare API token scope:",
      "- Account > Workers Scripts > Edit (Cloudflare API calls this Workers Scripts Write).",
      "",
      "Current shell:",
      `- ${accountHint}`,
      `- CLOUDFLARE_API_TOKEN is ${env.CLOUDFLARE_API_TOKEN ? "set" : "not set"}.`,
      "",
      "Fix:",
      "- Use a deploy-capable CLOUDFLARE_API_TOKEN, or run `npx wrangler login` with a user that can edit Workers scripts.",
      "- Then rerun `npm run deploy` from this branch.",
    ].join("\n");
  }

  return [
    "[deploy] wrangler deploy failed.",
    "",
    "The raw wrangler error is printed above. No extra diagnosis matched.",
  ].join("\n");
}

export function runDeploy(args = process.argv.slice(2), env = process.env) {
  const wrangler = resolveWranglerBin();
  const result = spawnSync(wrangler, ["deploy", ...args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error) {
    console.error(`[deploy] failed to start wrangler: ${result.error.message}`);
    return 1;
  }

  if (result.status !== 0) {
    const combined = `${result.stdout || ""}\n${result.stderr || ""}`;
    console.error(`\n${buildDeployFailureMessage(combined, env)}`);
    return result.status || 1;
  }

  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(runDeploy());
}
