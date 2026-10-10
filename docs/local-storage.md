# Files stored in the backend directory

The default `STORAGE_DRIVER=local` stores images, documents, PDF statements and generated PDF/XLSX reports in `uploads/`. Files stay private: the existing authenticated endpoints check permissions and return a signed backend URL valid for 120 seconds. The frontend uses the same upload and download API as before. No S3 account or MinIO service is required for new uploads.

`PUBLIC_API_URL` is the browser-accessible backend origin, without `/api/v1`. For example, if the frontend API setting is `https://api.etihadrealestate.tech/api/v1`, use `PUBLIC_API_URL=https://api.etihadrealestate.tech`. Use your actual API domain if it differs. Production requires HTTPS. Development defaults to `http://localhost:4000`.

When running directly with Node, `UPLOAD_DIR=uploads` is relative to the backend working directory. Compose always mounts the host's `./uploads` into `/app/uploads` for both API and worker. Rebuilding or replacing containers preserves these files. The directory is excluded from Git, Docker build context and formatting checks.

## Existing VPS deployment

After committing these changes, pushing them and pulling the new backend code onto the VPS, edit `/var/www/PMS-BE/.env`. Keep the existing database, login, encryption and other settings. Add or update:

```dotenv
STORAGE_DRIVER=local
UPLOAD_DIR=uploads
PUBLIC_API_URL=https://api.etihadrealestate.tech
```

Replace the API domain above if necessary. Compose overrides `UPLOAD_DIR` to `/app/uploads` inside its containers.

Prepare the host directory for the container's `node` user (UID/GID 1000). Use the existing `pms-be` Compose project to reuse the running database and Redis:

```bash
cd /var/www/PMS-BE
install -d -o 1000 -g 1000 -m 750 uploads
docker compose -p pms-be --profile app build api worker
docker compose -p pms-be --profile app stop api worker
```

If there are existing images/documents in the running MinIO service, import them **before restarting the application**. Keep the old S3 settings in `.env` for this command and keep the existing storage container running:

```bash
docker compose -p pms-be --profile app run --rm --no-deps api npm run storage:import-s3
```

The importer copies every object into the same relative key under `uploads/`; database references remain valid. It leaves the source bucket intact. Run it while API and worker are stopped; repeating it replaces local files with the source versions. If the import fails, leave the source storage intact, resolve the error and rerun it before switching the application. Skip this step when there are no existing files.

Apply migrations and start the new release:

```bash
docker compose -p pms-be --profile app run --rm --no-deps api npm run db:migrate
docker compose -p pms-be --profile app up -d --no-deps --force-recreate api worker
docker compose -p pms-be --profile app ps
curl --fail http://127.0.0.1:4000/health/ready
```

Upload an image in the dashboard and confirm that it displays. Check an existing image/document if you imported old files. If needed, inspect `docker compose -p pms-be logs --tail=100 api worker`.

No Nginx static directory is needed; the API serves `/api/v1/files?token=...` through the existing API proxy. The frontend Nginx Content Security Policy must allow the backend origin for images. Its `img-src` directive should include:

```text
img-src 'self' data: blob: https://api.etihadrealestate.tech;
```

Update the existing frontend HTTPS server block (typically `/etc/nginx/sites-available/etihadrealestate.tech`), preserve its certificate settings, and run `nginx -t && systemctl reload nginx`. The frontend repository's Nginx template now includes this permission; static frontend releases do not update the active host configuration automatically.

Do not expose `uploads/` as a public Nginx directory. Avoid logging query strings for the files endpoint in the reverse proxy because the token grants temporary access. Retain the old MinIO container and volume until imported files are verified; no removal is part of this change.

## Local development and optional S3

Direct Node development creates `uploads/` automatically. For Docker Desktop, create the host folder before starting containers:

```powershell
New-Item -ItemType Directory -Force uploads
docker compose --profile app up -d --build
```

For Linux Docker, prepare the directory with `install -d -o 1000 -g 1000 -m 750 uploads` first.

S3-compatible storage remains available with `STORAGE_DRIVER=s3` and the existing `S3_*` configuration. When using the bundled MinIO service, start it with `docker compose --profile s3 up -d --wait storage` before starting the API and worker. Set `S3_PUBLIC_ENDPOINT` to its browser-accessible HTTPS endpoint. Tests use the selected driver, and CI checks both local storage and MinIO. Local filesystem tests need no external storage service.

## Backups

Back up the host `uploads/` directory together with PostgreSQL and the protected environment configuration. A database backup alone does not contain the image/document bytes. Restore the corresponding files with ownership UID/GID 1000 before starting the API and worker. Multiple hosts need a shared filesystem or the S3 driver; separate local disks do not share uploads.
