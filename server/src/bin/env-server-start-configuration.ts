import { readFileSync } from 'node:fs'
import {
    type AppliedConfiguration,
    AppliedConfigurationCodec,
    ComponentStartConfiguration,
    ComponentStartReport,
    ConfigurationRuntimeReader,
    ConfigurationStartError,
    ConfigurationStartReason,
    type IStartProcess,
} from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { ServerConfigLoader } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { EnvServerComponent } from './env-server-component.js'
import { EnvServerTuningBounds } from './env-server-tuning-bounds.js'

/**
 * The env server's start step, first in both mains: the shared `ComponentStartConfiguration` (the mounted
 * `pragmatic-config-pragmatic-env-server` laid over the environment), then what the shared validator cannot see, so a
 * configuration the server cannot run with refuses the start with exit 78 (the watched roll then reverts it) instead of
 * starting broken or failing later with exit 1:
 *
 * - a configured value outside its declared bound is refused by the shared step itself (the descriptor's `minimum` and
 *   `maximum`, EnvServerSettingBounds: a sweep or heartbeat that would spin, a drain longer than the pod's grace period);
 *   what the bounds cannot state, a soft backpressure limit above the hard one, is checked here (`EnvServerTuningBounds`);
 * - a configured value the settings loader refuses (a rate without its burst, a sampling ratio above 1, a default page
 *   size above the largest): the loader is run on the environment as rendered and as configured, and only a refusal the
 *   configuration caused is the configuration's.
 *
 * An applied file validated for 0.1.0 or 0.1.1 (versions that never read their configuration, so no image ever ran it)
 * with no entry prepared for this descriptor is not a reason to stop: the server starts as rendered, as those versions
 * did, and says so on stderr.
 */
export class EnvServerStartConfiguration
{
    /** The env server versions from before the start step (C3.1): their applied files were never read. */
    public static readonly VersionsWithoutStartStep: readonly string[] = ['0.1.0', '0.1.1']
    private static readonly Utf8 = 'utf8'
    private static readonly Separator = ': '
    private static readonly LineEnd = '\n'
    private static readonly IgnoredPrefix = 'started without the applied configuration: version'
    private static readonly IgnoredMiddle = 'was validated for'
    private static readonly IgnoredTail = 'which never read its configuration, and no entry is prepared for this version'
    private static readonly OpenReason = ' ('
    private static readonly CloseReason = ')'

    private constructor(private readonly env: NodeJS.ProcessEnv, private readonly process: IStartProcess, private readonly read: (path: string) => string)
    {
    }

    /** `read` reads the files the settings loader names (`PRAGMATIC_CONFIG_FILE`), as the mains do; the applied file is
     *  always read from disk. */
    public static async ApplyOrExit(env: NodeJS.ProcessEnv, process: IStartProcess = globalThis.process as unknown as IStartProcess, read: (path: string) => string = EnvServerStartConfiguration.ReadText): Promise<ComponentStartReport>
    {
        return new EnvServerStartConfiguration(env, process, read).Run()
    }

    private static ReadText(path: string): string
    {
        return readFileSync(path, EnvServerStartConfiguration.Utf8)
    }

    private async Run(): Promise<ComponentStartReport>
    {
        const rendered = { ...this.env }
        let report: ComponentStartReport
        try
        {
            report = await ComponentStartConfiguration.Apply({ Declaration: EnvServerComponent.Declaration, Env: this.env })
        }
        catch (error)
        {
            if (error instanceof ConfigurationStartError && this.NeverRead(error))
            {
                return ComponentStartReport.None
            }
            if (error instanceof ConfigurationStartError)
            {
                return this.Refuse(error.message, error.Reason)
            }
            throw error
        }
        if (!report.Applied)
        {
            return report
        }
        const refusal = EnvServerTuningBounds.Refusal(this.env, report.Settings) ?? this.LoaderRefusal(rendered)
        return refusal === undefined ? report : this.Refuse(refusal, ConfigurationStartReason.Invalid)
    }

    /** A descriptor mismatch on a file validated for a version that never read it: started as rendered (reported). */
    private NeverRead(error: ConfigurationStartError): boolean
    {
        if (error.Reason !== ConfigurationStartReason.DescriptorMismatch)
        {
            return false
        }
        const path = ConfigurationRuntimeReader.PathFrom(this.env)
        let applied: AppliedConfiguration
        try
        {
            applied = AppliedConfigurationCodec.Decode(EnvServerStartConfiguration.ReadText(path))
        }
        catch
        {
            return false
        }
        const S = EnvServerStartConfiguration
        if (applied.Component !== EnvServerComponent.Name || !S.VersionsWithoutStartStep.includes(applied.ComponentVersion))
        {
            return false
        }
        this.process.stderr.write(`${EnvServerComponent.Name}${S.Separator}${S.IgnoredPrefix} ${applied.Version} ${S.IgnoredMiddle} ${applied.ComponentVersion}, ${S.IgnoredTail}${S.LineEnd}`)
        return true
    }

    /** The loader's refusal of the configured environment, when the environment as rendered loads. */
    private LoaderRefusal(rendered: NodeJS.ProcessEnv): string | undefined
    {
        try
        {
            ServerConfigLoader.Load(this.env, this.read)
            return undefined
        }
        catch (configured)
        {
            try
            {
                ServerConfigLoader.Load(rendered, this.read)
            }
            catch
            {
                // The rendered environment does not load either: the platform's wiring, which the main reports as before.
                return undefined
            }
            return configured instanceof Error ? configured.message : String(configured)
        }
    }

    private Refuse(reason: string, code: ConfigurationStartReason): never
    {
        const S = EnvServerStartConfiguration
        this.process.stderr.write(`${EnvServerComponent.Name}${S.Separator}${reason}${S.OpenReason}${code}${S.CloseReason}${S.LineEnd}`)
        return this.process.exit(ComponentStartConfiguration.ExitCode)
    }
}
