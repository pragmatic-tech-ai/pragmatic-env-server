# pragmatic-env-server container image

The image is built from the repository root `Dockerfile` and `docker-bake.hcl` (rendered by
pragmatic-container-template, baked by CI from published packages: `docker buildx bake` runs the `components` step,
then the image; see the root README). This folder holds only the compose files' companions (`environments.example.json`,
`compose-README.md`, `docker-compose.cluster.yml`); the pre-split sibling-workspace build is gone (it built an archived
pragmatic-server checkout, not this repository).

The image runs `node server/dist/bin/pragmatic-serverd.js` from `/workspace/pragmatic-env-server`; a worker runs from
the same image with `node server/dist/bin/pragmatic-workerd.js`. The gateway is its own image,
`ghcr.io/pragmatic-tech-ai/pragmatic-env-gateway`.

## Run

Required environment:

- `PRAGMATIC_BASE_DIR`: base directory for environment data (mount a volume here).
- A master-key reference: either a key file path or the name of a base64 environment variable (by reference, never the key value itself).
- `PRAGMATIC_ENVIRONMENT_ID` for single-environment mode, or `PRAGMATIC_ENVIRONMENTS_FILE` pointing at a mounted environments file.

Startup aborts with a sanitized message if required configuration is missing. `/readyz` stays false until startup completes; `/healthz` backs the image HEALTHCHECK.

The server listens on port 8080 (override with `PRAGMATIC_PORT`) and runs as the non-root user `pragmatic` (uid 10001).

## Secrets

No secret is baked into the image. Master keys, OIDC client secrets and bootstrap admin passwords are supplied at run time by reference (mounted files or environment variables).
