# Image-backed forms

Apply `202610040001_form_images` and `202610060001_customer_photo` with `npm run db:migrate`, regenerate Prisma with `npm run db:generate`, rebuild and restart the API. These migrations add the image asset table, optional record relations and supporting metadata; they preserve existing rows. The customer-photo migration adds the nullable `Customer.photoId` relation, with no backfill required. Database migrations are an operator deployment step and were exercised against the in-memory test database during implementation.

`POST /api/v1/images` accepts multipart `file`, `purpose` and (for project-scoped records) `projectId`. Purposes are PROJECT, UNIT, FEATURE, CUSTOMER, DEALER, USER and PAYMENT. It validates JPEG/PNG/WebP bytes and extensions, enforces 5 MiB and checks staff permissions and membership. It returns an image ID, never a public storage key. `GET /api/v1/images/:id` authorizes access before issuing a 120-second signed preview link. Customer accounts cannot access this staff upload API.

Request changes:

- Projects: optional `photoId`; PATCH also accepts `null` to remove an existing photo.
- Customers: optional `photoId` from a CUSTOMER image in the same project; PATCH also accepts `null` to remove it. Upload requires `customers.create` or `customers.update` and project membership. Preview requires `customers.read`, `customers.create` or `customers.update` and membership. Public customer create/list/detail/update responses include `photoId`, without storage keys.
- Units: optional `photoId`, `typeDetails` required for OTHER, fixed `measurementUnit` choices, and `featureImages: [{ feature, imageId }]`. Each feature image must match a selected feature and the project.
- New dealers and users: required `photoId` with the correct upload purpose. Existing records need no backfill.
- Payments: `proofImageId` required unless the method is CASH; `methodDetails` required for OTHER. Validation runs in the idempotent transaction, preventing duplicate payments on retry.
- Document upload: required `name` for display and download. The file's validated extension is appended if absent; names cannot include paths or control characters. Signed downloads include the stored display name.

Regenerate API metadata with `npm run openapi`, followed by `npm run generate:api` in FE when changing these contracts. The image and document endpoints depend on the existing private S3-compatible storage configuration; optional malware scanning uses the existing scanner setting. Uploads abandoned before a record is saved remain private and can be handled by an operator retention/cleanup policy.

`tests/form-images.test.ts` checks authentication, roles, project scope, signature/size validation, customer photo creation/replacement/removal, portal password provisioning and rollback, Other details, required payment proof, payment retry behavior and document names using in-memory PostgreSQL. The full infrastructure integration fixtures also include the new required fields.

See the [frontend workflow and language guide](../../FE/docs/forms-and-languages.md) in the parent PMS workspace.
