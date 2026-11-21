# pragmatic-env-server

The environment server container: `pragmatic-serverd` (one process serving the environments) and `pragmatic-workerd`
(a cluster worker, behind pragmatic-env-gateway), released as the image `ghcr.io/pragmatic-tech-ai/pragmatic-env-server`.
Seeded from pragmatic-server@2a2e8138 (dev-kit A3 Task 9); the map is [ARCHITECTURE.md](ARCHITECTURE.md).

## Layout

- `server/` — the image's code (`@pragmatic-tech-ai/pragmatic-env-server-app`, private); its version is the component
  descriptor's and the release tag's.
- `packages/pragmatic-identity-engine-binding`, `packages/pragmatic-connectors-host` — workspace packages (formerly
  the todl-identity-engine and todl-connectors-host repositories), built and tested here, not published.
- `helm/pragmatic-env-server` — the Kubernetes chart (chart name `pragmatic-server`, unchanged).
- `Dockerfile`, `docker-bake.hcl`, `closure.json`, `.github/workflows/` — rendered by `pragmatic-container-template`
  (`@pragmatic-tech-ai/pragmatic-release-toolkit`): the image of record.
- `docker-compose.yml` and `docker/docker-compose.cluster.yml` run the released images (env-server; the cluster file adds
  two workers and the pragmatic-env-gateway image) for local development (`docker/compose-README.md`).

## Build and test

Every `@pragmatic-tech-ai` package comes from GitHub Packages: `.npmrc` reads the token from `NODE_AUTH_TOKEN`
(`read:packages`).

    npm ci
    npm run build
    npm test
    npm run typecheck
    npx pragmatic-closure-check

Postgres-backed cases read `PRAGMATIC_TEST_PG_URL` and skip without it.

## Running the gated cloud-boot test against local emulators

`server/src/environments/tests/cloud-gcp-boot.test.ts` always runs a deterministic cloud-mode boot over in-memory
doubles. A second case boots cloud mode over the real `GcpCloudBackends` wiring (GCS + Secret Manager + SQL session)
with the SDK clients pointed at local emulators. It skips unless all of these are set:

- `PRAGMATIC_TEST_GCP_CLOUD=1`
- `PRAGMATIC_TEST_GCS_ENDPOINT` - fake-gcs-server URL, e.g. `http://localhost:4443`
- `PRAGMATIC_TEST_GCP_SECRET_ENDPOINT` - plaintext-gRPC Secret Manager emulator, e.g. `localhost:9090`
- `PRAGMATIC_TEST_PG_URL` - a local Postgres connection string (there is no Cloud SQL emulator, so a plain pool is used)

Optional: `PRAGMATIC_TEST_GCS_BUCKET` (default `pragmatic-test`) and `PRAGMATIC_TEST_GCP_PROJECT` (default
`test-project`). Start the GCS emulator and bucket with `docker compose -f docker-compose.emulators.yml up -d` in
pragmatic-shared's `packages/pragmatic-realm-gcp`, run a Secret Manager emulator and a local Postgres, then (in
`server/`):

    npx tsx --test src/environments/tests/cloud-gcp-boot.test.ts

Each run uses a unique run-id for the GCS prefix, environment ids, secret refs and master-key ref, so a shared emulator
does not collide.
