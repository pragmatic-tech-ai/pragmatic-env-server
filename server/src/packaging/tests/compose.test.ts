import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parse } from 'yaml'
import { FileEnvironmentProvisioning } from '../../config/file-environment-provisioning.js'

type ComposeService = { image?: string; build?: unknown; command?: readonly string[] }
type ComposeDocument = { services: Record<string, ComposeService> }

class Artifacts
{
    public static readonly ServerService = 'pragmatic-server'
    public static readonly ServerImage = /^ghcr\.io\/pragmatic-tech-ai\/pragmatic-env-server:/
    public static readonly GatewayImage = /^ghcr\.io\/pragmatic-tech-ai\/pragmatic-env-gateway:/
    public static readonly WorkerCommand = ['node', 'server/dist/bin/pragmatic-workerd.js']
    public static readonly Workers = ['worker1', 'worker2']
    public static readonly Gateway = 'gateway'
    public static readonly Redis = 'redis'
    public static readonly TlsMount = '/run/secrets/tls'
    private static readonly Utf8 = 'utf8'
    private static readonly ComposeFile = 'docker-compose.yml'
    private static readonly DockerDir = 'docker'
    private static readonly ClusterComposeFile = 'docker-compose.cluster.yml'
    private static readonly EnvironmentsExampleFile = 'environments.example.json'

    private static Root(): string
    {
        return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..')
    }

    public static Compose(): ComposeDocument
    {
        return parse(readFileSync(join(Artifacts.Root(), Artifacts.ComposeFile), Artifacts.Utf8)) as ComposeDocument
    }

    public static ClusterText(): string
    {
        return readFileSync(join(Artifacts.Root(), Artifacts.DockerDir, Artifacts.ClusterComposeFile), Artifacts.Utf8)
    }

    public static Cluster(): ComposeDocument
    {
        return parse(Artifacts.ClusterText()) as ComposeDocument
    }

    public static EnvironmentsExample(): string
    {
        return readFileSync(join(Artifacts.Root(), Artifacts.DockerDir, Artifacts.EnvironmentsExampleFile), Artifacts.Utf8)
    }
}

test('docker-compose is valid YAML with a pragmatic-server service', () =>
{
    const doc = Artifacts.Compose()
    assert.ok(doc.services !== undefined)
    assert.ok(Artifacts.ServerService in doc.services)
})

test('the compose service runs the released pragmatic-env-server image (no build from a sibling workspace)', () =>
{
    const service = Artifacts.Compose().services[Artifacts.ServerService]
    assert.match(service.image ?? '', Artifacts.ServerImage)
    assert.equal(service.build, undefined)
})

test('the cluster compose file runs two workers from the env-server image and the gateway from its own image', () =>
{
    const doc = Artifacts.Cluster()
    for (const name of Artifacts.Workers)
    {
        assert.match(doc.services[name].image ?? '', Artifacts.ServerImage)
        assert.deepEqual(doc.services[name].command, Artifacts.WorkerCommand)
    }
    const gateway = doc.services[Artifacts.Gateway]
    assert.match(gateway.image ?? '', Artifacts.GatewayImage)
    assert.equal(gateway.command, undefined)
    assert.ok(Artifacts.Redis in doc.services)
    assert.ok(Object.values(doc.services).every(service => service.build === undefined))
    assert.match(Artifacts.ClusterText(), new RegExp(Artifacts.TlsMount))
})

test('the example environments file parses through FileEnvironmentProvisioning', () =>
{
    const provisioning = FileEnvironmentProvisioning.FromText(Artifacts.EnvironmentsExample())
    assert.ok(provisioning.OptionsFor('acme') !== null)
})
