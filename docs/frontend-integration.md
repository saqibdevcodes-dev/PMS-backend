# Frontend integration

All clients share `/api/v1`, the same database and the same authorization rules. Generate client types from `docs/openapi.json`. Configure the API base URL in the client environment. Send `X-Client-Version: 1.0.0` and preserve `X-Request-Id` for support diagnostics. An outdated version receives `426 CLIENT_UPGRADE_REQUIRED`.

## Web and Next.js

Use a same-origin HTTPS reverse proxy in production. Keep the access token in application memory. Send `Authorization: Bearer <accessToken>` on authenticated requests. Login and refresh must send a trusted `Origin` and use `credentials: 'include'`. Their refresh token arrives only as an HttpOnly cookie scoped to `/api/v1/auth/refresh`.

```typescript
const result = await fetch('/api/v1/auth/login', {
  method: 'POST',
  credentials: 'include',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email, password }),
}).then((response) => response.json());
const accessToken = result.data.accessToken;
```

On access-token expiry, serialize refresh attempts within the client. `POST /auth/refresh` has an empty JSON body. Concurrent refreshes using the same cookie can trigger replay revocation, so use a single refresh coordinator shared across tabs when practical. After refresh, retry only safe reads or idempotent writes using their original keys.

Logout uses the access-token-authenticated `/auth/logout` route and clears the refresh cookie. `/auth/logout-all` revokes every session. Browser cookie authentication is not used for ordinary business mutations. Origin checking and SameSite cookies protect the web refresh contract.

## Electron

Use `/auth/native/login` with `platform: "electron"` and an installation identifier. The result includes `accessToken`, `refreshToken`, `sessionId`, `expiresIn` and `refreshExpiresAt`. Keep refresh tokens in OS-backed secure storage through a narrowly scoped main-process adapter. Do not expose them to untrusted renderer content, URLs or localStorage. Hardware scanning and printing remain client responsibilities.

## Capacitor Android and iOS

Use the same explicit native routes with `platform: "android"` or `"ios"`. Store the refresh token through the chosen native Keychain/Keystore adapter. `POST /auth/native/refresh` accepts `{ "refreshToken": "..." }` and rotates it. Persist the replacement atomically before processing another refresh. Device biometrics can unlock local secure storage; they do not replace server session validation.

The platform field and installation identifier carry metadata, not authorization. Requests from embedded webviews must use configured origins such as `capacitor://localhost`; arbitrary origins are rejected. Native HTTP stacks without Origin still require valid tokens.

## Shared contracts

Successful responses contain `success`, `data` and `meta.requestId`. Paginated data contains `items` and `pagination` with `page`, `limit`, `total` and `totalPages`. Error responses contain `error.code`, `error.message`, optional details and request metadata. `401` means reauthentication may be required, `403` is denied permission or separation of duties, `404` also conceals inaccessible project records, and `409` indicates a conflicting business state.

List query parameters are documented per endpoint in OpenAPI. Payment plans, vendors, document templates, NDCs, transfers, cancellations and possessions return the paginated shape. Pages default to 25 items and allow at most 100. Workflow lists support `bookingId` and `status`; plans, vendors and templates support name search. Workflow list sorting uses stable record IDs; do not interpret it as chronological order.

Send monetary amounts as strings, for example `"125000.50"`. Keep decimal arithmetic in a decimal library on the client. Never submit binary floating-point money. `Idempotency-Key` is required for payment creation and verification. Reuse the same key only with the same operation and payload. Generate a new key for a new operation.

Use `POST /projects/{projectId}/payments/{id}/allocate-advance` with an empty body to apply an existing cleared payment's remaining credit to that booking's outstanding installments. It requires `payments.verify`. Refresh the booking position afterward. Financial report responses include `summary` totals alongside their `rows`.

Business operations remain online. A cached available-unit view does not authorize a reservation. Only the server can reserve, verify payments, post journals or change ownership. On network interruption, query the operation or retry with its existing idempotency key. Never manufacture an offline receipt or transfer confirmation.

Upload PDF, JPEG or PNG using multipart form data with a `file` part and optional `customerId`/`bookingId`. Downloads return private signed URLs valid for 120 seconds. Customer-linked documents also require `customers.view_sensitive`. Generate large reports with `/reports/exports`, poll your job, then request its download URL. A user's project access is checked again before generation and on download.

Register push installations with `POST /devices` and revoke them with `DELETE /devices/{id}`. Push payloads contain a generic message directing the user to open the application. The notification provider must never treat an installation ID as proof of identity.
