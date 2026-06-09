import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  activeChatTurnSql,
  checkRequiredMarkers,
  collectActiveChatTurnGuard,
  collectDeployManifestGuard,
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

function writeManifest(
  root: string,
  input: {
    issue?: number;
    pr?: number;
    base: string;
    rollback?: string;
    allowed?: string[];
    blockedLabels?: string[];
    commitLabels?: Array<{ commit: string; labels: string[] }>;
    blockedMarkers?: string[];
    mustPreserve?: string[];
    blockedCommits?: Array<{ commit: string; reason?: string }>;
  },
) {
  const manifestPath = path.join(root, "deploy-manifest.test.json");
  writeFileSync(
    manifestPath,
    JSON.stringify({
      schema: 1,
      environment: "production",
      issue: input.issue ?? 336,
      pr: input.pr ?? 72,
      serving_base_commit: input.base,
      rollback_target_commit: input.rollback ?? input.base,
      allowed_commits: input.allowed ?? [],
      blocked_labels: input.blockedLabels ?? ["no-prod-deploy"],
      commit_labels: input.commitLabels ?? [],
      blocked_markers: input.blockedMarkers ?? [],
      must_preserve_commits: input.mustPreserve ?? [],
      blocked_commits: input.blockedCommits ?? [],
      state_changes: {
        secrets: [],
        vars: [],
        d1_migrations: [],
        kv_writes: [],
        queues: [],
      },
    }),
  );
  return manifestPath;
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
    const manifestPath = writeManifest(root, { base: head });

    const result = evaluateDeployGuard(root, {
      fetchRemote: false,
      manifestPath,
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
    const manifestPath = writeManifest(root, { base: staleHead });

    const result = evaluateDeployGuard(root, {
      fetchRemote: false,
      manifestPath,
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

  it("reads cf-repo from version annotations when deployment annotations omit messages", () => {
    const deployments = [
      {
        id: "code",
        created_on: "2026-06-01T20:35:16Z",
        annotations: { "workers/triggered_by": "deployment" },
        versions: [{ version_id: "version-code", percentage: 100 }],
      },
      {
        id: "secret",
        created_on: "2026-06-01T21:40:26Z",
        annotations: { "workers/triggered_by": "secret" },
        versions: [{ version_id: "version-secret", percentage: 100 }],
      },
    ];
    const versions = [
      {
        id: "version-code",
        annotations: {
          "workers/message": "issue=250 cf-repo=c19059547b5c34219e631ee63bf5d94306195e00",
        },
      },
      {
        id: "version-secret",
        annotations: { "workers/triggered_by": "secret" },
      },
    ];

    expect(findEffectiveServingCommit(deployments, versions)).toMatchObject({
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
    const manifestPath = writeManifest(root, { base: servingHotfix });

    const result = evaluateDeployGuard(root, {
      fetchRemote: false,
      manifestPath,
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

  it("allows a makoto-prime prompt deployment marker when local prompt bundle matches", () => {
    const root = makeGitRoot();
    mkdirSync(path.join(root, "src/data"), { recursive: true });
    writeFileSync(
      path.join(root, "src/data/persona-spec.ts"),
      'export const PERSONA_SPEC_SHA256_HEX12 = "94601c72a58c";\n',
    );
    writeFileSync(
      path.join(root, "src/data/tools-spec.ts"),
      'export const TOOLS_SPEC_SHA256_HEX12 = "938bb2c3c403";\n',
    );
    const makotoPrimeCommit = "3d9da9caa19956bf89e0b7751ca9294815d34289";
    const deployments = [
      {
        id: "prompt-deploy",
        created_on: "2026-06-08T11:30:36Z",
        annotations: {
          "workers/message":
            `makoto-prime=${makotoPrimeCommit} cf-repo=${makotoPrimeCommit} ` +
            "persona=94601c72a58c tools=938bb2c3c403 issue=331",
        },
      },
    ];

    const lineage = collectServingLineage(root, readDeployTarget(root), {
      deployments,
    });

    expect(lineage.ok).toBe(true);
    expect(lineage.servingContained).toBe(false);
    expect(lineage.servingPromptBundlePreserved).toBe(true);
    expect(lineage.failures).toEqual([]);
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
    const manifestPath = writeManifest(root, { base: mainHead, mustPreserve: [mustPreserve] });

    const result = evaluateDeployGuard(root, {
      fetchRemote: false,
      manifestPath,
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
    const manifestPath = writeManifest(root, { base: mainHead });
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
      manifestPath,
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
    const manifestPath = writeManifest(root, { base: mainHead });

    const lineage = collectServingLineage(root, readDeployTarget(root), {
      deployments: deploymentFor(mainHead),
    });

    expect(lineage.ok).toBe(true);
    expect(lineage.servingContained).toBe(true);
  });

  it("builds active chat turn SQL with the supplied clock", () => {
    expect(activeChatTurnSql(1234567890, 3)).toContain("lease_expires_at_ms, 0) > 1234567890");
    expect(activeChatTurnSql(1234567890, 3)).toContain("LIMIT 3");
    expect(activeChatTurnSql(1234567890, 3)).toContain("chat_turn_processing:chat:%");
  });

  it("blocks deploy while a Chat turn-processing lease is alive", () => {
    const root = makeGitRoot();
    const head = git(root, ["rev-parse", "HEAD"]);
    const nowMs = 1_780_474_000_000;
    const manifestPath = writeManifest(root, { base: head });

    const result = evaluateDeployGuard(root, {
      fetchRemote: false,
      manifestPath,
      nowMs,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF_NAME: "main",
      },
      deployments: deploymentFor(head),
      activeChatTurns: [
        {
          event_key: "chat_turn_processing:chat:msgname:spaces/x/messages/y.y",
          lease_expires_at_ms: nowMs + 60_000,
          committed_at_ms: null,
        },
      ],
    });

    expect(result.ok).toBe(false);
    expect(result.activeChatTurns.active).toHaveLength(1);
    expect(result.failures).toContainEqual(
      expect.stringContaining("active Chat turn processing leases exist"),
    );
  });

  it("requires a deploy manifest for production deploys", () => {
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

    expect(result.ok).toBe(false);
    expect(result.deployManifest.failures).toContainEqual(
      expect.stringContaining("deploy manifest is required"),
    );
  });

  it("blocks deploy range commits that are outside the manifest allowlist", () => {
    const root = makeGitRoot();
    const base = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "feature-a.txt"), "allowed\n");
    git(root, ["add", "feature-a.txt"]);
    git(root, ["commit", "-m", "allowed feature"]);
    const allowed = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "feature-b.txt"), "not listed\n");
    git(root, ["add", "feature-b.txt"]);
    git(root, ["commit", "-m", "unlisted feature"]);
    const head = git(root, ["rev-parse", "HEAD"]);
    const manifestPath = writeManifest(root, { base, allowed: [allowed] });

    const result = evaluateDeployGuard(root, {
      fetchRemote: false,
      manifestPath,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF_NAME: "main",
      },
      deployments: deploymentFor(base),
    });

    expect(result.ok).toBe(false);
    expect(result.deployManifest.range).toContain(head);
    expect(result.failures).toContainEqual(
      expect.stringContaining("is not listed in deploy manifest allowed_commits"),
    );
  });

  it("blocks manifest commits carrying no-prod-deploy labels", () => {
    const root = makeGitRoot();
    const base = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "poc.txt"), "memory wrapper PoC\n");
    git(root, ["add", "poc.txt"]);
    git(root, ["commit", "-m", "memory wrapper PoC"]);
    const poc = git(root, ["rev-parse", "HEAD"]);
    const manifestPath = writeManifest(root, {
      base,
      allowed: [poc],
      commitLabels: [{ commit: poc, labels: ["no-prod-deploy"] }],
    });

    const result = evaluateDeployGuard(root, {
      fetchRemote: false,
      manifestPath,
      env: {
        GITHUB_ACTIONS: "true",
        GITHUB_REF_NAME: "main",
      },
      deployments: deploymentFor(base),
    });

    expect(result.ok).toBe(false);
    expect(result.deployManifest.blockedLabels[0].matches).toContain("no-prod-deploy");
  });

  it("blocks deploy range commits with blocked markers", () => {
    const root = makeGitRoot();
    const base = git(root, ["rev-parse", "HEAD"]);
    writeFileSync(path.join(root, "prompt-cache.txt"), "cache_control 400 repro\n");
    git(root, ["add", "prompt-cache.txt"]);
    git(root, ["commit", "-m", "prompt cache no-prod-deploy"]);
    const commit = git(root, ["rev-parse", "HEAD"]);
    const manifestPath = writeManifest(root, {
      base,
      allowed: [commit],
      blockedMarkers: ["no-prod-deploy"],
    });

    const guard = collectDeployManifestGuard(
      root,
      {
        head: commit,
      },
      {
        effective: {
          commit: base,
        },
      },
      { manifestPath },
    );

    expect(guard.ok).toBe(false);
    expect(guard.blockedMarkers[0].matches).toContain("no-prod-deploy");
  });

  it("allows an explicit active Chat turn guard override with a reason", () => {
    const guard = collectActiveChatTurnGuard(makeRoot(), {
      nowMs: 1000,
      env: {
        DEPLOY_GUARD_SKIP_ACTIVE_CHAT_TURN_CHECK: "1",
        DEPLOY_GUARD_ACTIVE_CHAT_TURN_REASON: "emergency rollback",
      },
      activeChatTurns: [
        {
          event_key: "chat_turn_processing:chat:msgname:spaces/x/messages/y.y",
          lease_expires_at_ms: 2000,
          committed_at_ms: null,
        },
      ],
    });

    expect(guard.ok).toBe(true);
    expect(guard.overrideAccepted).toBe(true);
    expect(guard.active).toHaveLength(1);
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
    const manifestPath = writeManifest(root, { base: servingHotfix });

    const result = evaluateDeployGuard(root, {
      fetchRemote: false,
      manifestPath,
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
