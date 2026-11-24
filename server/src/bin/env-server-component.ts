import { SettingType, type ComponentDescriptor, ComponentDeclarations, type ComponentDeclaration, type OptionDeclaration } from '@pragmatic-tech-ai/pragmatic-component'
import { ServerOptionDeclarations } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { EnvServerSettingBounds } from './env-server-setting-bounds.js'

/**
 * The component descriptor of the env server image (pragmatic-serverd, and pragmatic-workerd from the same image): the
 * settings a tenant may configure, laid over the environment `ServerConfigLoader.Load` reads at start
 * (`EnvServerStartConfiguration`, first in both mains). Stores in Postgres (A5).
 *
 * One configuration is applied to every environment's env server of the tenant, so only tuning is declared: idle
 * unloading, drain, WebSocket limits, rate limits and paging (timings and sizes bounded on the descriptor,
 * `EnvServerSettingBounds`; the backpressure pair at start, `EnvServerTuningBounds`). What
 * binds a server to its environment or to the platform (its listener, folders, environments, master key, database, Redis
 * and worker wiring, TLS, cloud resources, browser origins, the telemetry collector and identity, the access audit) is
 * rendered by the platform's manifests and left out (C3.1 ruling "platform-owned settings"), so no configuration can set
 * it; so are the adapter packs, off in every hive (no pack cache folder is rendered). The descriptor test lists each
 * variable left out with its reason.
 */
export class EnvServerComponent
{
    public static readonly Name = 'pragmatic-env-server'
    /** The descriptor version: this application's package version (the release test pins it to package.json). */
    public static readonly Version = '0.1.3'
    /** Read by the shared loader for the gateway; the env server's hosts never use it (their heartbeat closes silent sockets). */
    private static readonly UnusedReadIdleSetting = 'readIdleMs'

    private static readonly CoreOption = 'core'

    private static readonly WebSocket: OptionDeclaration = {
        ...ServerOptionDeclarations.WebSocket,
        settings: EnvServerSettingBounds.Declared(ServerOptionDeclarations.WebSocket.name,
            ServerOptionDeclarations.WebSocket.settings.filter(s => s.name !== EnvServerComponent.UnusedReadIdleSetting)),
    }

    /** The declaration: the descriptor, and the variable the start step overlays each configured setting onto. */
    public static readonly Declaration: ComponentDeclaration = {
        name: EnvServerComponent.Name,
        version: EnvServerComponent.Version,
        options: [
            {
                name: EnvServerComponent.CoreOption,
                description: 'The server process: idle unloading of environments and the shutdown drain.',
                settings: EnvServerSettingBounds.Declared(EnvServerComponent.CoreOption, [
                    { name: 'idleTtlMs', type: SettingType.Integer, source: 'PRAGMATIC_IDLE_TTL_MS', description: 'An environment idle this many milliseconds is unloaded.' },
                    { name: 'idleSweepMs', type: SettingType.Integer, source: 'PRAGMATIC_IDLE_SWEEP_MS', description: 'Interval of the idle sweep in milliseconds.' },
                    { name: 'drainTimeoutMs', type: SettingType.Integer, source: 'PRAGMATIC_DRAIN_TIMEOUT_MS', default: EnvServerSettingBounds.LongestDrainMs, description: 'How long shutdown waits for connections to drain, in milliseconds.' },
                ]),
            },
            ServerOptionDeclarations.RateLimit,
            EnvServerComponent.WebSocket,
            {
                name: 'paging',
                description: 'Query result paging.',
                settings: [
                    { name: 'pageSizeDefault', type: SettingType.Integer, source: 'PRAGMATIC_PAGE_SIZE_DEFAULT', description: 'Default page size.' },
                    { name: 'pageSizeMax', type: SettingType.Integer, source: 'PRAGMATIC_PAGE_SIZE_MAX', description: 'Largest page size a request may ask for.' },
                ],
            },
        ],
        roles: [],
        postgres: true,
        ports: [{ name: 'http', number: 8080 }],
        health: { port: 'http', path: '/healthz' },
    }

    public static Descriptor(): ComponentDescriptor
    {
        return ComponentDeclarations.Build(EnvServerComponent.Declaration)
    }
}
