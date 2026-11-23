import type { IStorage, IPromptService } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorageProviderRegistry } from '@pragmatic-tech-ai/todl'
import type { IdentityStoreSet, IRealmConfigStore, IAuditSink } from '@pragmatic-tech-ai/pragmatic-identity'
import type { MasterKeyRef } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import type { EnvServerDatabase } from '../storage/env-server-database.js'

/** The platform-impl bundle a PragmaticServer composes its infrastructure from. Every bundle stores its records in the
 *  env server's database (A5): CustomPlatform opens it from a URL file, a cloud bundle over its provider's session; the
 *  bundles differ in blob storage (files or an object store) and in where the master key comes from. */
export interface PlatformServices
{
    /** The env server's database every environment of the process stores its records in. */
    readonly Database: EnvServerDatabase
    CreateStorageProviderRegistry(): IStorageProviderRegistry
    CreateStorage(root: string): IStorage
    CreatePackagesStorage(packagesRoot: string): IStorage
    CreatePromptService(): IPromptService
    ResolveMasterKey(ref: MasterKeyRef): Buffer
    /** An environment's identity stores: the shared SQL stores and its sealed secrets (scope `env-server/<id>`). */
    CreateIdentityStores(environmentId: string, masterKey: Buffer): Promise<IdentityStoreSet>
    CreateRealmConfigStore(environmentId: string): Promise<IRealmConfigStore>
    /** The access audit store (its own append-only table in the database, rows with realm = environment id). */
    AuditSink(): Promise<IAuditSink>
}
