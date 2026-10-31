#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

revision=${1:?Expected the GitHub commit SHA}
release=${2:?Expected the uploaded release directory}
base=/var/www/PMS-BE
[[ "$revision" =~ ^[a-f0-9]{40}$ ]] || { echo 'Invalid release revision' >&2; exit 1; }
[[ "$release" =~ ^/var/www/PMS-BE/\.deploy/releases/$revision-[0-9]+-[0-9]+$ ]] || {
  echo 'Invalid release directory' >&2
  exit 1
}
[[ -f "$base/.env" && -f "$base/compose.yaml" && -d "$base/uploads" ]]
command -v flock >/dev/null
exec 9>"$base/.deploy/deploy.lock"
flock -w 900 9
cd "$release"
sha256sum --check SHA256SUMS

image="pms-backend:$revision"
override="$release/compose.release.yaml"
rollback="$release/compose.rollback.yaml"
cat > "$override" <<EOF
services:
  api:
    image: $image
    pull_policy: never
  worker:
    image: $image
    pull_policy: never
EOF

compose=(docker compose --project-directory "$base" --env-file "$base/.env" -p pms -f "$base/compose.yaml" --profile app)
current=("${compose[@]}" -f "$override")
previous=("${compose[@]}" -f "$rollback")

# Refuse to create another database/Redis stack or deploy over a stopped production stack.
for service in postgres redis mail api worker; do
  container=$("${compose[@]}" ps -q "$service")
  [[ -n "$container" ]] || { echo "Production service $service is not running in project pms" >&2; exit 1; }
  [[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]]
  if [[ "$service" == postgres || "$service" == redis ]]; then
    [[ $(docker inspect --format '{{.State.Health.Status}}' "$container") == healthy ]]
  fi
done

docker load --input "$release/backend-image.tar.gz"
[[ $(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$image") == "$revision" ]]
old_api=$(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q api)")
old_worker=$(docker inspect --format '{{.Image}}' "$("${compose[@]}" ps -q worker)")
docker image tag "$old_api" "pms-backend:rollback-api-$revision"
docker image tag "$old_worker" "pms-backend:rollback-worker-$revision"
cat > "$rollback" <<EOF
services:
  api:
    image: pms-backend:rollback-api-$revision
    pull_policy: never
  worker:
    image: pms-backend:rollback-worker-$revision
    pull_policy: never
EOF

application_changed=0
on_failure() {
  local code=$?
  trap - ERR
  set +e
  "${current[@]}" logs --tail=60 api worker >&2
  if [[ "$application_changed" == 1 ]]; then
    echo 'Deployment failed; restoring the previous API and worker images. Database migrations are not reversed.' >&2
    if "${previous[@]}" up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 180 api worker; then
      echo 'Previous application images restored; deployment remains failed.' >&2
    else
      echo 'Automatic application recovery failed; inspect the production containers.' >&2
    fi
  fi
  exit "$code"
}
trap on_failure ERR

# Keep a private database backup on the VPS; never upload it to GitHub artifacts.
# These variables must expand inside the PostgreSQL container, not on the host.
# shellcheck disable=SC2016
"${compose[@]}" exec -T postgres sh -c \
  'pg_dump --username="$POSTGRES_USER" --dbname="$POSTGRES_DB" --format=custom' \
  > "$release/database-before.dump"
test -s "$release/database-before.dump"

application_changed=1
"${compose[@]}" stop api worker
"${current[@]}" run --rm --no-deps --pull never api npm run db:migrate
"${current[@]}" up -d --no-deps --no-build --pull never --force-recreate --wait --wait-timeout 180 api worker

for service in api worker; do
  container=$("${current[@]}" ps -q "$service")
  [[ $(docker inspect --format '{{.State.Running}}' "$container") == true ]]
  [[ $(docker inspect --format '{{.Image}}' "$container") == "$(docker image inspect --format '{{.Id}}' "$image")" ]]
done

# Verify through the same public HTTPS endpoint used by browsers, including Nginx.
docker run --rm --network host --user "$(id -u):$(id -g)" --entrypoint node \
  --mount "type=bind,source=$release,target=/release,readonly" \
  "$image" /release/verify-release.mjs "$revision" /release/openapi.json

printf '%s\n' "$revision" > "$base/.deploy/current-revision"
cp "$override" "$base/.deploy/current-compose.yaml"
trap - ERR
echo "Successfully deployed and verified backend revision $revision to project pms"
