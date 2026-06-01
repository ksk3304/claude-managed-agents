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
fresh enough or when known required fix markers are missing.

## Adopted Operating Level

Current level: **3. PR + deploy guard + production branch only**.

| Level | Safety | Downsides | Migration cost |
| --- | --- | --- | --- |
| 2. PR + deploy guard | Blocks stale `npm run deploy` when branch is behind or missing required markers. | A feature branch that already contains `main` can still deploy production. Direct `wrangler deploy` still bypasses the guard. | Low. Already implemented by the first deploy guard. |
| 3. PR + deploy guard + `main`/`master` only | Forces normal production deploys to happen after PR merge, from the canonical branch. Prevents old or experimental worktrees from deploying even when rebased. | Emergency branch deploys need an explicit override. Direct `wrangler deploy` still bypasses npm lifecycle hooks. | Low to medium. Implemented in this repo by branch policy in `scripts/deploy-guard.mjs`. |
| 4. GitHub Actions only + local token removal | Best protection against stale local worktrees and direct Wrangler deploys. Deploy source becomes auditable in GitHub. | Requires repository secrets, branch protection, incident fallback, and Cloudflare token rotation/removal from laptops. Secrets outage can block urgent deploys. | Medium to high. Not adopted yet. |

Level 3 is the current default because it removes the main stale-worktree risk
without making production deploy dependent on a new CI secret path. Level 4 is
the next migration once GitHub Actions secrets, branch protection, and emergency
break-glass ownership are ready.

## What It Reports

The guard prints:

- Worker name from `wrangler.jsonc`
- package name and version from `package.json`
- current worktree path
- current branch and HEAD commit
- effective deploy branch
- upstream ref and commit
- clean/dirty working tree count
- required marker checks

Dirty working trees are reported but not blocked, because the existing prebuild
flow can patch `wrangler.jsonc` with account-local resource IDs.

## Blocking Rules

Production deploy is blocked when:

- the effective branch is not `main` or `master`
- the guard cannot refresh or resolve the upstream ref
- `HEAD` does not contain the upstream ref, usually `origin/main`
- required markers are absent

In GitHub Actions detached checkout, `GITHUB_REF_NAME` is treated as the
effective deploy branch.

Current required markers:

- `pdf_preflight_result`
- `pendingPdfPreflightApprovalKey`

These Issue #214 PDF preflight markers stay required until the fix is merged
into every branch that may deploy production.

## Normal Deploy

```sh
npm run deploy
```

Run this from `main` or `master` after PR merge. The deploy script uses
`wrangler deploy --strict`.

Do not call `wrangler deploy` directly for production. Direct Wrangler deploys
bypass this guard and can overwrite production from a stale worktree. Local
Cloudflare credentials therefore remain a residual risk until Level 4 removes
or sharply scopes local deploy tokens.

## Emergency Override

Use only for production incidents where waiting for PR merge is riskier than a
branch deploy:

```sh
DEPLOY_GUARD_ALLOW_NON_MAIN=1 \
DEPLOY_GUARD_OVERRIDE_REASON="incident: short reason and operator" \
npm run deploy
```

Override only bypasses the branch rule. Freshness and required marker checks
still fail closed. Record the incident and follow up with a PR merge back to
`main`.

## Dry Run

For local guard-only checks:

```sh
npm run predeploy -- --no-fetch
```

`--no-fetch` skips network refresh and uses local refs only. Do not use it as a
production deploy substitute.

To prove stale-branch blocking, run the guard from an intentionally stale
worktree. A non-main branch will be blocked by branch policy first; with the
emergency override set, it must still fail if `HEAD` does not contain
`origin/main`.
