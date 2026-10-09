# Customer portal

Implemented in the backend and the React frontend in `../FE`. The customer sign-in route is `/portal/login`; invitations open `/portal/activate`. This change has been verified locally with isolated test data, but has not been deployed or migrated on the production server.

## Customer experience

- Dashboard with confirmed-booking balances grouped by project and currency, and the next unpaid installments.
- Own properties, booking details, installment schedules, payment history, printable receipts and downloadable PDF statements.
- Documents explicitly shared by staff, NDC/transfer/refund/possession status, in-app notifications, linked contact profiles, password changes and session management.

Balances describe the whole booking, including joint ownership. Individual payment rows and receipts are restricted to payers linked to the signed-in account. Cancelled bookings remain historical records; the dashboard and installment list include confirmed bookings only. Customers contact the office to correct contact/business records or initiate business workflows. This release does not add an online payment gateway.

## Giving a customer access

Staff can give a new customer immediate portal access in **Add customer** by entering an email and an optional password. This requires `customers.create`, project membership and `customers.portal.manage`. The password uses the existing policy: 12–128 characters with upper and lower case letters and a number. The backend hashes it with Argon2id and creates a separate CUSTOMER account and profile link in the same transaction; it returns and audits no credentials. An email already assigned to any account is rejected without linking it or changing its password. Use invitations to link an existing customer account safely.

Leaving the password blank creates the customer business record without a login. The existing invitation flow below remains available, including for existing customer accounts. Customer editing never accepts a password; password changes and recovery use the existing authentication flows.

1. Staff opens **Customers**, selects a customer and verifies that the saved email belongs to that customer.
2. Under **Customer portal access**, select **Invite customer**. This requires project membership and `customers.portal.manage`.
3. The worker emails a single-use link valid for 48 hours. The customer sets a password and signs in at `/portal/login`.
4. An existing customer account can accept another profile invitation using its current password. This links profiles without changing its password. Staff accounts cannot be converted through invitations; use a separate customer email.

Resending invalidates older invitations. Revoking access unlinks that profile, cancels pending invitations and revokes the user's sessions, while preserving business records. Other linked profiles remain accessible after a fresh sign-in. The migration grants the new permission to the existing **Super Admin** role; assign it to other appropriate staff roles using the existing role-management interface.

## Access boundaries

Customer accounts have `accountType=CUSTOMER`. Authentication strips all staff permissions from these accounts, and the HTTP boundary rejects staff routes even if a staff role was assigned accidentally. Customer endpoints derive ownership from the authenticated account, never from a supplied customer ID.

A primary customer or current booking owner can view a booking. Completing an ownership transfer removes the former owner's access. Documents default to private: staff must explicitly share each linked document. Customer-specific documents require `customers.view_sensitive` to share and remain restricted to that customer, including after a transfer. Internal approval notes, identity details and another payer's receipts are not returned by portal endpoints.

Download links expire after 120 seconds. Withdrawing sharing blocks new downloads, but an already issued link can remain valid until expiry. PDF statements allow up to 5,000 schedule rows and 5,000 payment rows; larger statements require office assistance. Configure a storage lifecycle policy for generated `portal-statements/` objects (for example, one day); these are generated copies rather than source records.

## Production rollout

Review [the lint configuration security finding](security-review-2026-10-04.md) before running deployment jobs on affected machines. The steps below are for the existing production environment; they were not run against it during implementation.

1. Back up the production database using the existing operational procedure.
2. Deploy the backend source and install dependencies in a trusted build environment:

   ```sh
   npm ci
   npm run db:generate
   npm run build
   npm run db:migrate
   ```

   Migration `202610030001_customer_portal` adds account types, customer links, invitations, document visibility and the invitation-management permission. Apply `202610040001_form_images` and `202610060001_customer_photo` for the private customer-photo upload field. Existing users remain staff, existing documents remain private and existing customers need no photo backfill.

3. Configure the API **and worker** with the existing database, Redis, encryption and storage settings. Set `PUBLIC_WEB_URL=https://etihadrealestate.tech`, and configure `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD` and `SMTP_FROM` for the email provider. The API rejects invitations when SMTP is not configured.
4. Restart the API and background worker using the deployment's existing process manager. The compiled worker entry point is `dist/src/jobs/worker.js`; it handles the encrypted invitation outbox and notifications. Keep both processes on the same release and encryption configuration.
5. Deploy the frontend after the backend. Keep the existing production API URL `https://api.etihadrealestate.tech/api/v1`. See the [frontend guide](../../FE/docs/customer-portal.md) and its existing production deployment instructions. Keep HTTPS, secure cookies and the frontend's exact origin in the backend CORS/trusted-origin configuration.
6. As authorized staff, invite a designated test customer with a controlled email address. Verify delivery, activation, sign-in, refresh, balances, shared-document download, statement download and revocation. Check customer access against another customer's booking. This final smoke test uses real delivery/storage and remains a deployment check.

No local Docker services or production business data were used for the implementation tests.

## Verification

Validation on 2026-10-04: 36 backend tests, 14 frontend unit tests and 5 portal browser tests passed. Both repositories passed TypeScript checks, lint and production builds; the Prisma schema validated. The frontend build retains a non-blocking warning for an existing bundle above 500 kB. Browser screenshots use fixture data. Live SMTP/storage delivery and post-deployment customer sign-in remain rollout checks.

`npm run test:unit` includes portal HTTP and database tests. PGlite runs the actual SQL migrations and Prisma queries in embedded PostgreSQL without an external database. Email, storage and rate-limit providers are replaced with test doubles. Coverage includes account separation, cross-customer access, exact balances, document visibility, invitation expiry/replay/revocation, existing-account password checks, ownership transfer and session invalidation.

The API contract is regenerated in `docs/openapi.json`. Customer-only operations have `x-audience: customer`; shared authentication operations have `x-audience: authenticated`. See `src/modules/portal/contracts.ts` for the explicit response shapes.
