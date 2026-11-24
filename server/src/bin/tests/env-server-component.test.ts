import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigurationErrorCode, ConfigurationValidator, type OptionDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { ComponentTermination } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { EnvServerComponent } from '../env-server-component.js'
import { EnvServerSettingBounds } from '../env-server-setting-bounds.js'
import { ComponentGolden } from '../../component/tests/component-golden.js'
import { ComponentSources } from '../../component/tests/component-sources.js'
import { EnvServerDescriptorPin } from './env-server-descriptor-pin.js'

class EnvServerComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(EnvServerComponentFixture.Here, 'fixtures', 'pragmatic-env-server.component.json')
    public static readonly Readers = [
        ComponentSources.InPackage('@pragmatic-tech-ai/pragmatic-env-cluster', 'config', 'server-config-loader.js'),
        join(EnvServerComponentFixture.Here, '..', '..', 'storage', 'env-server-database.ts'),
    ]
    private static readonly ListenerWiring = 'platform-owned: the listener and health port the Deployment, its probes and Service name'
    private static readonly EnvironmentWiring = 'platform-owned: the state folder, environments, mode and seed files the manifests render per environment'
    private static readonly TrustWiring = 'platform-owned: the master key and provisioned secrets are the environment trust roots the manifests mount'
    private static readonly DatabaseWiring = 'platform-owned: the server database (A5.4); no configuration may point the server at another one'
    private static readonly ClusterWiring = 'platform-owned: the Redis worker directory and the worker addresses the manifests render'
    private static readonly TlsWiring = 'platform-owned: machine TLS files the manifests mount'
    private static readonly CloudWiring = 'platform-owned: the cloud provider, its keys and resources, rendered per deployment'
    private static readonly OriginWiring = 'platform-owned: browser origins are per environment, and one configuration is applied to every environment'
    private static readonly AuditWiring = 'platform-owned: the access audit records what tenant principals do; its sink is not theirs to turn off'
    private static readonly RetiredAuditFile = 'retired: the shared loader still reads it for the gateway; the env server refuses the file sink (AuditSinkRetiredError)'
    private static readonly TelemetryWiring = 'platform-owned: the telemetry collector, its export and the service identity belong to the platform (spans carry principal and environment ids)'
    private static readonly UnusedReadIdle = 'unused: the shared loader reads it for the gateway; the env server hosts close silent sockets by their heartbeat'
    private static readonly PacksWiring = 'not configurable: adapter packs are off without the platform pack cache folder (no hive renders one); the signature check is a trust root'
    private static readonly CloudVariables: readonly string[] = [
        'PRAGMATIC_CLOUD_PROVIDER', 'PRAGMATIC_CLOUD_MASTER_KEY_REF', 'PRAGMATIC_CLOUD_AUDIT_ANCHOR_KEY_REF', 'PRAGMATIC_CLOUD_AUDIT_ANCHOR_INTERVAL',
        'PRAGMATIC_GCP_PROJECT', 'PRAGMATIC_GCS_BUCKET', 'PRAGMATIC_GCS_PREFIX', 'PRAGMATIC_CLOUDSQL_INSTANCE', 'PRAGMATIC_CLOUDSQL_USER',
        'PRAGMATIC_CLOUDSQL_DB', 'PRAGMATIC_CLOUDSQL_IPTYPE', 'PRAGMATIC_CLOUDSQL_AUTH',
        'PRAGMATIC_AWS_REGION', 'PRAGMATIC_S3_BUCKET', 'PRAGMATIC_S3_PREFIX', 'PRAGMATIC_RDS_HOST', 'PRAGMATIC_RDS_PORT', 'PRAGMATIC_RDS_USER',
        'PRAGMATIC_RDS_DB', 'PRAGMATIC_RDS_AUTH', 'PRAGMATIC_RDS_PASSWORD_REF',
        'PRAGMATIC_AZURE_STORAGE_ACCOUNT', 'PRAGMATIC_BLOB_CONTAINER', 'PRAGMATIC_BLOB_PREFIX', 'PRAGMATIC_AZURE_KEYVAULT_URL', 'PRAGMATIC_AZPG_HOST',
        'PRAGMATIC_AZPG_PORT', 'PRAGMATIC_AZPG_USER', 'PRAGMATIC_AZPG_DB', 'PRAGMATIC_AZPG_AUTH', 'PRAGMATIC_AZPG_PASSWORD_REF',
    ]
    private static readonly TelemetryVariables: readonly string[] = [
        'PRAGMATIC_SERVICE_NAME', 'PRAGMATIC_METRICS_PORT', 'PRAGMATIC_OTLP_ENDPOINT', 'PRAGMATIC_OTLP_PROTOCOL', 'PRAGMATIC_OTLP_METRICS', 'PRAGMATIC_TRACE_SAMPLING',
    ]
    private static readonly PackVariables: readonly string[] = [
        'PRAGMATIC_ADAPTER_PACKS_DIR', 'PRAGMATIC_ADAPTER_PACKS_REQUIRE_SIGNATURES', 'PRAGMATIC_ADAPTER_PACKS_SANDBOX', 'PRAGMATIC_ADAPTER_PACKS_MAX_OLD_MB',
        'PRAGMATIC_ADAPTER_PACKS_MAX_YOUNG_MB', 'PRAGMATIC_ADAPTER_PACKS_STACK_MB', 'PRAGMATIC_ADAPTER_PACKS_EVICT_MAX_VERSIONS',
        'PRAGMATIC_ADAPTER_PACKS_EVICT_MAX_AGE_MS', 'PRAGMATIC_ADAPTER_PACKS_SCRIPT_ALLOWLIST',
    ]
    /** Every variable the readers name that the descriptor leaves out, and why (C3.1 ruling "platform-owned settings"). */
    public static readonly Undeclared: ReadonlyMap<string, string> = new Map<string, string>([
        ['PRAGMATIC_HOST', EnvServerComponentFixture.ListenerWiring],
        ['PRAGMATIC_PORT', EnvServerComponentFixture.ListenerWiring],
        ['PRAGMATIC_HEALTH_PORT', EnvServerComponentFixture.ListenerWiring],
        ['PRAGMATIC_BASE_DIR', EnvServerComponentFixture.EnvironmentWiring],
        ['PRAGMATIC_DEPLOYMENT_MODE', EnvServerComponentFixture.EnvironmentWiring],
        ['PRAGMATIC_CONFIG_FILE', EnvServerComponentFixture.EnvironmentWiring],
        ['PRAGMATIC_ENVIRONMENTS_FILE', EnvServerComponentFixture.EnvironmentWiring],
        ['PRAGMATIC_ENVIRONMENT_ID', EnvServerComponentFixture.EnvironmentWiring],
        ['PRAGMATIC_ENVIRONMENT_DISPLAY_NAME', EnvServerComponentFixture.EnvironmentWiring],
        ['PRAGMATIC_MASTER_KEY_FILE', EnvServerComponentFixture.TrustWiring],
        ['PRAGMATIC_MASTER_KEY_B64_ENV', EnvServerComponentFixture.TrustWiring],
        ['PRAGMATIC_PROVISIONED_SECRETS_FILE', EnvServerComponentFixture.TrustWiring],
        ['PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE', EnvServerComponentFixture.DatabaseWiring],
        ['PRAGMATIC_REDIS_URL', EnvServerComponentFixture.ClusterWiring],
        ['PRAGMATIC_REPLICA_ID', EnvServerComponentFixture.ClusterWiring],
        ['PRAGMATIC_WORKER_ADVERTISE_HOST', EnvServerComponentFixture.ClusterWiring],
        ['PRAGMATIC_WORKER_ADVERTISE_PORT', EnvServerComponentFixture.ClusterWiring],
        ['PRAGMATIC_WORKER_SERVERNAME', EnvServerComponentFixture.ClusterWiring],
        ['PRAGMATIC_TLS_CERT_FILE', EnvServerComponentFixture.TlsWiring],
        ['PRAGMATIC_TLS_KEY_FILE', EnvServerComponentFixture.TlsWiring],
        ['PRAGMATIC_TLS_CA_FILE', EnvServerComponentFixture.TlsWiring],
        ['PRAGMATIC_CLIENT_TLS_CERT_FILE', EnvServerComponentFixture.TlsWiring],
        ['PRAGMATIC_CLIENT_TLS_KEY_FILE', EnvServerComponentFixture.TlsWiring],
        ['PRAGMATIC_CLIENT_TLS_CA_FILE', EnvServerComponentFixture.TlsWiring],
        ...EnvServerComponentFixture.CloudVariables.map(name => [name, EnvServerComponentFixture.CloudWiring] as [string, string]),
        ['PRAGMATIC_ALLOWED_ORIGINS', EnvServerComponentFixture.OriginWiring],
        ...EnvServerComponentFixture.TelemetryVariables.map(name => [name, EnvServerComponentFixture.TelemetryWiring] as [string, string]),
        ['PRAGMATIC_WS_READ_IDLE_MS', EnvServerComponentFixture.UnusedReadIdle],
        ['PRAGMATIC_AUDIT_SINK', EnvServerComponentFixture.AuditWiring],
        ['PRAGMATIC_AUDIT_FILE', EnvServerComponentFixture.RetiredAuditFile],
        ...EnvServerComponentFixture.PackVariables.map(name => [name, EnvServerComponentFixture.PacksWiring] as [string, string]),
    ])

    public static Option(name: string): OptionDescriptor
    {
        const found = EnvServerComponent.Descriptor().Options.find(o => o.Name === name)
        assert.ok(found !== undefined, name)
        return found
    }
}

