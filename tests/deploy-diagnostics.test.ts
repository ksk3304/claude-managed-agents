import { describe, expect, it } from "vitest";
import {
  buildDefaultDeployMessage,
  buildDeployFailureMessage,
  hasDeployMessageArg,
  isWorkersAuthFailure,
} from "../scripts/deploy-with-diagnostics.mjs";

describe("deploy diagnostics", () => {
  it("recognizes Worker deploy auth error 10000", () => {
    const output =
      "A request to the Cloudflare API (/accounts/abc/workers/services/claude-managed-agents-control-plane) failed. Authentication error [code: 10000]";

    expect(isWorkersAuthFailure(output)).toBe(true);

    const message = buildDeployFailureMessage(output, {
      CLOUDFLARE_ACCOUNT_ID: "abc",
      CLOUDFLARE_API_TOKEN: "redacted",
    });
    expect(message).toContain("Cloudflare rejected the Worker deploy request");
    expect(message).toContain("KV/D1 success does not prove Worker deploy permission");
    expect(message).toContain("Workers Scripts > Edit");
    expect(message).toContain("Nothing was deployed");
  });

  it("keeps generic wrangler failures generic", () => {
    expect(isWorkersAuthFailure("network unavailable")).toBe(false);
    expect(buildDeployFailureMessage("network unavailable")).toContain(
      "No extra diagnosis matched",
    );
  });

  it("can be imported by tests without running deploy", () => {
    expect(typeof buildDeployFailureMessage).toBe("function");
  });

  it("detects explicit deploy messages", () => {
    expect(hasDeployMessageArg(["--strict", "--message", "cf-repo=abc"])).toBe(true);
    expect(hasDeployMessageArg(["--strict", "--message=cf-repo=abc"])).toBe(true);
    expect(hasDeployMessageArg(["--strict"])).toBe(false);
  });

  it("prefers CF_DEPLOY_MESSAGE for deploy lineage", () => {
    expect(buildDefaultDeployMessage({ CF_DEPLOY_MESSAGE: "cf-repo=abc issue=246" })).toBe(
      "cf-repo=abc issue=246",
    );
  });
});
