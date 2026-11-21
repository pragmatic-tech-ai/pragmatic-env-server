#!/usr/bin/env bash
# The pragmatic-env-server image on a docker host: the runtime files the server reads are in place, and both entry points
# load their whole module graph (never a missing module); the server stops on missing configuration.
# Run: bash tests/image.test.sh <image>   (e.g. ghcr.io/pragmatic-tech-ai/pragmatic-env-server:ci)
# Every container it starts is removed; it creates nothing else.
set -euo pipefail

IMAGE="${1:?usage: image.test.sh <image>}"
APP_ROOT=/workspace/pragmatic-env-server
MODULE_ERROR='ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package|ERR_PACKAGE_PATH_NOT_EXPORTED'
MISSING_BASE_DIR='PRAGMATIC_BASE_DIR is required'
WORKER_SECONDS=20
FAILED=0
CONTAINERS=()

pass()
{
    echo "ok - $1"
}

fail()
{
    echo "not ok - $1" >&2
    FAILED=1
}

cleanup()
{
    for name in "${CONTAINERS[@]}"; do
        docker rm -f "$name" > /dev/null 2>&1 || true
    done
}
trap cleanup EXIT

# The files the server reads at run time (absolute paths).
EXPECTED=(
    "$APP_ROOT/server/dist/bin/pragmatic-serverd.js"
    "$APP_ROOT/server/dist/bin/pragmatic-workerd.js"
    "$APP_ROOT/packages/pragmatic-identity-engine-binding/dist"
    "$APP_ROOT/packages/pragmatic-connectors-host/dist"
    "/pragmatic/component.json"
)
for path in "${EXPECTED[@]}"; do
    if docker run --rm --entrypoint test "$IMAGE" -e "$path"; then
        pass "the image holds $path"
    else
        fail "the image lacks $path"
    fi
done

# The server with no configuration exits non-zero naming the first required setting, with no module error.
output=""
status=0
output="$(timeout 60 docker run --rm "$IMAGE" 2>&1)" || status=$?
if [ "$status" -eq 0 ]; then
    fail "no configuration: the server exited 0"
elif printf '%s' "$output" | grep -Eq "$MODULE_ERROR"; then
    fail "no configuration: a module is missing: $output"
elif ! printf '%s' "$output" | grep -Fq "$MISSING_BASE_DIR"; then
    fail "no configuration: expected '$MISSING_BASE_DIR', got (exit $status): $output"
else
    pass "no configuration stops on $MISSING_BASE_DIR"
fi

# The worker entry loads its module graph: whatever it does without configuration, no module error.
worker="env-server-image-test-worker-$$"
CONTAINERS+=("$worker")
docker run -d --name "$worker" --entrypoint node "$IMAGE" server/dist/bin/pragmatic-workerd.js > /dev/null
for _ in $(seq 1 "$WORKER_SECONDS"); do
    if [ "$(docker inspect -f '{{.State.Running}}' "$worker")" != true ]; then
        break
    fi
    sleep 1
done
logs="$(docker logs "$worker" 2>&1)"
if printf '%s' "$logs" | grep -Eq "$MODULE_ERROR"; then
    fail "the worker entry is missing a module: $logs"
else
    pass "the worker entry loads its modules"
fi

exit "$FAILED"
