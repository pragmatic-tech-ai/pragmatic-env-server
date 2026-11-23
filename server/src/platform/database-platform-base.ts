import type { IdentityStoreSet, IRealmConfigStore, IAuditSink } from '@pragmatic-tech-ai/pragmatic-identity'
import type { EnvServerDatabase } from '../storage/env-server-database.js'
import type { SqlIdentityStoreSet } from './sql-identity-store-set.js'

/** What every platform shares: the identity stores over the env server's database, opened once (a failed open is
 *  retried by the next call), and each environment's sealed secrets from the database. */
export abstract class DatabasePlatformBase
{
    private identity: Promise<SqlIdentityStoreSet> | undefined

    protected constructor(public readonly Database: EnvServerDatabase)
    {
    }

    public async CreateIdentityStores(environmentId: string, masterKey: Buffer): Promise<IdentityStoreSet>
    {
        const set = await this.Identity()
        return set.For(environmentId, await this.Database.Secrets(environmentId, masterKey))
    }

    /** The realm configuration store is multi-realm by data: one store serves every environment. */
    public async CreateRealmConfigStore(_environmentId: string): Promise<IRealmConfigStore>
    {
        return (await this.Identity()).RealmConfig()
    }

    /** The access audit's table (not the hash-chained identity audit: access events are logs of their own). */
    public AuditSink(): Promise<IAuditSink>
    {
        return this.Database.AccessAudit()
    }

    /** Opens the platform's identity store set (with or without audit anchoring). */
    protected abstract OpenIdentity(): Promise<SqlIdentityStoreSet>

    private Identity(): Promise<SqlIdentityStoreSet>
    {
        if (this.identity === undefined)
        {
            const opening = this.OpenIdentity()
            opening.catch(() =>
            {
                if (this.identity === opening) this.identity = undefined
            })
            this.identity = opening
        }
        return this.identity
    }
}
