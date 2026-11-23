import { type ServerConfig, DeploymentMode, DeploymentProvider } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { NodeStorageProviderRegistry } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import { EnvServerDatabase } from '../storage/env-server-database.js'
import { CustomPlatform } from './custom-platform.js'
import type { PlatformServices } from './platform-services.js'

/** A built platform plus the teardown of what it runs on (the database pool, the cloud backends), disposed last. */
export interface IPlatformBundle
{
    readonly Platform: PlatformServices
    Dispose(): Promise<void>
}

/**
 * Builds the platform a server or worker process runs on from its configuration: deployment mode local selects the
 * custom platform over the env server's database (from PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE; a start without it is
 * refused with EnvServerDatabaseMissingError), cloud selects the provider's bundle (its own database session; the URL
 * file is ignored). Each cloud provider's package is loaded only when selected.
 */
export class PlatformBundleFactory
{
    public static async Create(config: ServerConfig, env: NodeJS.ProcessEnv): Promise<IPlatformBundle>
    {
        if (config.deploymentMode === DeploymentMode.Cloud)
        {
            return PlatformBundleFactory.Cloud(config)
        }
        const database = await EnvServerDatabase.Open(env)
        return { Platform: new CustomPlatform(database, new NodeStorageProviderRegistry()), Dispose: () => database.Close() }
    }

    private static async Cloud(config: ServerConfig): Promise<IPlatformBundle>
    {
        if (config.cloudProvider === DeploymentProvider.Azure)
        {
            const { AzurePlatformFactory } = await import('./azure-platform-factory.js')
            return await AzurePlatformFactory.Create(config)
        }
        if (config.cloudProvider === DeploymentProvider.Aws)
        {
            const { AwsPlatformFactory } = await import('./aws-platform-factory.js')
            return await AwsPlatformFactory.Create(config)
        }
        const { GcpPlatformFactory } = await import('./gcp-platform-factory.js')
        return await GcpPlatformFactory.Create(config)
    }
}
