# Local dev with docker compose

**Legacy:** `docker-compose.yml` and `docker/docker-compose.cluster.yml` build `pragmatic-server/docker/Dockerfile` from the parent folder of a pragmatic-server checkout (archived; the pre-split sibling workspace), not from this repository: they are kept as they were for reference. They run the server for local development; the Dockerfile needs the BuildKit secret `npmrc` for private dependencies. To run this repository's image, use `ghcr.io/pragmatic-tech-ai/pragmatic-env-server` (or the image the root `docker-bake.hcl` builds) with the same environment and mounts; its worker command is `node server/dist/bin/pragmatic-workerd.js`.

## 1. Generate a dev master key

The server reads its master key from a file mounted at `/run/secrets/master_key`. Create a 32-byte key:

    head -c 32 /dev/urandom > docker/master.key

or, without a POSIX shell:

    node -e "require('fs').writeFileSync('docker/master.key', require('crypto').randomBytes(32))"

`docker/master.key` (and any `docker/*.key`) is gitignored. Never commit it.

## 2. Start and stop

    docker compose up --build
    docker compose down

State lives in the named volume `pragmatic-data` (mounted at `/data`). Use `docker compose down -v` to wipe it.

## 3. Environments

`docker/environments.example.json` is mounted read-only at `/cfg/environments.json`. It declares one environment, `acme`. Copy and edit it for your own environments, then point the bind mount at your copy.
## 4. Connect a client

    ws://localhost:8080/?environment=acme

## Multi-replica

A Redis coordinator is sketched (commented) in the compose file for the deferred multi-replica story.
