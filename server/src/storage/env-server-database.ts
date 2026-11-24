import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { PgSession, SqlOidcFlowStateStore, SqlRecordStore, SqlSecretKeyRing, SqlSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { PostgresPoolFactory } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import { EnvServerDatabaseMissingError } from './env-server-database-missing-error.js'
import type { EnvServerRegistry } from './env-server-registry.js'
import { SqlAccessAuditRecords } from './sql-access-audit-records.js'

/** The env server database did not answer before the start's deadline (EnvServerDatabase.ReadyTimeoutMs). */
export class EnvServerDatabaseUnreadyError extends Error
{
    private static readonly ErrorName = 'EnvServerDatabaseUnreadyError'
    private static readonly Text = 'the env server database did not answer in time'

    public constructor()
    {
        super(EnvServerDatabaseUnreadyError.Text)
        this.name = EnvServerDatabaseUnreadyError.ErrorName
    }
}

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
    private secretsMigrated: Promise<void> | undefined
    private flowStates: Promise<SqlOidcFlowStateStore> | undefined
    private accessAudit: Promise<SqlAccessAuditRecords> | undefined

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
                // Each probe is bounded by the time left: a database that never answers (a connect that hangs) cannot
                // hold the start past the deadline.
                await D.Within(session.Query(D.ProbeSql, D.NoParams), deadline - Date.now())
                return new EnvServerDatabase(session, session)
            }
            catch (error)
            {
                if (error instanceof EnvServerDatabaseUnreadyError || Date.now() + D.ReadyPollMs > deadline)
                {
                    // Bounded too: closing a pool whose connect hangs waits for that connect.
                    await D.Within(session.Dispose(), D.ReadyPollMs).catch(() => undefined)
                    throw error
                }
                await new Promise<void>(resolve => setTimeout(resolve, D.ReadyPollMs))
            }
        }
    }

    /** `work`, or EnvServerDatabaseUnreadyError when it has not settled within `ms`. */
    private static async Within<T>(work: Promise<T>, ms: number): Promise<T>
    {
        // A late rejection of work that lost the race is not an unhandled one.
        work.catch(() => undefined)
        let timer: NodeJS.Timeout | undefined
        const expired = new Promise<never>((_, reject) =>
        {
            timer = setTimeout(() => reject(new EnvServerDatabaseUnreadyError()), Math.max(0, ms))
        })
        try
        {
            return await Promise.race([work, expired])
        }
        finally
        {
            clearTimeout(timer)
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

    /** The deployment's pending OIDC sign-ins (every environment and worker shares them; EnvironmentFlowStateStore
     *  views them per environment), opened once; a failed open is retried by the next call. */
    public FlowStates(): Promise<SqlOidcFlowStateStore>
    {
        if (this.flowStates === undefined)
        {
            const opening = SqlOidcFlowStateStore.Open(this.Session)
            opening.catch(() =>
            {
                if (this.flowStates === opening) this.flowStates = undefined
            })
            this.flowStates = opening
        }
        return this.flowStates
    }

    /** The access audit table (append-only, apart from the identity audit), opened once; a failed open is retried. */
    public AccessAudit(): Promise<SqlAccessAuditRecords>
    {
        if (this.accessAudit === undefined)
        {
            const opening = SqlAccessAuditRecords.Open(this.Session)
            opening.catch(() =>
            {
                if (this.accessAudit === opening) this.accessAudit = undefined
            })
            this.accessAudit = opening
        }
        return this.accessAudit
    }

    /** An environment's sealed secrets (AES-256-GCM under the master key, scope `env-server/<environmentId>`). */
    public async Secrets(environmentId: string, masterKey: Buffer): Promise<SqlSecretStore>
    {
        const open = (): Promise<SqlSecretStore> => SqlSecretStore.Open(this.Session, SqlSecretKeyRing.Single(EnvServerDatabase.SecretKeyId, masterKey), EnvServerDatabase.SecretScopePrefix + environmentId)
        if (this.secretsMigrated === undefined)
        {
            // The first open runs the secrets migration; later opens wait for it, so environments opening together never
            // race on the schema (the advisory lock serializes them on Postgres, and pg-mem has none).
            const first = open()
            const migrated = first.then(() => undefined)
            migrated.catch(() =>
            {
                if (this.secretsMigrated === migrated) this.secretsMigrated = undefined
            })
            this.secretsMigrated = migrated
            return first
        }
        await this.secretsMigrated
        return open()
    }

    /** Ends the pool when this database opened it. */
    public async Close(): Promise<void>
    {
        await this.owned?.Dispose()
    }
}
