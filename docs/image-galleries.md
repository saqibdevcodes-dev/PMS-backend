# Project and property photos

Projects and properties accept an ordered `photoIds` array containing up to five unique image IDs. Upload each file through `POST /api/v1/images`, using purpose `PROJECT` or `UNIT` respectively. Property uploads also require their `projectId`. JPEG, PNG and WebP files are limited to 5 MiB each.

The first image is the cover. The API keeps the legacy `photoId` field synchronized with it. Existing photos are backfilled by migration `202610120001_image_galleries`.

Create with `POST /projects` or `POST /projects/{projectId}/units`. Edit with `PATCH /projects/{projectId}` or `PATCH /projects/{projectId}/units/{id}`. Send the complete remaining gallery to remove, replace or reorder photos. An explicit `photoIds: []` clears it; an omitted field preserves it. Property edits require `inventory.update`; price, charges and status changes keep their existing separate workflows.

Removing a photo detaches it from the record. It does not delete the stored file, so cancelling edits or a failed save cannot destroy the previous photo. Files use the existing configured local or S3 storage driver and authorized, temporary preview URLs. The server validates image purpose and project access for every gallery entry.

## Local Docker update

Running containers keep their previous code until they are recreated. In the backend directory, run each command after the previous one succeeds:

```powershell
docker compose --profile app build api worker
docker compose --profile app run --rm --no-deps api npm run db:migrate
docker compose --profile app up -d --no-deps --force-recreate --wait api worker
```

The running API contract at `http://localhost:4000/api/v1/openapi.json` must include `photoIds` with `maxItems: 5` in the property creation request. An `Unrecognized key: "photoIds"` response means the request reached an older backend schema. Refresh the frontend after updating the backend.

## VPS update

Deploy the backend and database migration through the [backend production pipeline](deployment.md#production-pipeline) before deploying the new frontend. The workflow deploys the validated image to the existing `pms` project.

Then run the usual frontend deployment. Existing database and upload volumes must remain in place.
