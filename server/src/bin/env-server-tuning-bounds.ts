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
 * The ranges the env server accepts for its configured timings and sizes, which the shared settings loader takes as any
 * (positive) number: a timer below a second or above Node's 32-bit limit (clamped to 1 ms) would spin every environment's
 * sweep or heartbeat while `/healthz` stays green, a drain longer than the pod's termination grace period (Kubernetes'
 * default 30 s, the manifests set none) would have the pod killed before the access audit is flushed, an unbounded
 * inbound message could exhaust the pod, and a soft backpressure limit above the hard one would close a slow connection
 * before ever pausing it. Only configured settings are checked (the start report's names): the rendered environment is
 * the platform's.
 */
export class EnvServerTuningBounds
{
    /** Node's largest timer delay; a larger one fires after 1 ms. */
    public static readonly LargestTimerMs = 2147483647
    /** The longest drain: below the 30 s termination grace period, leaving time for the audit flush and the database close. */
    public static readonly LongestDrainMs = 25000
    /** The largest inbound WebSocket message (ws maxPayload): 4 times the 16 MiB default. */
    public static readonly LargestInboundBytes = 67108864
    private static readonly ShortestTimerMs = 1000
    private static readonly Smallest = 1
    private static readonly Core = 'core'
    private static readonly WebSocket = 'webSocket'
    private static readonly IdleTtl = 'idleTtlMs'
    private static readonly IdleSweep = 'idleSweepMs'
    private static readonly DrainTimeout = 'drainTimeoutMs'
    private static readonly Heartbeat = 'heartbeatMs'
    private static readonly BackpressureGrace = 'backpressureGraceMs'
    private static readonly MaxInbound = 'maxInboundBytes'
    private static readonly SoftBytes = 'backpressureSoftBytes'
    private static readonly HardBytes = 'backpressureHardBytes'
    private static readonly TimerWhy = 'a shorter or longer timer would spin'
    private static readonly DrainWhy = 'a longer drain outlasts the pod termination grace period'
    private static readonly InboundWhy = 'a larger message could exhaust the pod memory'
    private static readonly OutOfRange = 'is out of range: accepted'
    private static readonly To = 'to'
    private static readonly Configured = 'configured'
    private static readonly Above = 'is above'
    private static readonly SoftAboveHardWhy = 'a slow connection would be closed before it is ever paused'

    private static readonly Bounds: ReadonlyMap<string, TuningBound> = EnvServerTuningBounds.Table()

    /** The settings that are bounded, by `<option>.<setting>`. */
    public static Bounded(): readonly string[]
    {
        return [...EnvServerTuningBounds.Bounds.keys()]
    }

    /** The backpressure limits checked as a pair (soft at most hard), by `<option>.<setting>`. */
    public static Paired(): readonly string[]
    {
        const B = EnvServerTuningBounds
        return [B.Name(B.WebSocket, B.SoftBytes), B.Name(B.WebSocket, B.HardBytes)]
    }

    /** Why the first configured bounded setting is out of range, or undefined when every one is in range. */
    public static Refusal(env: NodeJS.ProcessEnv, configured: readonly string[]): string | undefined
    {
        const B = EnvServerTuningBounds
        for (const option of EnvServerComponent.Declaration.options)
        {
            for (const setting of option.settings)
            {
                const name = B.Name(option.name, setting.name)
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
        return B.PairRefusal(env, configured)
    }

    private static PairRefusal(env: NodeJS.ProcessEnv, configured: readonly string[]): string | undefined
    {
        const B = EnvServerTuningBounds
        const [softName, hardName] = B.Paired()
        if (!configured.includes(softName!) && !configured.includes(hardName!))
        {
            return undefined
        }
        const soft = B.Effective(env, B.SoftBytes)
        const hard = B.Effective(env, B.HardBytes)
        return soft > hard ? `${B.Configured} ${softName} ${soft} ${B.Above} ${hardName} ${hard} (${B.SoftAboveHardWhy})` : undefined
    }

    /** A webSocket setting as the server will run it: its variable, else the declared default. */
    private static Effective(env: NodeJS.ProcessEnv, setting: string): number
    {
        const declared = EnvServerComponent.Declaration.options
            .find(option => option.name === EnvServerTuningBounds.WebSocket)!.settings
            .find(candidate => candidate.name === setting)!
        const text = env[declared.source!]
        return text === undefined || text === '' ? Number(declared.default) : Number(text)
    }

    private static Name(option: string, setting: string): string
    {
        return ConfigurationEnvironmentOverlay.SettingName(option, setting)
    }

    private static Table(): ReadonlyMap<string, TuningBound>
    {
        const B = EnvServerTuningBounds
        const timer = new TuningBound(B.ShortestTimerMs, B.LargestTimerMs, B.TimerWhy)
        return new Map([
            [B.Name(B.Core, B.IdleTtl), timer],
            [B.Name(B.Core, B.IdleSweep), timer],
            [B.Name(B.Core, B.DrainTimeout), new TuningBound(B.Smallest, B.LongestDrainMs, B.DrainWhy)],
            [B.Name(B.WebSocket, B.Heartbeat), timer],
            [B.Name(B.WebSocket, B.BackpressureGrace), new TuningBound(B.Smallest, B.LargestTimerMs, B.TimerWhy)],
            [B.Name(B.WebSocket, B.MaxInbound), new TuningBound(B.Smallest, B.LargestInboundBytes, B.InboundWhy)],
        ])
    }
}
