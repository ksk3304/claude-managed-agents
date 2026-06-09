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
when known required fix markers are missing, or when the production deploy
manifest does not explicitly allow the commit range.

## Adopted Operating Level

Current level: **3.8. Serving lineage + manifest allowlist**.

| Level | Safety | Downsides | Migration cost |
| --- | --- | --- | --- |
| 2. PR + deploy guard | Blocks stale `npm run deploy` when branch is behind or missing required markers. | A feature branch that already contains `main` can still deploy production. Direct `wrangler deploy` still bypasses the guard. | Low. Already implemented by the first deploy guard. |
| 3. PR + deploy guard + `main`/`master` only | Forces normal production deploys to happen after PR merge, from the canonical branch. Prevents old or experimental worktrees from deploying even when rebased. | Emergency branch deploys need an explicit override. Direct `wrangler deploy` still bypasses npm lifecycle hooks. | Low to medium. Implemented in this repo by branch policy in `scripts/deploy-guard.mjs`. |
| 3.5. GitHub Actions normal deploy + guarded emergency local deploy | Normal deploy source is GitHub Actions on `main`/`master`, with tests/typecheck before deploy and a single deploy concurrency group. Local npm deploy requires explicit emergency env + reason. | Direct `wrangler deploy` still bypasses npm lifecycle hooks. Local credentials remain available for emergency use. | Medium. Implemented by `.github/workflows/deploy-production.yml` plus deploy runner policy. |
| 3.7. Serving lineage guard + must-preserve ledger | Blocks deploys that do not contain the currently serving `cf-repo` commit or active must-preserve hotfix commits. This closes the #226/#233/#264 class where a branch was fresh against `origin/main` but still dropped a production hotfix. | Requires Cloudflare deployment metadata readback. Unmarked/secret-triggered deployments use the previous marked code deployment as effective code lineage; no marked lineage fails closed. | Medium. Implemented by serving lineage checks in `scripts/deploy-guard.mjs`. |
| 3.8. Manifest allowlist + staging-first workflow | Production deploy needs a JSON manifest that lists the allowed commit range, serving base, rollback target, must-preserve commits, blocked labels/markers, and state changes. PR branches can deploy to env.staging first. | Manifest creation is explicit and slightly heavier. Direct `wrangler deploy` remains a residual bypass risk. | Medium. Implemented by `scripts/deploy-guard.mjs`, `deploy-manifests/`, and `scripts/deploy-staging.mjs`. |
| 4. GitHub Actions only + local token removal | Best protection against stale local worktrees and direct Wrangler deploys. Deploy source becomes auditable in GitHub. | Requires repository secrets, branch protection, incident fallback, and Cloudflare token rotation/removal from laptops. Secrets outage can block urgent deploys. | Medium to high. Not adopted yet. |

Level 3.8 is the current default because Level 3.7 still allowed "merged to
main but not approved for production" changes to ride the next deploy. Issue
#314's no-deploy memory wrapper PoC and #323's prompt-cache regression are the
model failures this level blocks. Level 4 remains the next migration once local
token removal, break-glass ownership, and secret rotation are ready.

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
- deploy manifest path, range size, state-change summary, blocked labels/markers, and manifest must-preserve checks
- active Chat turn lease readback status

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
- no deploy manifest is supplied
- a commit in `serving_base_commit..HEAD` is missing from manifest `allowed_commits`
- a range commit is listed in manifest `blocked_commits`, has a manifest label matching `blocked_labels`, or contains a `blocked_markers` string in its commit message
- a manifest `must_preserve_commits` entry is not contained in `HEAD`
- active Chat turn-processing leases are present or D1 readback cannot be verified

## Operating Invariants

- Use one worktree per Issue.
- Use one branch per Issue.
- Merge through PR into `main` / `master`.
- Deploy normally from `main` / `master`.
- Before deploy, read back the current serving `cf-repo` commit from Cloudflare metadata.
- The deploy source commit must be at or after the current serving commit.
- The deploy source commit must include production fixes already deployed by other Issues.
- If those checks fail, do not deploy, even with a manifest and approval log.

## Why This Was Missing Before

- The previous guard treated freshness against `origin/main` as too close to a complete safety proof.
- It did not make the live serving commit the first production deploy invariant, even though emergency hotfixes, parallel deploys, and secret-triggered Worker versions can make production differ from local assumptions.
- Issue approval and production lineage were checked as separate facts, so "does this deploy source include other Issues already served in production?" was not explicit enough.
- Git worktrees and branches isolate local development only. They do not isolate the single production Worker target that `wrangler deploy` overwrites.

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

## Deploy Manifest

Pass a manifest to production deploys:

```sh
DEPLOY_GUARD_MANIFEST=deploy-manifests/issue-336.json npm run predeploy -- --no-fetch
DEPLOY_GUARD_MANIFEST=deploy-manifests/issue-336.json npm run deploy
```

`deploy-manifests/README.md` documents the JSON schema. The manifest must
include:

- `issue` and `pr`
- `serving_base_commit`
- `rollback_target_commit`
- `allowed_commits`
- `blocked_labels` / `blocked_markers` / optional `commit_labels`
- `must_preserve_commits`
- `state_changes` with explicit `secrets`, `vars`, `d1_migrations`, `kv_writes`, and `queues` arrays

Every commit in `serving_base_commit..HEAD` must be allowlisted. A commit
carrying `no-prod-deploy`, `no-deploy`, `poc`, or `proof-of-concept` blocks
production unless it is removed from the range. This is the guard for #314-style
no-deploy PoC and #323-style prompt-cache regressions riding a later deploy.

Cloudflare Worker versions/deployments track code/config deployments. KV
values, D1 data, Queue content, and secret/value changes are operational state
changes, so record them in `state_changes` and get separate approval before
applying them.

## Staging Deploy

Use staging before production when a PR branch needs real-device Google Chat
testing:

```sh
npm run deploy:staging:dry-run
npm run deploy:staging -- --yes
```

The staging wrapper runs `scripts/check-staging-safety.mjs` and `npm run build`
before any deploy. `--yes` is required for the actual
`wrangler deploy --env staging --strict`. D1 remote migrations are skipped
unless `--migrate --yes` is also supplied.

Staging uses `env.staging` in `wrangler.jsonc`, with a separate Worker name, D1,
KV, Queues, and disabled external side effects for the initial phase. Use
`npm run check:staging-chat-smoke-ready` before connecting a real staging Google
Chat app.

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
marker, serving-lineage, manifest, active Chat turn, and must-preserve checks
still fail closed. Record the incident and follow up with a PR merge back to
`main`.

## Dry Run

For local guard-only checks:

```sh
DEPLOY_GUARD_MANIFEST=deploy-manifests/issue-336.json npm run predeploy -- --no-fetch
```

`--no-fetch` skips network refresh and uses local refs only. Do not use it as a
production deploy substitute.

To prove stale-branch blocking, run the guard from an intentionally stale
worktree. A non-main branch will be blocked by branch policy first; with the
emergency local and branch overrides set, it must still fail if `HEAD` does not
contain `origin/main`.
