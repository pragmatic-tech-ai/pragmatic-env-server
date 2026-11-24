import { readFileSync } from 'node:fs'
import { ServerConfigLoader, type IAccessAuditSink, Observability, ObservabilityRole, HostBootstrap } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { EnvironmentProvisioningFactory } from '../config/environment-provisioning-factory.js'
import { ProvisionedSecretsFactory } from '../config/provisioned-secrets-factory.js'
import { PragmaticServerHost } from '../host/pragmatic-server-host.js'
import { ServerBootstrap } from './server-bootstrap.js'
import { GracefulShutdown } from './graceful-shutdown.js'
import { StructuredLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { PlatformBundleFactory, type IPlatformBundle } from '../platform/platform-bundle.js'
import { EnvServerStartImport } from './env-server-start-import.js'
import { ComponentStartConfiguration } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { EnvServerComponent } from './env-server-component.js'

class ServerMain
{
    private static readonly Utf8 = 'utf8'
    private static readonly SigTerm = 'SIGTERM'
    private static readonly SigInt = 'SIGINT'
    private static readonly StartFailedPrefix = 'pragmatic-server failed to start: '
    private static readonly UnknownError = 'unknown error'
    private static readonly ShutdownLine = 'pragmatic-server shutting down'
    private static readonly ShutdownErrorPrefix = 'pragmatic-server shutdown error: '

    private static readonly StartupEvent = 'startup'
    private static readonly StartFailedEvent = 'start-failed'
    private static readonly EventKey = 'event'

    private readonly shutdown: GracefulShutdown

    private constructor(host: PragmaticServerHost, audit: IAccessAuditSink, logger: ILogger, bundle: IPlatformBundle)
    {
        this.shutdown = new GracefulShutdown(host, audit, bundle, logger, ServerMain.ShutdownLine, ServerMain.ShutdownErrorPrefix)
    }

    public static async Run(): Promise<void>
    {
        // First of all: the applied configuration (the mounted pragmatic-config-pragmatic-env-server) over the environment.
        await ComponentStartConfiguration.ApplyOrExit({ Declaration: EnvServerComponent.Declaration, Env: process.env })
        const logger = StructuredLogger.ToStdout()
        const read = (path: string): string => readFileSync(path, ServerMain.Utf8)
        const config = ServerConfigLoader.Load(process.env, read)
        const { provisioning, environmentCount } = EnvironmentProvisioningFactory.Build(config, read)
        const provisionedSecrets = ProvisionedSecretsFactory.Build(config, read)
        const observabilityOptions = HostBootstrap.ObservabilityOptions(config, ObservabilityRole.Host)
        const observability = observabilityOptions !== undefined ? Observability.Start(observabilityOptions) : undefined
        const bundle = await PlatformBundleFactory.Create(config, process.env)
        let main: ServerMain
        try
        {
            await EnvServerStartImport.Run(config, bundle.Platform, logger)
            const audit = await ServerBootstrap.AuditSink(config, logger, observability, bundle.Platform)
            const rateLimit = HostBootstrap.RateLimit(config, audit, observability, logger)
            const options = ServerBootstrap.ComposeOptions(config, provisioning, bundle.Platform, provisionedSecrets, logger, observability, audit, rateLimit)
            const host = await PragmaticServerHost.StartAsync(options)
            logger.Info(ServerBootstrap.StartupLine(config, environmentCount), { [ServerMain.EventKey]: ServerMain.StartupEvent })
            main = new ServerMain(host, audit, logger, bundle)
        }
        catch (error)
        {
            await ServerMain.DisposeQuietly(bundle)
            throw error
        }
        process.on(ServerMain.SigTerm, () => void main.Shutdown())
        process.on(ServerMain.SigInt, () => void main.Shutdown())
    }

    public static Fail(error: unknown): void
    {
        StructuredLogger.ToStdout().Error(ServerMain.StartFailedPrefix + (error instanceof Error ? error.message : ServerMain.UnknownError), { [ServerMain.EventKey]: ServerMain.StartFailedEvent })
        process.exit(1)
    }

    private static async DisposeQuietly(bundle: IPlatformBundle): Promise<void>
    {
        try
        {
            await bundle.Dispose()
        }
        catch
        {
            // best-effort: a bundle teardown failure must not block exit
        }
    }

    /** Stops the host, drains the access audit, disposes the bundle, then exits (once; a second signal is ignored). */
    private async Shutdown(): Promise<void>
    {
        const code = await this.shutdown.Run()
        if (code !== undefined)
        {
            process.exit(code)
        }
    }
}

ServerMain.Run().catch(ServerMain.Fail)
