import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkRequiredMarkers,
  collectGitContext,
  collectServingLineage,
  evaluateBranchPolicy,
  evaluateDeployGuard,
  evaluateRunContextPolicy,
  extractCfRepoCommit,
  findEffectiveServingCommit,
  readDeployTarget,
  renderReport,
  REQUIRED_MARKERS,
} from "../scripts/deploy-guard.mjs";

const roots: string[] = [];

function deploymentFor(commit: string) {
  return [
    {
      id: "fixture",
      created_on: "2026-06-02T00:00:00Z",
      annotations: { "workers/message": `cf-repo=${commit}` },
    },
  ];
}

function makeRoot() {
  const root = mkdtempSync(path.join(os.tmpdir(), "deploy-guard-"));
  roots.push(root);
  mkdirSync(path.join(root, "src/queue"), { recursive: true });
  mkdirSync(path.join(root, "tests"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    JSON.stringify({ name: "claude-managed-agents-cloudflare", version: "0.1.0" }),
  );
  writeFileSync(
    path.join(root, "wrangler.jsonc"),
    '{\n  // JSONC comments are allowed here\n  "name": "claude-managed-agents-control-plane"\n}\n',
  );
  return root;
}

function git(root: string, args: string[]) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeGitRoot() {
  const root = makeRoot();
  writeFileSync(
    path.join(root, "src/queue/chat-event-handler.ts"),
    "const eventType = 'pdf_preflight_result';\nfunction pendingPdfPreflightApprovalKey() {}\n",
  );
  writeFileSync(
    path.join(root, "tests/chat-event-handler.test.ts"),
    "expect(runtimeEvents).toContain('pdf_preflight_result');\n",
  );
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "Deploy Guard Test"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-m", "initial"]);
  git(root, ["branch", "origin/main"]);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("deploy guard", () => {
  it("reads the Worker target and package version from local config", () => {
    const root = makeRoot();
    expect(readDeployTarget(root)).toMatchObject({
      packageName: "claude-managed-agents-cloudflare",
      packageVersion: "0.1.0",
      workerName: "claude-managed-agents-control-plane",
    });
  });

  it("passes required Issue #214 markers when they exist in guarded paths", () => {
    const root = makeRoot();
    writeFileSync(
      path.join(root, "src/queue/chat-event-handler.ts"),
      "const eventType = 'pdf_preflight_result';\nfunction pendingPdfPreflightApprovalKey() {}\n",
    );
    writeFileSync(
      path.join(root, "tests/chat-event-handler.test.ts"),
      "expect(runtimeEvents).toContain('pdf_preflight_result');\n",
    );

    expect(checkRequiredMarkers(root).map((check) => check.ok)).toEqual([true, true]);
  });

  it("fails closed when a stale branch lacks the PDF preflight markers", () => {
    const root = makeRoot();
    writeFileSync(path.join(root, "src/queue/chat-event-handler.ts"), "export const oldDeploy = true;\n");
    writeFileSync(path.join(root, "tests/chat-event-handler.test.ts"), "export const oldTest = true;\n");

    const checks = checkRequiredMarkers(root);
    expect(checks.map((check) => check.ok)).toEqual([false, false]);

    const report = renderReport({
      ok: false,
      target: readDeployTarget(root),
      git: {
        worktree: root,
        branch: "codex/stale-worktree",
        headShort: "abc123456789",
        upstream: "origin/main",
        upstreamShort: "def123456789",
        containsUpstream: true,
        dirty: false,
        statusCount: 0,
      },
      markerChecks: checks,
      failures: checks.map((check) => `missing required marker "${check.marker}" (${check.label})`),
    });

    for (const marker of REQUIRED_MARKERS.map((req) => req.marker)) {
      expect(report).toContain(marker);
    }
    expect(report).toContain("BLOCKED production deploy refused");
  });

  it("blocks non-main production deploys by default", () => {
    const result = evaluateBranchPolicy(
      { branch: "codex/stale-worktree" },
      {},
    );

    expect(result.ok).toBe(false);
    expect(result.effectiveBranch).toBe("codex/stale-worktree");
  });

  it("requires an explicit reason for non-main emergency deploy override", () => {
    expect(
      evaluateBranchPolicy(
        { branch: "codex/hotfix" },
        { DEPLOY_GUARD_ALLOW_NON_MAIN: "1" },
      ).ok,
    ).toBe(false);

    expect(
      evaluateBranchPolicy(
        { branch: "codex/hotfix" },
        {
          DEPLOY_GUARD_ALLOW_NON_MAIN: "1",
          DEPLOY_GUARD_OVERRIDE_REASON: "production incident rollback",
        },
      ).overrideAccepted,
    ).toBe(true);
  });

  it("requires GitHub Actions or an explicit reason for emergency local deploy", () => {
    expect(evaluateRunContextPolicy({}).ok).toBe(false);

    expect(
      evaluateRunContextPolicy({
        DEPLOY_GUARD_ALLOW_LOCAL_DEPLOY: "1",
      }).ok,
    ).toBe(false);

    expect(
      evaluateRunContextPolicy({
        DEPLOY_GUARD_ALLOW_LOCAL_DEPLOY: "1",
        DEPLOY_GUARD_LOCAL_DEPLOY_REASON: "production incident rollback",
      }).localOverrideAccepted,
    ).toBe(true);
  });

  it("allows GitHub Actions deploy from main when fresh and markers exist", () => {
    const root = makeGitRoot();
    const head = git(root, ["rev-parse", "HEAD"]);

    const result = evaluateDeployGuard(root, {
      fetchRemote: false,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF_NAME: "main",
      },
      deployments: deploymentFor(head),
    });

    expect(result.ok).toBe(true);
  });

  it("uses origin/main as the production freshness baseline even from feature branches", () => {
    const root = makeGitRoot();
    git(root, ["checkout", "-b", "codex/feature"]);
    git(root, ["branch", "origin/codex/feature"]);
    git(root, ["branch", "--set-upstream-to", "origin/codex/feature"]);

    const context = collectGitContext(root, { fetchRemote: false });

    expect(context.upstream).toBe("origin/main");
  });

  it("fails closed when HEAD does not contain origin/main", () => {
    const root = makeGitRoot();
    git(root, ["checkout", "-b", "codex/stale-worktree"]);
    writeFileSync(path.join(root, "feature.txt"), "feature\n");
    git(root, ["add", "feature.txt"]);
    git(root, ["commit", "-m", "feature"]);
    git(root, ["checkout", "main"]);
    writeFileSync(path.join(root, "main.txt"), "main\n");
    git(root, ["add", "main.txt"]);
    git(root, ["commit", "-m", "main update"]);
    git(root, ["branch", "-f", "origin/main", "main"]);
    git(root, ["checkout", "codex/stale-worktree"]);
    const staleHead = git(root, ["rev-parse", "HEAD"]);

    const result = evaluateDeployGuard(root, {
      fetchRemote: false,
      env: {
        DEPLOY_GUARD_ALLOW_LOCAL_DEPLOY: "1",
        DEPLOY_GUARD_LOCAL_DEPLOY_REASON: "test stale branch local deploy",
        DEPLOY_GUARD_ALLOW_NON_MAIN: "1",
        DEPLOY_GUARD_OVERRIDE_REASON: "test stale branch override still needs freshness",
      },
      deployments: deploymentFor(staleHead),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(
      expect.stringContaining("HEAD does not contain origin/main"),
    );
  });

  it("extracts cf-repo from deployment messages", () => {
    expect(extractCfRepoCommit("makoto-prime cf-repo=656a5eb1c836 issue=226")).toBe(
      "656a5eb1c836",
    );
    expect(extractCfRepoCommit("secret deployment without code marker")).toBe("");
  });

  it("uses the previous marked code deployment when latest deployment has no cf-repo", () => {
    const deployments = [
      {
        id: "code",
        created_on: "2026-06-01T20:35:16Z",
        annotations: { "workers/message": "issue=250 cf-repo=c19059547b5c34219e631ee63bf5d94306195e00" },
      },
      {
        id: "secret",
        created_on: "2026-06-01T21:40:26Z",
        annotations: { "workers/message": "secret-triggered deployment" },
      },
    ];

    expect(findEffectiveServingCommit(deployments)).toMatchObject({
      ok: true,
      latestHadCfRepo: false,
      source: "previous_code_deployment",
      commit: "c19059547b5c34219e631ee63bf5d94306195e00",
      latestDeploymentId: "secret",
      codeDeploymentId: "code",
    });
  });

  it("blocks deploy when HEAD would drop the current serving hotfix", () => {
    const root = makeGitRoot();
    git(root, ["checkout", "-b", "codex/serving-hotfix"]);
    writeFileSync(path.join(root, "hotfix.txt"), "656a5eb style production fix\n");
    git(root, ["add", "hotfix.txt"]);
    git(root, ["commit", "-m", "serving hotfix"]);
    const servingHotfix = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "main"]);

    const result = evaluateDeployGuard(root, {
      fetchRemote: false,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF_NAME: "main",
      },
      deployments: deploymentFor(servingHotfix),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(
      expect.stringContaining("HEAD does not contain current serving cf-repo"),
    );
  });

  it("blocks deploy when a must-preserve commit would be dropped", () => {
    const root = makeGitRoot();
    git(root, ["checkout", "-b", "codex/must-preserve-hotfix"]);
    writeFileSync(path.join(root, "must-preserve.txt"), "deployed but not merged\n");
    git(root, ["add", "must-preserve.txt"]);
    git(root, ["commit", "-m", "must preserve hotfix"]);
    const mustPreserve = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "main"]);
    const mainHead = git(root, ["rev-parse", "HEAD"]);

    const result = evaluateDeployGuard(root, {
      fetchRemote: false,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF_NAME: "main",
        DEPLOY_GUARD_MUST_PRESERVE_COMMITS: mustPreserve,
      },
      deployments: deploymentFor(mainHead),
    });

    expect(result.ok).toBe(false);
    expect(result.failures).toContainEqual(
      expect.stringContaining("HEAD does not contain must-preserve commit"),
    );
  });

  it("loads active must-preserve commits from the ledger file", () => {
    const root = makeGitRoot();
    git(root, ["checkout", "-b", "codex/ledger-hotfix"]);
    writeFileSync(path.join(root, "ledger-hotfix.txt"), "deployed hotfix\n");
    git(root, ["add", "ledger-hotfix.txt"]);
    git(root, ["commit", "-m", "ledger hotfix"]);
    const ledgerHotfix = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "main"]);
    const mainHead = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(
      path.join(root, "deploy-must-preserve.json"),
      JSON.stringify({
        schema: 1,
        commits: [
          {
            commit: ledgerHotfix,
            issue: "#226",
            reason: "production hotfix already served",
            status: "active",
          },
          {
            commit: "deadbeef",
            issue: "#old",
            reason: "retired example",
            status: "retired",
          },
        ],
      }),
    );

    const result = evaluateDeployGuard(root, {
      fetchRemote: false,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF_NAME: "main",
      },
      deployments: deploymentFor(mainHead),
    });

    expect(result.ok).toBe(false);
    expect(result.servingLineage.mustPreserveChecks).toHaveLength(1);
    expect(result.failures).toContainEqual(
      expect.stringContaining("HEAD does not contain must-preserve commit"),
    );
  });

  it("passes serving lineage when HEAD contains the current serving commit", () => {
    const root = makeGitRoot();
    const mainHead = git(root, ["rev-parse", "HEAD"]);

    const lineage = collectServingLineage(root, readDeployTarget(root), {
      deployments: deploymentFor(mainHead),
    });

    expect(lineage.ok).toBe(true);
    expect(lineage.servingContained).toBe(true);
  });

  it("ignores inherited DEPLOY_GUARD_SERVING_COMMIT and uses Cloudflare metadata fixtures", () => {
    const root = makeGitRoot();
    const mainHead = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "-b", "codex/serving-hotfix"]);
    writeFileSync(path.join(root, "serving.txt"), "currently serving\n");
    git(root, ["add", "serving.txt"]);
    git(root, ["commit", "-m", "serving hotfix"]);
    const servingHotfix = git(root, ["rev-parse", "HEAD"]);
    git(root, ["checkout", "main"]);

    const result = evaluateDeployGuard(root, {
      fetchRemote: false,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF_NAME: "main",
        DEPLOY_GUARD_SERVING_COMMIT: mainHead,
      },
      deployments: deploymentFor(servingHotfix),
    });

    expect(result.ok).toBe(false);
    expect(result.servingLineage.effective.commit).toBe(servingHotfix);
    expect(result.failures).toContainEqual(
      expect.stringContaining("HEAD does not contain current serving cf-repo"),
    );
  });
});
