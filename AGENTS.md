# Project instructions

## Git and production deployment policy

User preference confirmed on 2026-10-28. Applies to MoySklad Cloud, the MCP
gateway, their backends, adapters, authentication, proxy and monitoring.

- A request to implement or fix something authorizes development and appropriate
  verification; it does not by itself authorize a production deployment.
- Obtain explicit authorization for the current release before deploying to
  production. Do not reuse permission for an earlier release. An explicit request
  to deploy the current release is sufficient; do not ask again unnecessarily.
- Git is the source of truth. Production changes must correspond to committed
  and pushed source/configuration. Never deploy uncommitted local working trees.
- Target workflow: PR and checks, merge, CI builds a Docker image once and
  publishes it with application version, Git SHA and build metadata; a separately
  authorized deployment pulls the pinned image/digest onto the VPS.
- Use the deployment repository to pin image versions/digests. Keep credentials
  and private runtime data outside Git. A push or merge alone is not permission
  to deploy, and CI must not deploy production automatically on every push.
- Do not edit application source directly on the VPS or build releases there as
  the normal deployment method. If CI/CD is not yet configured, prepare the Git
  changes and deployment procedure first; this policy does not mean CI/CD already
  exists. A one-off direct deployment requires an explicit user exception.
- Before deployment, check active long-running jobs and preserve the previous
  image/configuration for rollback. After deployment, verify health, the relevant
  application path and the reported application version/build identity.
- Read-only production diagnostics and health checks remain allowed without a
  separate deployment approval. Report code/test/Git status separately from what
  is actually running in production.
- Before introducing CI/CD, reconcile the current VPS deployment with Git,
  preserving unrelated user changes; do not reset or stage dirty repositories
  wholesale. Any authorized emergency source changes must be reconciled into Git.
