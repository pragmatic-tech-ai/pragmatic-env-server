import type { IStorage, IPromptService } from '@pragmatic-tech-ai/todl-runtime'
import type { IStorageProviderRegistry } from '@pragmatic-tech-ai/todl'
import { HeadlessPromptService } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import type { MasterKeyRef } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { MasterKeyResolver } from '../identity/master-key-resolver.js'
import type { EnvServerDatabase } from '../storage/env-server-database.js'
import { DatabasePlatformBase } from './database-platform-base.js'
import type { PlatformServices } from './platform-services.js'
import { SqlIdentityStoreSet } from './sql-identity-store-set.js'

/**
 * The custom (self-hosted) platform bundle, selected by deployment mode local: blobs on the storage registry's file
 * storage, headless prompts, the master key from its file, and every record in the env server's database (identity,
 * sealed secrets, realm configuration).
 */
export class CustomPlatform extends DatabasePlatformBase implements PlatformServices
{
    private readonly prompt = new HeadlessPromptService()

    public constructor(database: EnvServerDatabase, private readonly storage: IStorageProviderRegistry)
    {
        super(database)
    }

    public CreateStorageProviderRegistry(): IStorageProviderRegistry
    {
        return this.storage
    }

    public CreateStorage(root: string): IStorage
    {
        return this.storage.CreateStorage(root)
    }

    public CreatePackagesStorage(packagesRoot: string): IStorage
    {
        return this.CreateStorage(packagesRoot)
    }

    public CreatePromptService(): IPromptService
    {
        return this.prompt
    }

    public ResolveMasterKey(ref: MasterKeyRef): Buffer
    {
        return MasterKeyResolver.Resolve(ref)
    }

    protected OpenIdentity(): Promise<SqlIdentityStoreSet>
    {
        return SqlIdentityStoreSet.Open(this.Database.Session)
    }
}