describe('EnvServerComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(EnvServerComponent.Descriptor(), EnvServerComponentFixture.Golden, EnvServerDescriptorPin.Digest)
    })

    it('declares the bounds of its timings and sizes, the drain inside the grace period the manifests render (one constant)', () =>
    {
        const descriptor = EnvServerComponent.Descriptor()
        const bounded = descriptor.Options.flatMap(o => o.Settings.filter(s => s.Minimum !== undefined || s.Maximum !== undefined).map(s => [o.Name + '.' + s.Name, s.Minimum, s.Maximum]))
        assert.deepEqual(bounded, [
            ['core.idleTtlMs', 1000, 2147483647], ['core.idleSweepMs', 1000, 2147483647], ['core.drainTimeoutMs', 1, ComponentTermination.LongestDrainMs],
            ['webSocket.heartbeatMs', 1000, 2147483647], ['webSocket.backpressureGraceMs', 1, 2147483647], ['webSocket.maxInboundBytes', 1, EnvServerSettingBounds.LargestInboundBytes],
        ])
        assert.deepEqual(bounded.map(b => b[0]), [...EnvServerSettingBounds.Bounded()])
        assert.equal(EnvServerComponentFixture.Option('core').Setting('drainTimeoutMs')?.Default, ComponentTermination.LongestDrainMs)
    })

    it('the bounded options and settings are named from one home (review M7)', () =>
    {
        const B = EnvServerSettingBounds
        assert.deepEqual(EnvServerComponentFixture.Option(B.Core).Settings.slice(0, 3).map(s => s.Name), [B.IdleTtl, B.IdleSweep, B.DrainTimeout])
        assert.equal(B.WebSocket, 'webSocket')
        assert.ok([B.Heartbeat, B.BackpressureGrace, B.MaxInbound].every(name => EnvServerComponentFixture.Option(B.WebSocket).Settings.some(s => s.Name === name)))
    })

    it('a version outside a bound is refused by the descriptor (the console at save time, the start step at start)', () =>
    {
        const validation = new ConfigurationValidator(EnvServerComponent.Descriptor()).Validate({ options: { core: { drainTimeoutMs: ComponentTermination.LongestDrainMs + 1, idleSweepMs: 999 }, webSocket: { maxInboundBytes: 0 } } })
        assert.deepEqual(validation.Errors.map(e => [e.Path, e.Code]), [
            ['/options/core/drainTimeoutMs', ConfigurationErrorCode.AboveMaximum], ['/options/core/idleSweepMs', ConfigurationErrorCode.BelowMinimum],
            ['/options/webSocket/maxInboundBytes', ConfigurationErrorCode.BelowMinimum],
        ])
    })

    it('declares exactly the variables its configuration readers read', () =>
    {
        ComponentSources.AssertCovers(EnvServerComponent.Descriptor(), EnvServerComponentFixture.Readers, [...EnvServerComponentFixture.Undeclared.keys()])
    })

    it('declares tuning only: no database, listener, folder, environment, key, cluster, TLS, cloud, origin, telemetry, audit or pack wiring', () =>
    {
        const descriptor = EnvServerComponent.Descriptor()
        assert.deepEqual(descriptor.Options.map(o => o.Name), ['core', 'rateLimit', 'webSocket', 'paging'])
        assert.deepEqual(EnvServerComponentFixture.Option('core').Settings.map(s => s.Name), ['idleTtlMs', 'idleSweepMs', 'drainTimeoutMs'])
        assert.equal(EnvServerComponentFixture.Option('webSocket').Settings.some(s => s.Name === 'readIdleMs'), false, 'readIdleMs: unused by the env server')
    })

    it('requires no setting and holds no secret: a tenant configuration is optional tuning', () =>
    {
        const settings = EnvServerComponent.Descriptor().Options.flatMap(o => o.Settings)
        assert.deepEqual(settings.filter(s => s.Required).map(s => s.Name), [])
        assert.deepEqual(settings.filter(s => s.Secret).map(s => s.Name), [])
    })

    it('gives a reason for every variable it leaves out', () =>
    {
        for (const [name, reason] of EnvServerComponentFixture.Undeclared)
        {
            assert.match(reason, /^(platform-owned|retired|unused|not configurable): /, name)
        }
    })

    it('lists as left out only variables its readers still read', () =>
    {
        const read = ComponentSources.ReadBy(EnvServerComponentFixture.Readers)
        assert.deepEqual([...EnvServerComponentFixture.Undeclared.keys()].filter(name => !read.includes(name)), [])
    })

    it('is named for its release image', () =>
    {
        assert.equal(EnvServerComponent.Descriptor().Name, 'pragmatic-env-server')
    })
})
