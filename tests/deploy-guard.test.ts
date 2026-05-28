import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  checkRequiredMarkers,
  readDeployTarget,
  renderReport,
  REQUIRED_MARKERS,
} from "../scripts/deploy-guard.mjs";

const roots: string[] = [];

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
});
