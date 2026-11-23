import type { IStorage, IPromptService } from '@pragmatic-tech-ai/todl-runtime'
import type { ISqlSession, IStorageProviderRegistry } from '@pragmatic-tech-ai/todl'
import type { ISecretStore } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlAuditCheckpointStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { AuditAnchor, AuditAnchoring, HmacAuditCheckpointSigner } from '@pragmatic-tech-ai/pragmatic-identity-realm'
import { HeadlessPromptService } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import type { MasterKeyRef } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { EnvServerDatabase } from '../storage/env-server-database.js'
import { DatabasePlatformBase } from './database-platform-base.js'
import type { PlatformServices } from './platform-services.js'
import { SqlIdentityStoreSet } from './sql-identity-store-set.js'

export interface CloudPlatformOptions
{
    readonly session: ISqlSession
    readonly storage: IStorageProviderRegistry
    readonly secretManager: ISecretStore
    readonly masterKeyRef: string
    readonly auditAnchorKeyRef?: string
    readonly auditAnchorInterval?: number
}

/** Cloud PlatformServices bundle: the object-store registry for blobs and the env server's database over the provider's
 *  ONE shared ISqlSession for every record (the multi-realm identity stores, opened once and shared across
 *  environments, and each environment's sealed secrets under scope `env-server/<id>`). The master key is resolved ONCE
 *  from the secret manager by reference at Create and held; ResolveMasterKey hands out a defensive copy. */
export class CloudPlatform extends DatabasePlatformBase implements PlatformServices
{
    private static readonly KeyByteLength = 32
    private static readonly MissingKeyMessage = 'cloud master key reference not found'
    private static readonly InvalidKeyMessage = 'cloud master key must be exactly 32 bytes'
    private static readonly MissingAnchorKeyMessage = 'cloud audit anchor key reference not found'
    private static readonly DefaultAnchorInterval = 1
    private static readonly Base64 = 'base64'

    private readonly prompt: IPromptService = new HeadlessPromptService()

    private constructor(session: ISqlSession, private readonly storage: IStorageProviderRegistry, private readonly masterKey: Buffer, private readonly anchorKey: string | undefined, private readonly anchorInterval: number)
    {
        super(EnvServerDatabase.Over(session))
    }

    public static async Create(options: CloudPlatformOptions): Promise<CloudPlatform>
    {
        const encoded = await options.secretManager.Get(options.masterKeyRef)
        if (encoded === null)
        {
            throw new Error(CloudPlatform.MissingKeyMessage)
        }
        const key = Buffer.from(encoded, CloudPlatform.Base64)
        if (key.length !== CloudPlatform.KeyByteLength)
        {
            throw new Error(CloudPlatform.InvalidKeyMessage)
        }
        let anchorKey: string | undefined
        if (options.auditAnchorKeyRef !== undefined && options.auditAnchorKeyRef.length > 0)
        {
            const resolved = await options.secretManager.Get(options.auditAnchorKeyRef)
            if (resolved === null || resolved.length === 0)
            {
                throw new Error(CloudPlatform.MissingAnchorKeyMessage)
            }
            anchorKey = resolved
        }
        return new CloudPlatform(options.session, options.storage, key, anchorKey, options.auditAnchorInterval ?? CloudPlatform.DefaultAnchorInterval)
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

    public ResolveMasterKey(_ref: MasterKeyRef): Buffer
    {
        return Buffer.from(this.masterKey)
    }

    protected async OpenIdentity(): Promise<SqlIdentityStoreSet>
    {
        const session = this.Database.Session
        if (this.anchorKey === undefined)
        {
            return SqlIdentityStoreSet.Open(session)
        }
        const anchoring = new AuditAnchoring(new AuditAnchor(new HmacAuditCheckpointSigner(this.anchorKey), this.anchorInterval), await SqlAuditCheckpointStore.Open(session))
        return SqlIdentityStoreSet.Open(session, { Anchoring: anchoring })
    }
}
