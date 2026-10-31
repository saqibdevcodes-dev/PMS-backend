# Deployment and operations

## Production pipeline

The backend repository's `.github/workflows/ci.yml` runs three dependent stages:

1. **Validate and test**: clean dependency installation, isolated infrastructure, migrations, type checking, lint, formatting, unit tests, full database/workflow tests, S3 integration tests, generated OpenAPI comparison, dependency audit and deployment regression checks.
2. **Build release image**: build the checked-out revision, require the compiled calendar module, smoke test the actual API/worker image against isolated services, and publish a checksummed artifact containing the Docker image, API contract and activation/verification scripts.
3. **Deploy and verify production**: for `main` pushes or a manual run on `main`, upload that artifact over SSH, activate it in the existing `pms` Compose project, and verify the public API from both the VPS and GitHub runner. Pull requests targeting `main` validate and build without deploying. A superseded revision of `main` cannot begin deployment.

In the **backend GitHub repository**, create the `production` environment and configure these secrets there (or as repository secrets accessible to this environment):

| Secret            | Value                                                                        |
| ----------------- | ---------------------------------------------------------------------------- |
| `VPS_HOST`        | Production VPS IP address or SSH hostname                                    |
| `VPS_USER`        | Existing deployment account                                                  |
| `VPS_SSH_KEY`     | Private SSH key authorized for that account                                  |
| `VPS_KNOWN_HOSTS` | Trusted SSH host-key entry for that VPS, including the port when nonstandard |

The optional environment/repository variable `VPS_PORT` defaults to `22`. Frontend repository secrets are not automatically available to the backend repository. Restrict the production environment to the `main` branch. Existing environment approval rules still apply.

The deployment account needs Docker access and write access to `/var/www/PMS-BE/.deploy`. The VPS needs Bash, `rsync`, `flock`, and Docker Compose with `--wait` support. The current `/var/www/PMS-BE/.env`, `compose.yaml`, `uploads/`, and running `pms` PostgreSQL, Redis, mail, API and worker services must already exist. Deployment fails before stopping the application when those prerequisites or database/Redis health checks fail. It does not create another infrastructure stack or change Nginx.

The pipeline loads the image built by GitHub and supplies its immutable revision tag through a Compose override. It preserves the existing Compose configuration, environment, upload bind mount and database volumes. The host's old source checkout is no longer a deployment input; it need not contain newly added source files. Do not rebuild that old checkout to release changes. The compiled code in the deployed image comes from the checked-out pipeline revision.

Before stopping API/worker, activation creates a private PostgreSQL backup under `.deploy/releases/<revision>-<run>-<attempt>/database-before.dump`. It then runs `prisma migrate deploy` from the new image and recreates only API/worker, without rebuilding or pulling images. Both containers must run the expected image. `/health/live` must report the exact revision, readiness must succeed, the public OpenAPI contract must equal the release artifact, and both calendar endpoints must reject anonymous requests with HTTP 401 rather than endpoint-not-found. A reachable OpenAPI URL alone does not count as successful deployment.

Activation failures after stopping the application attempt to restore both previous application images and still fail the workflow. Database migrations are **not** reversed automatically; keep migrations compatible with the previous release. Backups and release images remain on the VPS for recovery; manage their retention and disk space. Never publish `.deploy` or its backups as static files or GitHub artifacts.

Successful deployment records `.deploy/current-revision` and `.deploy/current-compose.yaml`. Production deployments are serialized. No manual source upload or server-side repository update is part of the release process.

## Runtime and secrets

Build from the committed lockfile with `npm ci`. The Docker image targets Node.js 24 LTS. Run API and worker as separate processes from the same release. Apply `prisma migrate deploy` as a release step before starting them; do not run interactive migrations against production.

Use PostgreSQL, authenticated/TLS Redis and private persistent file storage in production. The Compose stack supplies local services with loopback-bound host ports; its generated passwords are development credentials. Supply production secrets through your deployment secret manager, including JWT key ring, identity encryption/search keys, database URL and provider credentials. Object-store credentials are needed only for the optional S3 driver. Keep `.env`, uploaded files and database backups out of source control.

Set `NODE_ENV=production`, `COOKIE_SECURE=true`, HTTPS `PUBLIC_WEB_URL`, an explicit `TRUSTED_ORIGINS` list and the exact number of trusted reverse-proxy hops. The application rejects insecure production API requests. Do not trust arbitrary forwarded headers. Enforce TLS at the load balancer and configure PostgreSQL certificate validation in its connection settings.

