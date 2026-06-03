# Production deploy guard

## Purpose

Git worktrees isolate local branches and files. They do not isolate the
Cloudflare Worker production target. Every `wrangler deploy` for this repo can
update the same Worker:

```text
claude-managed-agents-control-plane
```

`npm run deploy` therefore runs `scripts/deploy-guard.mjs` before build or
Wrangler deployment. The guard fails closed when it cannot prove the worktree is
fresh enough, when it is not running from the approved deployment runner, or
when known required fix markers are missing.

## Adopted Operating Level

Current level: **3.7. Serving lineage guard + must-preserve ledger**.

| Level | Safety | Downsides | Migration cost |
| --- | --- | --- | --- |
| 2. PR + deploy guard | Blocks stale `npm run deploy` when branch is behind or missing required markers. | A feature branch that already contains `main` can still deploy production. Direct `wrangler deploy` still bypasses the guard. | Low. Already implemented by the first deploy guard. |
| 3. PR + deploy guard + `main`/`master` only | Forces normal production deploys to happen after PR merge, from the canonical branch. Prevents old or experimental worktrees from deploying even when rebased. | Emergency branch deploys need an explicit override. Direct `wrangler deploy` still bypasses npm lifecycle hooks. | Low to medium. Implemented in this repo by branch policy in `scripts/deploy-guard.mjs`. |
| 3.5. GitHub Actions normal deploy + guarded emergency local deploy | Normal deploy source is GitHub Actions on `main`/`master`, with tests/typecheck before deploy and a single deploy concurrency group. Local npm deploy requires explicit emergency env + reason. | Direct `wrangler deploy` still bypasses npm lifecycle hooks. Local credentials remain available for emergency use. | Medium. Implemented by `.github/workflows/deploy-production.yml` plus deploy runner policy. |
| 3.7. Serving lineage guard + must-preserve ledger | Blocks deploys that do not contain the currently serving `cf-repo` commit or active must-preserve hotfix commits. This closes the #226/#233/#264 class where a branch was fresh against `origin/main` but still dropped a production hotfix. | Requires Cloudflare deployment metadata readback. Unmarked/secret-triggered deployments use the previous marked code deployment as effective code lineage; no marked lineage fails closed. | Medium. Implemented by serving lineage checks in `scripts/deploy-guard.mjs`. |
| 4. GitHub Actions only + local token removal | Best protection against stale local worktrees and direct Wrangler deploys. Deploy source becomes auditable in GitHub. | Requires repository secrets, branch protection, incident fallback, and Cloudflare token rotation/removal from laptops. Secrets outage can block urgent deploys. | Medium to high. Not adopted yet. |

Level 3.7 is the current default because #226's Level 3.5 guard was not enough:
it proved the candidate contained `origin/main`, but did not prove the candidate
contained the code already serving production. Issue #233 and the 2026-06-02
`656a5eb` incident showed that this is an old recurring deploy-clobber problem,
not a fresh isolated bug. Level 4 remains the next migration once local token
removal, break-glass ownership, and secret rotation are ready.

## What It Reports

The guard prints:

- Worker name from `wrangler.jsonc`
- package name and version from `package.json`
- current worktree path
- current branch and HEAD commit
- effective deploy branch
- deploy runner (`github_actions` or `local`)
- upstream ref and commit
- clean/dirty working tree count
- required marker checks
- current serving `cf-repo` read from Cloudflare deployment metadata
- active must-preserve commits

Dirty working trees are reported but not blocked, because the existing prebuild
flow can patch `wrangler.jsonc` with account-local resource IDs.

## Blocking Rules

Production deploy is blocked when:

- the deploy runner is local and the emergency local override is absent
- the effective branch is not `main` or `master`
- the guard cannot refresh or resolve the upstream ref
- `HEAD` does not contain the production baseline ref, default `origin/main`
- required markers are absent
- Cloudflare deployment metadata cannot identify the current serving code line
- `HEAD` does not contain the current serving `cf-repo` commit
- `HEAD` does not contain an active must-preserve commit

In GitHub Actions detached checkout, `GITHUB_REF_NAME` is treated as the
effective deploy branch.

Set `DEPLOY_GUARD_UPSTREAM_REF` only if the production branch is renamed. Do
not point it at a feature branch.

Current required markers:

