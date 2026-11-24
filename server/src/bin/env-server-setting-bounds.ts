import type { SettingDeclaration } from '@pragmatic-tech-ai/pragmatic-component'
import { ComponentTermination, ConfigurationEnvironmentOverlay } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'

/** One configured integer's accepted range (inclusive). */
class SettingBound
{
    public constructor(public readonly Minimum: number, public readonly Maximum: number)
    {
    }
}

/**
 * The ranges the env server accepts for its configured timings and sizes, declared on its descriptor's settings
 * (`minimum`, `maximum`), so the tenant admin console refuses a version outside them when it is saved and the start step
 * refuses one at start (exit 78, the watched roll reverts it). The shared settings loader takes any positive number: a
 * timer below a second or above Node's 32-bit limit (clamped to 1 ms) would spin every environment's sweep or heartbeat
 * while `/healthz` stays green, a drain longer than the pod's termination grace period would have the pod killed before
 * the access audit is flushed (both from ComponentTermination, which the hive manifests render the grace period from), and
 * an unbounded inbound message could exhaust the pod.
 */
export class EnvServerSettingBounds
{
    /** Node's largest timer delay; a larger one fires after 1 ms. */
    public static readonly LargestTimerMs = 2147483647
    /** The longest drain: inside the termination grace period, leaving time for the audit flush and the database close. */
    public static readonly LongestDrainMs = ComponentTermination.LongestDrainMs
    /** The largest inbound WebSocket message (ws maxPayload): 4 times the 16 MiB default. */
    public static readonly LargestInboundBytes = 67108864
    public static readonly ShortestTimerMs = 1000
    public static readonly Smallest = 1
    private static readonly Core = 'core'
    private static readonly WebSocket = 'webSocket'
    private static readonly IdleTtl = 'idleTtlMs'
    private static readonly IdleSweep = 'idleSweepMs'
    private static readonly DrainTimeout = 'drainTimeoutMs'
    private static readonly Heartbeat = 'heartbeatMs'
    private static readonly BackpressureGrace = 'backpressureGraceMs'
    private static readonly MaxInbound = 'maxInboundBytes'

    private static readonly Bounds: ReadonlyMap<string, SettingBound> = EnvServerSettingBounds.Table()

    private constructor()
    {
    }

    /** The settings that are bounded, by `<option>.<setting>`. */
    public static Bounded(): readonly string[]
    {
        return [...EnvServerSettingBounds.Bounds.keys()]
    }

    /** `settings` of `option` with the bounds of the bounded ones declared. */
    public static Declared(option: string, settings: readonly SettingDeclaration[]): SettingDeclaration[]
    {
        return settings.map(setting =>
        {
            const bound = EnvServerSettingBounds.Bounds.get(ConfigurationEnvironmentOverlay.SettingName(option, setting.name))
            return bound === undefined ? setting : { ...setting, minimum: bound.Minimum, maximum: bound.Maximum }
        })
    }

    private static Table(): ReadonlyMap<string, SettingBound>
    {
        const B = EnvServerSettingBounds
        const name = (option: string, setting: string): string => ConfigurationEnvironmentOverlay.SettingName(option, setting)
        const timer = new SettingBound(B.ShortestTimerMs, B.LargestTimerMs)
        return new Map([
            [name(B.Core, B.IdleTtl), timer],
            [name(B.Core, B.IdleSweep), timer],
            [name(B.Core, B.DrainTimeout), new SettingBound(B.Smallest, B.LongestDrainMs)],
            [name(B.WebSocket, B.Heartbeat), timer],
            [name(B.WebSocket, B.BackpressureGrace), new SettingBound(B.Smallest, B.LargestTimerMs)],
            [name(B.WebSocket, B.MaxInbound), new SettingBound(B.Smallest, B.LargestInboundBytes)],
        ])
    }
}
