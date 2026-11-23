import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { PgSession, SqlRecordStore, SqlSecretKeyRing, SqlSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { PostgresPoolFactory } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import { EnvServerDatabaseMissingError } from './env-server-database-missing-error.js'
import type { EnvServerRegistry } from './env-server-registry.js'

/**
 * The env server's own Postgres database (A5): one per deployment, shared by every environment the process hosts (rows
 * carry the environment id). The custom platform opens it from the URL in the secret file
 * PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE (its content is never logged; errors name the file); the cloud platforms wrap
 * their provider's session (`Over`). Nothing is migrated until a store opens: each store's Open runs its own migration
 * module, and the record registries are opened once per process and shared.
 */
export class EnvServerDatabase
{
    public static readonly UrlFileEnvVar = 'PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE'
    /** The key id the master key seals under. */
    public static readonly SecretKeyId = 'master'
    /** The sealed-secret scope of an environment: `env-server/<environmentId>`. */
    public static readonly SecretScopePrefix = 'env-server/'
    /** How long a start waits for its database to answer (a pod's Postgres sidecar starts beside it). */
    public static readonly ReadyTimeoutMs = 60_000
    private static readonly ApplicationName = 'pragmatic-env-server'
    private static readonly MaxConnections = 10
    private static readonly ReadyPollMs = 1_000
    private static readonly ProbeSql = 'SELECT 1'
    private static readonly NoParams: readonly unknown[] = []

    private readonly records = new Map<EnvServerRegistry, Promise<SqlRecordStore<{ id: string }>>>()

    private constructor(public readonly Session: ISqlSession, private readonly owned: PgSession | undefined)
    {
    }

    /** Opens the database the environment names and waits until it answers (at most `readyTimeoutMs`). */
    public static async Open(env: NodeJS.ProcessEnv, readyTimeoutMs: number = EnvServerDatabase.ReadyTimeoutMs): Promise<EnvServerDatabase>
    {
        const D = EnvServerDatabase
        const urlFile = env[D.UrlFileEnvVar]?.trim() ?? ''
        if (urlFile === '')
        {
            throw new EnvServerDatabaseMissingError()
        }
        const pool = await new PostgresPoolFactory({ UrlFile: urlFile, ApplicationName: D.ApplicationName, MaxConnections: D.MaxConnections }).Create()
        const session = new PgSession(pool)
        const deadline = Date.now() + readyTimeoutMs
        for (;;)
        {
            try
            {
                await session.Query(D.ProbeSql, D.NoParams)
                return new EnvServerDatabase(session, session)
            }
            catch (error)
            {
                if (Date.now() + D.ReadyPollMs > deadline)
                {
                    await session.Dispose()
                    throw error
                }
                await new Promise<void>(resolve => setTimeout(resolve, D.ReadyPollMs))
            }
        }
    }

    /** Over a session the caller owns (tests, the cloud platforms' provider session). */
    public static Over(session: ISqlSession): EnvServerDatabase
    {
        return new EnvServerDatabase(session, undefined)
    }

    /** The registry's record store, opened (and migrated) once per database; a failed open is retried by the next call. */
    public Records<T extends { id: string }>(registry: EnvServerRegistry): Promise<SqlRecordStore<T>>
    {
        let store = this.records.get(registry)
        if (store === undefined)
        {
            const opening = SqlRecordStore.Open<{ id: string }>(this.Session, registry)
            opening.catch(() =>
            {
                if (this.records.get(registry) === opening) this.records.delete(registry)
            })
            this.records.set(registry, opening)
            store = opening
        }
        return store as unknown as Promise<SqlRecordStore<T>>
    }

    /** An environment's sealed secrets (AES-256-GCM under the master key, scope `env-server/<environmentId>`). */
    public Secrets(environmentId: string, masterKey: Buffer): Promise<SqlSecretStore>
    {
        return SqlSecretStore.Open(this.Session, SqlSecretKeyRing.Single(EnvServerDatabase.SecretKeyId, masterKey), EnvServerDatabase.SecretScopePrefix + environmentId)
    }

    /** Ends the pool when this database opened it. */
    public async Close(): Promise<void>
    {
        await this.owned?.Dispose()
    }
}