- `pdf_preflight_result`
- `pendingPdfPreflightApprovalKey`

These Issue #214 PDF preflight markers stay required until the fix is merged
into every branch that may deploy production.

## Serving Lineage

Every production deploy must preserve the code line that is currently serving
the Worker. The guard reads Cloudflare deployment metadata with:

```sh
npx wrangler deployments list --name claude-managed-agents-control-plane --json
```

The newest deployment message containing `cf-repo=<commit>` is the effective
serving code lineage. If the latest deployment has no `cf-repo` marker, the
guard treats it as a possible secret/config-triggered deployment and uses the
previous marked code deployment. If no marked code deployment exists, deploy is
blocked.

The candidate `HEAD` must contain that serving commit:

```sh
git merge-base --is-ancestor <serving-cf-repo> HEAD
```

This stops the #264 failure mode: a candidate can contain `origin/main` and
still be unsafe if production was temporarily patched from an unmerged hotfix
branch.

Serving lineage always comes from Cloudflare readback in real guard runs. Test
fixtures are accepted only through the exported JavaScript API, not through
environment variables, so an inherited shell env cannot spoof production lineage.

## Must-Preserve Ledger

When an unmerged hotfix or incident branch is deployed to production, record its
commit as must-preserve until it is merged, superseded, or explicitly retired.
The guard reads active entries from:

```text
deploy-must-preserve.json
```

Shape:

```json
{
  "schema": 1,
  "commits": [
    {
      "commit": "656a5eb1c836826458b3b3c6ebf75485a46ff972",
      "issue": "#226/#233/#264",
      "reason": "2026-06-02 production hotfix was deployed once and later dropped by a deploy-clobber incident; keep active until merged or explicitly retired with evidence",
      "status": "active"
    }
  ]
}
```

`status: "retired"` or `active: false` removes an entry from enforcement while
keeping the audit trail. Retire only with machine-checkable evidence that the
commit was merged, cherry-picked, or intentionally superseded. `DEPLOY_GUARD_MUST_PRESERVE_COMMITS`
can add temporary space/comma-separated commits for incident work, but permanent
records belong in the ledger file.

## Normal Deploy

Use the `deploy-production` GitHub Actions workflow from `main` or `master`
after PR merge. The workflow runs:

1. `npm ci`
2. `npm test`
3. `npm run typecheck`
4. `npm run deploy`

The deploy script uses `wrangler deploy --strict`.

Do not call `wrangler deploy` directly for production. Direct Wrangler deploys
bypass this guard and can overwrite production from a stale worktree. Local
Cloudflare credentials therefore remain a residual risk until Level 4 removes
or sharply scopes local deploy tokens.

## GitHub Actions Setup

Repository secrets required by the workflow:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

`CLOUDFLARE_API_TOKEN` must be scoped narrowly enough to deploy this Worker and
apply the D1 migrations used by `postdeploy`.

## Emergency Local Override

Use only for production incidents where waiting for PR merge is riskier than a
local deploy. From `main`/`master`:

```sh
DEPLOY_GUARD_ALLOW_LOCAL_DEPLOY=1 \
DEPLOY_GUARD_LOCAL_DEPLOY_REASON="incident: short reason and operator" \
npm run deploy
```

From a non-`main` branch, both the local runner override and the branch override
are required:

```sh
DEPLOY_GUARD_ALLOW_LOCAL_DEPLOY=1 \
DEPLOY_GUARD_LOCAL_DEPLOY_REASON="incident: short reason and operator" \
DEPLOY_GUARD_ALLOW_NON_MAIN=1 \
DEPLOY_GUARD_OVERRIDE_REASON="incident: short reason and operator" \
npm run deploy
```

Overrides only bypass their matching runner/branch rules. Freshness, required
marker, serving-lineage, and must-preserve checks still fail closed. Record the
incident and follow up with a PR merge back to `main`.

## Dry Run

For local guard-only checks:

```sh
npm run predeploy -- --no-fetch
```

`--no-fetch` skips network refresh and uses local refs only. Do not use it as a
production deploy substitute.

To prove stale-branch blocking, run the guard from an intentionally stale
worktree. A non-main branch will be blocked by branch policy first; with the
emergency local and branch overrides set, it must still fail if `HEAD` does not
contain `origin/main`.
