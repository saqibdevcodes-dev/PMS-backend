# Enterprise Property Management System backend

A centralized TypeScript and Express REST API for web, Electron, and Capacitor applications. PostgreSQL stores business records; Redis and BullMQ handle throttling, caching and background delivery. Images, documents and reports use private files in the backend's `uploads/` directory by default. S3-compatible storage remains optional.

Customer accounts now have a separate portal with invitations, ownership-scoped records, shared documents and statements. See the [customer portal rollout guide](docs/customer-portal.md) and the [security finding discovered during validation](docs/security-review-2026-10-04.md) before deployment.

Photo uploads, payment proof and custom document names require the new [image-backed forms migration and API contracts](docs/form-images.md).

## Local setup

Use Node.js 24 LTS and Docker Desktop with Linux containers. Node.js 22.12 or newer is also supported for local development.

```powershell
npm ci
npm run setup:env
docker compose up -d postgres redis mail
npm run db:generate
npm run db:migrate
```

Set `ADMIN_EMAIL` and `ADMIN_PASSWORD` in `.env`, or run `npm run bootstrap` to generate local administrator credentials in that ignored file. Then run:

```powershell
npm run db:seed
npm run dev
```

The password must contain at least 12 characters, upper and lower case letters, and a number. Seeding creates no demonstration customers or financial transactions. Re-running the seed preserves existing passwords and customized role permissions. Start background processing in another terminal:

```powershell
npm run worker
```

If the seed reports an existing administrator but login fails, see [administrator login recovery](docs/admin-recovery.md). `npm run admin:status` checks the configured database and account; `npm run admin:reset-password` explicitly applies `ADMIN_PASSWORD` to an existing active Super Admin and revokes its sessions. Run these commands in the same backend environment and database as the API being used.

The API listens on `http://localhost:4000`. Health checks are `/health/live` and `/health/ready`. The API contract is `/api/v1/openapi.json`; its checked-in copy is [docs/openapi.json](docs/openapi.json). Development email is visible at `http://localhost:8025`. Database and Redis ports are 5434 and 6381; they bind to loopback only.

For both API and worker in containers, create the host `uploads/` directory, apply migrations and run `docker compose --profile app up -d --build`. Set `PUBLIC_API_URL` to your public backend origin on a VPS. See [local file storage and VPS deployment](docs/local-storage.md) for directory permissions, persistent Docker mounts and importing existing MinIO files. Optional MinIO uses ports 9002 and 9003 and the `s3` Compose profile.

Once the API is running, use `node scripts/smoke.mjs` to check liveness, database/Redis/storage readiness, the API contract, administrator login and an authenticated request. It reads the administrator credentials from `.env`, prints no credentials or tokens, and logs its test session out afterward. Check containers with `docker compose --profile app ps` and logs with `docker compose logs --tail=100 api worker`.

### Using your own PostgreSQL installation

Start PostgreSQL yourself and create the `pms` database. Set `DATABASE_URL` in `.env` to your actual user, password, host and port; the supplied configuration uses port `5434`, while a separate PostgreSQL installation may use `5432`. Run `npm run db:migrate` and `npm run db:seed` after it is available. Do not start the Compose `postgres` service when using that installation. Redis is also required; start the other local services with `docker compose up -d redis mail`, or configure their URLs for your existing services. Local uploads need only a writable backend directory.

## Implemented workflows

- Web and native login, rotating refresh tokens, replay revocation, password recovery, device sessions, editable roles and project assignments.
- Project configuration, property inventory, price and status history, bulk import, encrypted identity and duplicate-customer detection.
- CRM activities, quotations, follow-ups, site visits, customer conversion, reservations, booking approvals and versioned payment schedules.
- Verified collections, partial installment allocation, reusable advance credit, cleared receipts, idempotency and controlled reversals.
- Recovery cases, promises to pay, dealer allocations, commission approvals and single settlement.
- Sequential approvals, NDC issuance, full ownership transfer, cancellation, staged refunds, inspections, snags and possession.
- Chart of accounts, balanced journals, locked accounting periods, bank reconciliation, trial balance and financial reports.
- Private validated uploads, versioned PDF templates, background PDF/XLSX exports, notifications, transactional outbox, dashboard and append-only audit history.

Project resources use `/api/v1/projects/{projectId}/...`. Every access requires both the endpoint permission and project membership, including for administrators. Creating a project grants its creator membership. Use the user access endpoint to assign additional staff.

Money enters and leaves the API as decimal strings. A pending cheque is not a collection. Booking confirmation requires approved terms and the cleared down payment. Posted journals cannot be edited or deleted. Operational events post to configured accounts; the default collection credit is customer advances, and booking does not recognize property revenue.

## Verification

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run test:unit
npm test
npm run build
npm run openapi
npm audit
```

`npm run test:unit` needs no external PostgreSQL, Redis or storage service, or `.env` file. It covers exact financial arithmetic, authenticated encryption, token generation, the generated API contract, customer portal access controls and private local file downloads, including expiry, tampering and path isolation. Portal tests apply the actual migrations and run Prisma queries against embedded PostgreSQL, with email and storage mocked.

`npm test` also runs integration and background-worker tests. These create and reset an isolated `pms_test` PostgreSQL database. They never truncate the application database. An optional `TEST_DATABASE_URL` must name a database ending in `_test`. The test database account must be able to create that database (or it must already exist), apply migrations and truncate its test tables. PostgreSQL and Redis must be running. Local storage tests use `.runtime/integration-uploads` rather than application uploads. Set `STORAGE_DRIVER=s3` and start MinIO for S3 integration coverage; CI checks both drivers. Tests cover simultaneous reservations, token replay, project isolation, payments, advance allocation, reversals, approvals, ownership, refunds, possession, journal constraints, pagination and private exports. Worker tests launch and stop a separate compiled worker using the test queue.

## Documentation

- [Architecture, schema design and permission matrix](docs/architecture.md)
- [Frontend integration for web, Electron and Capacitor](docs/frontend-integration.md)
- [Business rules and reporting definitions](docs/business-rules.md)
- [Deployment, recovery and operational configuration](docs/deployment.md)
- [Local file storage and VPS deployment](docs/local-storage.md)
- [Latest verification results and remaining service checks](docs/verification.md)

External SMS and push services use configurable authenticated HTTP adapters; email uses SMTP. Provider credentials are required for external delivery. The optional malware scanner uses an HTTP scan adapter. The backend reports provider failures and retries them; it does not fabricate delivery success.

docker compose -p pms-be --profile app build api worker &&
docker compose -p pms-be --profile app stop api worker &&
docker compose -p pms-be --profile app run --rm --no-deps api npm run db:migrate &&
docker compose -p pms-be --profile app up -d --no-deps --force-recreate api worker