JWT key rotation uses `JWT_KEYS`, a JSON object keyed by signing key ID. Change `JWT_ACTIVE_KID` to the new key while retaining old verification keys for at least the maximum access-token lifetime. Refresh tokens are independent opaque values. Changing the identity search key requires rebuilding search hashes from decrypted identities; encryption key rotation requires a controlled re-encryption migration. Back up keys separately and restrict access.

`STORAGE_DRIVER=local` is the default. Set HTTPS `PUBLIC_API_URL` to the backend origin and persist the backend's `uploads/` directory with permissions for the API and worker. Compose shares a bind mount between both processes. See [local file storage](local-storage.md) for VPS commands and importing existing MinIO files. Files are served through signed API links, not a public static directory. Access links expire in 120 seconds.

Alternatively, set `STORAGE_DRIVER=s3` and provision the private bucket before starting production. Keep public access disabled and configure `S3_PUBLIC_ENDPOINT` to a hostname accessible to clients. Signed URLs must use the same bucket and credentials as the internal endpoint. Start the optional Compose `storage` service before the API and worker when using MinIO. For either driver, encrypt backups and periodically review files with no corresponding metadata after interrupted uploads.

## Providers and policies

Configure SMTP host, port, TLS, sender and optional credentials for password recovery and email. Local Mailpit is only for development. SMS and push adapters POST JSON to configured endpoints with a bearer provider token. They must return a successful HTTP status only after accepting delivery. Configure optional `MALWARE_SCAN_URL` to accept raw file bytes and return `{ "clean": true }` only for a clean result; timeouts and non-clean responses reject the upload.

Assign business-specific approval thresholds, dealer percentages, project rules and chart-of-account mappings before production use. No statutory charge, tax rate or legal deduction is assumed. Ledger mappings are editable only through `settings.manage` and require compatible account types. Seeded roles are starting templates and can be changed through the role APIs. All administrators still need project membership.

## Monitoring and recovery

`/health/live` checks process liveness. `/health/ready` checks PostgreSQL, Redis and the configured storage directory or private bucket. `/api/v1/metrics` exposes authenticated Prometheus metrics to a user with `users.manage`; keep the scrape credential in a monitoring secret. Structured logs include request IDs and route paths without query strings, request bodies or authentication tokens. Monitor HTTP error rates, queue failure events, old undispatched/unprocessed outbox rows and failed background job records.

Workers retry delivery up to eight times with exponential backoff. Keep completed BullMQ event IDs while corresponding outbox rows are retained. A crash after queue insertion and before outbox acknowledgement safely retries the same job ID. Archive old successful queue/outbox records together using an operational retention job; never delete pending or failed records. Retain audit and financial history according to the organization's documented retention policy.

Use a least-privilege runtime PostgreSQL role without DDL, TRUNCATE, migration or trigger-disable privileges. Run migrations with a separate owner role. Grant application tables only the required SELECT/INSERT/UPDATE permissions; financial tables and audit logs should have no DELETE grant. Triggers independently reject journal/audit mutation. The local Compose owner account is for development and migrations, not production runtime.

## Backup and restore

Schedule encrypted PostgreSQL backups and point-in-time recovery/WAL archiving. Back up the host `uploads/` directory (or S3 objects), encryption keys and configuration. A backup is not verified until a restore is tested in isolation. Before restoring production, stop API and workers, restore the database and corresponding file/bucket snapshot, validate migrations and financial trial balance, then restart workers and API. Existing Redis work may reference old state; replay authoritative pending PostgreSQL outbox events into a fresh queue when recovering from a database snapshot.

Example development backup commands are `pg_dump --format=custom --file=pms.dump <DATABASE_URL>` and `pg_restore --clean --if-exists --dbname=<RESTORE_DATABASE_URL> pms.dump`. Provide connection secrets through protected environment variables or service files instead of shell history. Use a separate restore target for drills.

## Release verification

CI runs formatting/lint checks, type checking, Prisma generation and migration deployment into isolated PostgreSQL, integration tests against PostgreSQL/Redis/private object storage, the build, OpenAPI generation and dependency audit. Production rollout additionally needs real provider credentials, a verified backup, organization-approved business policies and load testing for the intended portfolio size. The checked-in tests verify implemented workflows; they are not a claim of operational certification.
