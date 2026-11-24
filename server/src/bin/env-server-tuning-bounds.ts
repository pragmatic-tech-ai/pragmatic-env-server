import { ConfigurationEnvironmentOverlay } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { EnvServerComponent } from './env-server-component.js'

/**
 * What the descriptor's bounds cannot state: the soft backpressure limit at most the hard one, or a slow connection would be
 * closed before it is ever paused. Checked at start, only when either is configured (the start report's names): the
 * rendered environment is the platform's. The single settings' ranges are declared on the descriptor
 * (EnvServerSettingBounds), so the shared validator refuses them at save time and at start.
 */
export class EnvServerTuningBounds
{
    private static readonly WebSocket = 'webSocket'
    private static readonly SoftBytes = 'backpressureSoftBytes'
    private static readonly HardBytes = 'backpressureHardBytes'
    private static readonly Configured = 'configured'
    private static readonly Above = 'is above'
    private static readonly SoftAboveHardWhy = 'a slow connection would be closed before it is ever paused'

    private constructor()
    {
    }

    /** The backpressure limits checked as a pair (soft at most hard), by `<option>.<setting>`. */
    public static Paired(): readonly string[]
    {
        const B = EnvServerTuningBounds
        return [B.Name(B.WebSocket, B.SoftBytes), B.Name(B.WebSocket, B.HardBytes)]
    }

    /** Why the configured backpressure pair cannot run, or undefined when it can (or neither is configured). */
    public static Refusal(env: NodeJS.ProcessEnv, configured: readonly string[]): string | undefined
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
}
