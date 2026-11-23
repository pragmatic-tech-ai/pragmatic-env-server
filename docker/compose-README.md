# Local dev with docker compose

`docker-compose.yml` runs the released image `ghcr.io/pragmatic-tech-ai/pragmatic-env-server` (tag
`PRAGMATIC_ENV_SERVER_TAG`, default `0.1.0`); to run a local build, bake it with `docker buildx bake` and tag it the same.
`docker/docker-compose.cluster.yml` runs two workers from that image (`node server/dist/bin/pragmatic-workerd.js`) and
the gateway from `ghcr.io/pragmatic-tech-ai/pragmatic-env-gateway` (tag `PRAGMATIC_ENV_GATEWAY_TAG`). Pulling a private
image needs `docker login ghcr.io` with a token that can read the package.

## 1. Generate a dev master key

The server reads its master key from a file mounted at `/run/secrets/master_key`. Create a 32-byte key:

    head -c 32 /dev/urandom > docker/master.key

or, without a POSIX shell:

    node -e "require('fs').writeFileSync('docker/master.key', require('crypto').randomBytes(32))"

`docker/master.key` (and any `docker/*.key`) is gitignored. Never commit it.

## 2. Generate the database passwords

The server stores every record in its own Postgres (the `pragmatic-postgres` service). Its passwords and the server's
database URL are files in `docker/postgres-secrets/` (gitignored, never commit them); the uid 999 the database runs as
must read them:

    mkdir -p docker/postgres-secrets/pragmatic-postgres/applications
    node -e "const c=require('crypto'),f=require('fs'),d='docker/postgres-secrets/';const p=c.randomBytes(24).toString('base64url');f.writeFileSync(d+'pragmatic-postgres/superuser',c.randomBytes(24).toString('base64url'));f.writeFileSync(d+'pragmatic-postgres/applications/pragmatic-env-server',p);f.writeFileSync(d+'database-url','postgres://env_server:'+p+'@pragmatic-postgres:5432/env_server')"

## 3. Start and stop

    docker compose up
    docker compose down

State lives in the named volume `pragmatic-data` (mounted at `/data`). Use `docker compose down -v` to wipe it.

## 4. Environments

`docker/environments.example.json` is mounted read-only at `/cfg/environments.json`. It declares one environment, `acme`. Copy and edit it for your own environments, then point the bind mount at your copy.
## 5. Connect a client

    ws://localhost:8080/?environment=acme

## Multi-replica

A Redis coordinator is sketched (commented) in the compose file for the deferred multi-replica story.
