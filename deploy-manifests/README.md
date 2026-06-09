# Deploy manifests

Production deploys require a JSON deploy manifest. The manifest is the machine-readable allowlist for the exact commit range being released.

Minimum schema:

```json
{
  "schema": 1,
  "environment": "production",
  "issue": 336,
  "pr": 72,
  "serving_base_commit": "<current-serving-cf-repo>",
  "rollback_target_commit": "<commit-or-version-used-for-rollback>",
  "allowed_commits": [
    { "commit": "<sha>", "issue": "#336", "pr": "#72", "reason": "approved production change" }
  ],
  "blocked_labels": ["no-prod-deploy"],
  "commit_labels": [
    { "commit": "<sha>", "labels": ["no-prod-deploy"] }
  ],
  "blocked_markers": ["no-prod-deploy", "No deploy"],
  "must_preserve_commits": [
    { "commit": "<sha>", "issue": "#226", "reason": "already served hotfix" }
  ],
  "state_changes": {
    "secrets": [],
    "vars": [],
    "d1_migrations": [],
    "kv_writes": [],
    "queues": []
  }
}
```

Rules:

- Every commit in `serving_base_commit..HEAD` must appear in `allowed_commits`.
- Any commit listed in `blocked_commits`, tagged by `commit_labels` with a blocked label, or containing a `blocked_markers` string in its commit message blocks deploy.
- `must_preserve_commits` must be reachable from `HEAD`.
- `state_changes` must list secret, var, D1, KV, and Queue changes explicitly, even when each list is empty.
- Staging deploys use `npm run deploy:staging:dry-run` or `npm run deploy:staging -- --yes`; production deploys use `DEPLOY_GUARD_MANIFEST=<path> npm run deploy` or makoto-prime `scripts/deploy-cloudflare-worker.sh --manifest <path>`.
