#!/usr/bin/env bash
# Exercise deployment ordering and recovery with mocked Docker; never contact a Docker daemon.
set -Eeuo pipefail
source_script="$(cd "$(dirname "$0")" && pwd)/activate-release.sh"
test_root=$(mktemp -d -t pms-deploy-test.XXXXXXXX)
[[ "$test_root" == */pms-deploy-test.* ]] || exit 1
trap 'rm -rf -- "$test_root"' EXIT
export REVISION=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
export MOCK_BASE="$test_root/backend"
export DOCKER_LOG="$test_root/docker.log"
export MOCK_STATE="$test_root/image-state"
mkdir -p "$MOCK_BASE/uploads"
touch "$MOCK_BASE/.env" "$MOCK_BASE/compose.yaml"
release="$MOCK_BASE/.deploy/releases/$REVISION-1-1"
mkdir -p "$release"
# Replace only the fixed VPS path in the test copy; production keeps its fixed path guard.
sed "s|/var/www/PMS-BE|$MOCK_BASE|g" "$source_script" > "$test_root/activate.sh"
printf 'fixture image\n' > "$release/backend-image.tar.gz"
printf '{}\n' > "$release/openapi.json"
printf '// fixture\n' > "$release/verify-release.mjs"
cp "$test_root/activate.sh" "$release/activate-release.sh"
(cd "$release" && sha256sum backend-image.tar.gz openapi.json activate-release.sh verify-release.mjs > SHA256SUMS)

flock() { return 0; }
docker() {
  printf '%s\n' "$*" >> "$DOCKER_LOG"
  if [[ "$1" == compose ]]; then
    if [[ " $* " == *' ps -q '* ]]; then
      local service="${!#}"
      [[ "$SCENARIO" != missing-postgres || "$service" != postgres ]] || return 0
      printf 'pms-%s-1\n' "$service"
    elif [[ " $* " == *' exec -T postgres '* ]]; then
      [[ "$SCENARIO" != backup-failure ]] || return 16
      printf 'private database backup fixture\n'
    elif [[ " $* " == *' run --rm '* ]]; then
      [[ "$SCENARIO" != migration-failure ]] || return 17
    elif [[ " $* " == *' up -d '* ]]; then
      if [[ "$*" == *compose.rollback.yaml* ]]; then
        echo old > "$MOCK_STATE"
      else
        [[ "$SCENARIO" != activation-failure ]] || return 18
        echo new > "$MOCK_STATE"
      fi
    fi
  elif [[ "$1" == inspect ]]; then
    if [[ "$*" == *'.State.Running'* ]]; then
      echo true
    elif [[ "$*" == *'.State.Health.Status'* ]]; then
      echo healthy
    elif [[ $(cat "$MOCK_STATE") == new ]]; then
      echo sha256:new
    else
      echo sha256:old
    fi
  elif [[ "$1 $2" == 'image inspect' ]]; then
    if [[ "$*" == *org.opencontainers.image.revision* ]]; then
      echo "$REVISION"
    else
      echo sha256:new
    fi
  elif [[ "$1" == run ]]; then
    [[ "$SCENARIO" != verification-failure ]] || return 19
  fi
  return 0
}
export -f docker flock

for SCENARIO in success missing-postgres backup-failure migration-failure activation-failure verification-failure; do
  export SCENARIO
  : > "$DOCKER_LOG"
  echo old > "$MOCK_STATE"
  status=0
  bash "$test_root/activate.sh" "$REVISION" "$release" > "$test_root/$SCENARIO.log" 2>&1 || status=$?
  if [[ "$SCENARIO" == success ]]; then
    [[ "$status" == 0 ]] || { cat "$test_root/$SCENARIO.log"; exit 1; }
    [[ $(cat "$MOCK_BASE/.deploy/current-revision") == "$REVISION" ]]
    grep -q 'pg_dump' "$DOCKER_LOG"
    grep -q 'verify-release.mjs' "$DOCKER_LOG"
    if grep -q 'compose.rollback.yaml.* up -d' "$DOCKER_LOG"; then
      echo 'Successful deployment unexpectedly rolled back' >&2
      exit 1
    fi
    backup_line=$(grep -n 'pg_dump' "$DOCKER_LOG" | cut -d: -f1)
    stop_line=$(grep -n 'stop api worker' "$DOCKER_LOG" | cut -d: -f1)
    migration_line=$(grep -n 'npm run db:migrate' "$DOCKER_LOG" | cut -d: -f1)
    up_line=$(grep -n ' up -d ' "$DOCKER_LOG" | cut -d: -f1)
    [[ "$backup_line" -lt "$stop_line" && "$stop_line" -lt "$migration_line" && "$migration_line" -lt "$up_line" ]]
  else
    [[ "$status" != 0 ]] || { echo "Expected $SCENARIO to fail"; exit 1; }
    if [[ "$SCENARIO" == missing-postgres || "$SCENARIO" == backup-failure ]]; then
      if grep -q 'stop api worker' "$DOCKER_LOG"; then
        echo 'Preflight failure stopped the application' >&2
        exit 1
      fi
    else
      grep -q 'compose.rollback.yaml.* up -d' "$DOCKER_LOG"
      [[ $(cat "$MOCK_STATE") == old ]]
    fi
  fi
  if grep -Eq 'pms-be| down| prune| up .*postgres' "$DOCKER_LOG"; then
    echo 'Deployment touched another project or infrastructure lifecycle' >&2
    exit 1
  fi
  if grep '^compose ' "$DOCKER_LOG" | grep -v -- '-p pms ' >/dev/null; then
    echo 'Deployment did not explicitly target project pms' >&2
    exit 1
  fi
  echo "PASS: $SCENARIO"
done
