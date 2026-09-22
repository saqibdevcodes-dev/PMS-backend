# Verification status

Checked on 22 September 2026.

| Check                               | Result                                                           |
| ----------------------------------- | ---------------------------------------------------------------- |
| TypeScript type checking            | Passed                                                           |
| ESLint                              | Passed                                                           |
| Prettier formatting                 | Passed                                                           |
| Production build                    | Passed on Windows and in the Node.js 24 Linux image              |
| Prisma schema validation            | Passed                                                           |
| Database migrations                 | All 4 applied; database schema is up to date                     |
| Administrator seed                  | Passed; existing password preserved                              |
| Full test suite                     | 49 passed across 5 files                                         |
| API integration tests               | 30 passed against isolated PostgreSQL, Redis and private storage |
| Background-worker integration tests | 2 passed using an actual spawned BullMQ worker                   |
| Offline tests                       | 17 passed across 3 files, included in the full suite             |
| OpenAPI generation                  | Generated 130 operations across 106 paths                        |
| npm dependency audit                | 0 known vulnerabilities reported                                 |
| Docker API                          | Running and healthy on port 4000                                 |
| Docker worker                       | Running                                                          |
| Running API smoke check             | All 6 checks passed                                              |

Migration `202609220001_posted_record_guards` is applied to the application and test databases. Integration tests verified immutable payment details, legal payment status transitions, prevention of appended journal lines after posting, advance-credit allocation, balance-sheet reconciliation and pagination. Worker tests verified durable outbox dispatch, generation of an XLSX report and deduplicated in-app notification delivery.

The full run exposed an unspecified ordering of returned payment allocations. Verification and advance-allocation responses now sort by installment due date, sequence and ID. The regression checks both the installment identity and its allocated amount. The corrected suite passes all 49 tests.

The running Docker API passed liveness, dependency readiness, API-contract, administrator-login, authenticated-request and logout checks. Credentials and tokens were not printed. The smoke-check session was revoked. Application records were not reset; integration fixtures are stored in the isolated test database.

To repeat verification with the services running:

```powershell
npm run db:migrate
npm run db:seed
npm test
node scripts/smoke.mjs
```

`npm test` builds the code, creates or migrates the isolated test database, resets its test data, and runs both API and worker tests. Keep the API and worker for the application database separate from the test process. See [README](../README.md) for database connection and administrator setup.

No local implementation checks remain pending. Production rollout still requires the deployment configuration, provider credentials, business-policy review, load testing and backup-restore rehearsal described in [deployment operations](deployment.md).
