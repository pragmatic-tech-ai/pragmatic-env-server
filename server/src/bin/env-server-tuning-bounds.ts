import { ConfigurationEnvironmentOverlay } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { EnvServerComponent } from './env-server-component.js'

/** One configured integer's accepted range (inclusive). */
class TuningBound
{
    public constructor(public readonly Minimum: number, public readonly Maximum: number, public readonly Why: string)
    {
    }
}

/**
 * The ranges the env server accepts for its configured timings, which the shared settings loader takes as any number:
 * a timer below a second or above Node's 32-bit limit (clamped to 1 ms) would spin every environment's sweep or heartbeat
 * while `/healthz` stays green, and a drain longer than the pod's termination grace period (Kubernetes' default 30 s,
 * the manifests set none) would have the pod killed before the access audit is flushed. Only configured settings are
 * checked (the start report's names): the rendered environment is the platform's.
 */
export class EnvServerTuningBounds
{
    /** Node's largest timer delay; a larger one fires after 1 ms. */
    public static readonly LargestTimerMs = 2147483647
    /** The longest drain: below the 30 s termination grace period, leaving time for the audit flush and the database close. */
    public static readonly LongestDrainMs = 25000
    private static readonly ShortestTimerMs = 1000
    private static readonly Core = 'core'
    private static readonly WebSocket = 'webSocket'
    private static readonly TimerWhy = 'a shorter or longer timer would spin'
    private static readonly DrainWhy = 'a longer drain outlasts the pod termination grace period'
    private static readonly OutOfRange = 'is out of range: accepted'
    private static readonly To = 'to'
    private static readonly Configured = 'configured'

    private static readonly Bounds: ReadonlyMap<string, TuningBound> = new Map([
        [ConfigurationEnvironmentOverlay.SettingName(EnvServerTuningBounds.Core, 'idleTtlMs'), new TuningBound(EnvServerTuningBounds.ShortestTimerMs, EnvServerTuningBounds.LargestTimerMs, EnvServerTuningBounds.TimerWhy)],
        [ConfigurationEnvironmentOverlay.SettingName(EnvServerTuningBounds.Core, 'idleSweepMs'), new TuningBound(EnvServerTuningBounds.ShortestTimerMs, EnvServerTuningBounds.LargestTimerMs, EnvServerTuningBounds.TimerWhy)],
        [ConfigurationEnvironmentOverlay.SettingName(EnvServerTuningBounds.Core, 'drainTimeoutMs'), new TuningBound(1, EnvServerTuningBounds.LongestDrainMs, EnvServerTuningBounds.DrainWhy)],
        [ConfigurationEnvironmentOverlay.SettingName(EnvServerTuningBounds.WebSocket, 'heartbeatMs'), new TuningBound(EnvServerTuningBounds.ShortestTimerMs, EnvServerTuningBounds.LargestTimerMs, EnvServerTuningBounds.TimerWhy)],
        [ConfigurationEnvironmentOverlay.SettingName(EnvServerTuningBounds.WebSocket, 'backpressureGraceMs'), new TuningBound(1, EnvServerTuningBounds.LargestTimerMs, EnvServerTuningBounds.TimerWhy)],
    ])

    /** The settings that are bounded, by `<option>.<setting>`. */
    public static Bounded(): readonly string[]
    {
        return [...EnvServerTuningBounds.Bounds.keys()]
    }

    /** Why the first configured bounded setting is out of range, or undefined when every one is in range. */
    public static Refusal(env: NodeJS.ProcessEnv, configured: readonly string[]): string | undefined
    {
        const B = EnvServerTuningBounds
        for (const option of EnvServerComponent.Declaration.options)
        {
            for (const setting of option.settings)
            {
                const name = ConfigurationEnvironmentOverlay.SettingName(option.name, setting.name)
                const bound = B.Bounds.get(name)
                if (bound === undefined || setting.source === undefined || !configured.includes(name))
                {
                    continue
                }
                const value = Number(env[setting.source])
                if (!Number.isInteger(value) || value < bound.Minimum || value > bound.Maximum)
                {
                    return `${B.Configured} ${name} ${B.OutOfRange} ${bound.Minimum} ${B.To} ${bound.Maximum} (${bound.Why})`
                }
            }
        }
        return undefined
    }
}
