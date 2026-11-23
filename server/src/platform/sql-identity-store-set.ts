import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import type { IdentityStoreSet, ISecretStore, IRealmConfigStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlLocalAccountStore, SqlServiceTokenStore, SqlSessionStore, SqlRoleGrantStore, SqlAuditStore, SqlRealmConfigStore, SqlIdpDirectoryStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { AuditAnchoring } from '@pragmatic-tech-ai/pragmatic-identity-realm'
import { EnvironmentGrantStore } from './environment-grant-store.js'
import { EnvironmentSessionManager } from './environment-session-manager.js'

/** How the set's audit store is opened: with anchoring (signed checkpoints, cloud) or without. */
export interface SqlIdentityStoreSetOptions
{
    readonly Anchoring?: AuditAnchoring
}

/**
 * The identity stores of the env server over its database (A5): accounts, service tokens, sessions, role grants, the
 * identity audit, the IdP directory and the realm configuration. They are multi-realm by data (every row and method
 * carries the realm, which is the environment id), so one set serves every environment of the process; each Open ran
 * its store's migrations. An environment's set (`For`) scopes the sessions and grants to it and adds its own sealed
 * secrets.
 */
export class SqlIdentityStoreSet
{
    private constructor(
        private readonly accounts: SqlLocalAccountStore,
        private readonly tokens: SqlServiceTokenStore,
        private readonly sessions: SqlSessionStore,
        private readonly grants: SqlRoleGrantStore,
        private readonly audit: SqlAuditStore,
        private readonly directory: SqlIdpDirectoryStore,
        private readonly realmConfig: SqlRealmConfigStore)
    {
    }

    public static async Open(session: ISqlSession, options: SqlIdentityStoreSetOptions = {}): Promise<SqlIdentityStoreSet>
    {
        return new SqlIdentityStoreSet(
            await SqlLocalAccountStore.Open(session),
            await SqlServiceTokenStore.Open(session),
            await SqlSessionStore.Open(session),
            await SqlRoleGrantStore.Open(session),
            await SqlAuditStore.Open(session, options.Anchoring),
            await SqlIdpDirectoryStore.Open(session),
            await SqlRealmConfigStore.Open(session))
    }

    /** An environment's identity stores: the shared multi-realm stores, its sessions and grants viewed for the environment
     *  only (both tables are looked up across realms by token hash / subject), and the environment's own secrets. */
    public For(environmentId: string, secrets: ISecretStore): IdentityStoreSet
    {
        return {
            Secrets: secrets,
            Accounts: this.accounts,
            Tokens: this.tokens,
            Sessions: new EnvironmentSessionManager(this.sessions, environmentId),
            Grants: new EnvironmentGrantStore(this.grants, environmentId),
            Audit: this.audit,
            IdpDirectory: this.directory,
        }
    }

    public RealmConfig(): IRealmConfigStore
    {
        return this.realmConfig
    }

    /** The identity audit store (sign-ins, admin actions; hash-chained). */
    public Audit(): SqlAuditStore
    {
        return this.audit
    }
}
