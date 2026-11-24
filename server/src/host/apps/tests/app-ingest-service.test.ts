import { describe, it, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { Repository, toJSON, type PackageDocument } from '@pragmatic-tech-ai/todl'
import { InMemoryMessageSocket, PragmaticClient, AppWriteStatus, type CypherAppDeployParamsDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { AccessContext, Principal, PrincipalKind, Realm, RealmKind, Grant, Role, ResourceRef, ResourceKind, ResourceAuthorizationPolicy } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { AppIngestService } from '../app-ingest-service.js'
import { DeliveryChannel, EnvironmentCatalogError, EnvironmentCatalogErrorCode } from '@pragmatic-tech-ai/todl/engine'
import type { DeliveryChange, IDelivered, IDeliveryGate } from '../../environment/environment-deliveries.js'
import { EnvironmentUpgradeFailedError } from '../../environment/environment-engine-host.js'
import { PragmaticAppsRegistry, type ApplicationRecord } from '../pragmatic-apps-registry.js'
import { ApplicationFiles } from '../application-files.js'
import type { PragmaticAppManifest } from '../pragmatic-app-manifest.js'
import { PragmaticServer } from '../../../pragmatic-server.js'
import { EnvironmentPurpose } from '../../../environments/environment-purpose.js'
import { StructuredLogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { ServerConnectionHandler } from '../../server-connection-handler.js'
import { CustomPlatformFixture } from '../../../platform/tests/custom-platform-fixture.js'
import { EnvServerDatabase } from '../../../storage/env-server-database.js'
import { EnvServerRegistry } from '../../../storage/env-server-registry.js'
import { EnvironmentRecords } from '../../../storage/environment-records.js'
import { EnvServerTestDatabase } from '../../../storage/tests/env-server-test-database.js'
import { AppServingHarness } from './app-serving-harness.js'

class RecordingStorage extends NodeFsStorage
{
    public readonly Renamed: string[] = []

    public override async Rename(from: string, to: string): Promise<void>
    {
        this.Renamed.push(to)
        await super.Rename(from, to)
    }
}

/** Runs every persist step and records the changes whose persist step completed (the deliveries that landed). */
class RecordingGate implements IDeliveryGate
{
    public readonly Delivered: DeliveryChange[] = []

    public async Deliver<T>(change: DeliveryChange, persist: () => Promise<T>): Promise<IDelivered<T>>
    {
        const result = await persist()
        this.Delivered.push(change)
        return { Result: result }
    }
}

/** A gate refusing every delivery with `error` before persisting (the composition failed). */
class RefusingGate implements IDeliveryGate
{
    public constructor(private readonly error: Error)
    {
    }

    public Deliver<T>(): Promise<IDelivered<T>>
    {
        return Promise.reject(this.error)
    }
}

/** A gate whose persist step lands but whose engine upgrade then fails (S4 step 4). */
class UpgradeFailingGate implements IDeliveryGate
{
    private static readonly FailureMessage = 'upgrade failed'

    public async Deliver<T>(_change: DeliveryChange, persist: () => Promise<T>): Promise<IDelivered<T>>
    {
        const result = await persist()
        throw new EnvironmentUpgradeFailedError(result, new Error(UpgradeFailingGate.FailureMessage))
    }
}

/** A registry whose Commit (the deploy's one database write) throws while `Fail` is set. */
class CommitFailingRegistry extends PragmaticAppsRegistry
{
    private static readonly FailureMessage = 'commit boom '

    public Fail = true

    public override async Commit(manifest: PragmaticAppManifest, digest?: string): Promise<void>
    {
        if (this.Fail)
        {
            throw new Error(CommitFailingRegistry.FailureMessage + IngestFixture.Secret)
        }
        await super.Commit(manifest, digest)
    }
}

/** A registry noting, at Commit, which application files had been renamed into place (the commit must come last). */
class OrderingRegistry extends PragmaticAppsRegistry
{
    public RenamedAtCommit: readonly string[] | undefined

    public constructor(records: EnvironmentRecords<ApplicationRecord>, private readonly apps: RecordingStorage)
    {
        super(records)
    }

    public override async Commit(manifest: PragmaticAppManifest, digest?: string): Promise<void>
    {
        this.RenamedAtCommit = [...this.apps.Renamed]
        await super.Commit(manifest, digest)
    }
}

/** A registry that lets another writer commit `rival` (same name@version, other content) just before this one claims. */
class RivalClaimRegistry extends PragmaticAppsRegistry
{
    public constructor(records: EnvironmentRecords<ApplicationRecord>, private readonly rival: () => Promise<void>)
    {
        super(records)
    }

    public override async Claim(manifest: PragmaticAppManifest, digest: string): Promise<void>
    {
        await this.rival()
        await super.Claim(manifest, digest)
    }
}

class IngestFixture
{
    public static readonly App = 'shop'
    public static readonly Version = '1.0.0'
    public static readonly NextVersion = '2.0.0'
    public static readonly Entry = 'index.html'
    public static readonly Asset = 'assets/app.js'
    public static readonly Shell = '<html></html>'
    public static readonly Secret = 'SECRET-PAYLOAD-BYTES'
    public static readonly EnvironmentId = 't1'
    public static readonly CorePackage = 'shop.core'
    public static readonly BasePackage = 'shop.base'
    public static readonly BaseVersion = '2.0.0'
    public static readonly CoreConcept = 'Order'
    public static readonly BaseConcept = 'Customer'
    public static readonly ModelFile = 'model.json'
    public static readonly UiDir = 'ui'
    public static readonly StagingMarker = '.ingest-'
    public static readonly ShopRoute = '/app/t1/shop/'

    public readonly Root = mkdtempSync(join(tmpdir(), 'ingest-'))
    public readonly PackagesDir = join(this.Root, 'packages')
    public readonly AppsDir = join(this.Root, 'applications')
    public readonly Packages = new RecordingStorage(this.PackagesDir)
    public readonly Apps = new RecordingStorage(this.AppsDir)
    public readonly Gate = new RecordingGate()
    public readonly Database = EnvServerTestDatabase.Mem()
    public readonly Registry = new PragmaticAppsRegistry(IngestFixture.Records(this.Database))
    public readonly Service = new AppIngestService(this.Packages, this.Apps, this.Registry, this.Gate)

    /** The applications records of the fixture environment in `database`. */
    public static Records(database: EnvServerDatabase): EnvironmentRecords<ApplicationRecord>
    {
        return new EnvironmentRecords<ApplicationRecord>(database, EnvServerRegistry.Applications, IngestFixture.EnvironmentId)
    }

    public static Realm(): Realm
    {
        return new Realm(IngestFixture.EnvironmentId, RealmKind.SelfHosted, 'Environment One')
    }

    public static Context(role: Role): AccessContext
    {
        const principal = new Principal('p1', IngestFixture.EnvironmentId, PrincipalKind.User, new Map(), [])
        const grants = [new Grant('p1', role, new ResourceRef(ResourceKind.Realm, IngestFixture.EnvironmentId, []))]
        return new AccessContext(principal, IngestFixture.Realm(), grants, new ResourceAuthorizationPolicy())
    }

    public static Params(): CypherAppDeployParamsDto
    {
        return {
            appName: IngestFixture.App,
            appVersion: IngestFixture.Version,
            packages: [
                { id: 'shop.core', version: '1.0.0', modelJson: '{"dependencies":[{"id":"shop.base","version":"2.0.0"}]}' },
                { id: 'shop.base', version: '2.0.0', modelJson: '{}' },
            ],
            uiBundle: [
                { path: IngestFixture.Entry, contentBase64: Buffer.from(IngestFixture.Shell).toString('base64') },
                { path: IngestFixture.Asset, contentBase64: Buffer.from(IngestFixture.Secret).toString('base64') },
            ],
            manifest: {
                name: IngestFixture.App,
                version: IngestFixture.Version,
                packages: [{ id: 'shop.core', version: '1.0.0' }],
                ui: { entry: IngestFixture.Entry, assets: [IngestFixture.Asset] },
            },
        }
    }

    /** `Params` for `version`, its shell naming the version. */
    public static ParamsOf(version: string): CypherAppDeployParamsDto
    {
        const params = IngestFixture.Params()
        params.appVersion = version
        params.manifest.version = version
        params.uiBundle[0]!.contentBase64 = Buffer.from(IngestFixture.ShellOf(version)).toString('base64')
        return params
    }

    public static ShellOf(version: string): string
    {
        return '<html>v' + version + '</html>'
    }

    /**
     * `Params` with real package documents (the environment gate composes them on a server): shop.core defines a concept
     * and depends on shop.base, which defines another.
     */
    public static ServableParams(): CypherAppDeployParamsDto
    {
        const params = IngestFixture.Params()
        const core = { ...IngestFixture.Document(IngestFixture.CorePackage, IngestFixture.CoreConcept), dependencies: [{ id: IngestFixture.BasePackage, version: IngestFixture.BaseVersion }] }
        params.packages[0]!.modelJson = JSON.stringify(core)
        params.packages[1]!.modelJson = JSON.stringify(IngestFixture.Document(IngestFixture.BasePackage, IngestFixture.BaseConcept))
        return params
    }

    private static Document(namespace: string, concept: string): PackageDocument
    {
        const repo = new Repository()
        repo.builder().defineConcept(concept).setNamespace(namespace).commit()
        return toJSON(repo) as PackageDocument
    }

    /** The path of a UI file of `version` in the applications storage. */
    public UiFile(version: string, file: string): string
    {
        return join(this.AppsDir, IngestFixture.App, version, IngestFixture.UiDir, file)
    }

    public Dispose(): void
    {
        rmSync(this.Root, { recursive: true, force: true })
    }

    public static async Run(body: (fx: IngestFixture) => Promise<void>): Promise<void>
    {
        const fx = new IngestFixture()
        try
        {
            await body(fx)
        }
        finally
        {
            fx.Dispose()
        }
    }
}

test('a valid deploy writes packages and UI assets, then commits the manifest and the live pointer to the registry', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const result = await fx.Service.Ingest(IngestFixture.Params())
        assert.equal(result.status, AppWriteStatus.Applied)
        assert.equal(result.reason, undefined)
        assert.ok(existsSync(join(fx.PackagesDir, 'shop.core', '1.0.0', 'model.json')))
        assert.ok(existsSync(join(fx.PackagesDir, 'shop.base', '2.0.0', 'model.json')))
        assert.equal(readFileSync(fx.UiFile('1.0.0', IngestFixture.Asset), 'utf8'), IngestFixture.Secret)
        assert.deepEqual(readdirSync(join(fx.AppsDir, 'shop')), ['1.0.0'], 'no live pointer file')
        assert.deepEqual(readdirSync(join(fx.AppsDir, 'shop', '1.0.0')), ['ui'], 'no manifest file')
        assert.equal((await fx.Registry.ApplicationFor('shop')).Manifest.version, '1.0.0')
        assert.equal(await fx.Registry.LiveVersion('shop'), '1.0.0')
        assert.equal((await new PragmaticAppsRegistry(IngestFixture.Records(fx.Database)).ApplicationFor('shop')).Manifest.version, '1.0.0', 'a fresh registry over the database reads it')
        assert.deepEqual(fx.Gate.Delivered, [{ Channel: DeliveryChannel.Deploy, Name: 'shop', Packages: [{ model: 'shop.core', version: '1.0.0' }], Version: '1.0.0' }])
    })
})

test('a writer that committed the version first (another worker) wins: this ingest is a Conflict and writes no UI file', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const rival = { ...IngestFixture.Params().manifest, packages: [] }
        const registry = new RivalClaimRegistry(IngestFixture.Records(fx.Database), () => new PragmaticAppsRegistry(IngestFixture.Records(fx.Database)).Commit(rival))
        const service = new AppIngestService(fx.Packages, fx.Apps, registry, fx.Gate)
        const result = await service.Ingest(IngestFixture.Params())
        assert.equal(result.status, AppWriteStatus.Conflict, JSON.stringify(result))
        assert.match(result.reason ?? '', /immutable/)
        assert.deepEqual((await registry.ManifestOf('shop', '1.0.0'))?.packages, [], 'the winner\'s manifest stays')
        assert.equal(existsSync(fx.UiFile('1.0.0', IngestFixture.Entry)), false, 'the loser wrote no UI file')
    })
})

test('a failed UI write drops the claim, so a corrected retry of the version is not blocked', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const registry = new CommitFailingRegistry(IngestFixture.Records(fx.Database))
        const service = new AppIngestService(fx.Packages, fx.Apps, registry, fx.Gate)
        assert.equal((await service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Failed)
        assert.equal((await IngestFixture.Records(fx.Database).Get('shop'))?.claims, undefined, 'no claim left')
        registry.Fail = false
        assert.equal((await service.Ingest(IngestFixture.ParamsOf(IngestFixture.Version))).status, AppWriteStatus.Applied, 'other content of the same version')
    })
})

test('an applied deploy is mirrored to the unpacker handoff files', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const registry = new PragmaticAppsRegistry(IngestFixture.Records(fx.Database), new ApplicationFiles(fx.Apps))
        const service = new AppIngestService(fx.Packages, fx.Apps, registry, fx.Gate)
        assert.equal((await service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        assert.equal(readFileSync(join(fx.AppsDir, 'shop', 'live'), 'utf8'), '1.0.0')
        assert.deepEqual(JSON.parse(readFileSync(join(fx.AppsDir, 'shop', '1.0.0', 'application.json'), 'utf8')), IngestFixture.Params().manifest)
    })
})

test('the registry commit comes after every UI file is in place', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const registry = new OrderingRegistry(IngestFixture.Records(fx.Database), fx.Apps)
        const service = new AppIngestService(fx.Packages, fx.Apps, registry, fx.Gate)
        assert.equal((await service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        assert.deepEqual([...(registry.RenamedAtCommit ?? [])].sort(), ['shop/1.0.0/ui/assets/app.js', 'shop/1.0.0/ui/index.html'])
        assert.equal(await registry.LiveVersion('shop'), '1.0.0')
    })
})

test('an incomplete package closure is rejected and nothing servable is written', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const params = IngestFixture.Params()
        params.packages = params.packages.filter(p => p.id !== 'shop.base')
        const result = await fx.Service.Ingest(params)
        assert.notEqual(result.status, AppWriteStatus.Applied)
        assert.match(result.reason ?? '', /shop\.base@2\.0\.0/)
        assert.equal(await fx.Registry.ManifestOf('shop', '1.0.0'), undefined)
        assert.equal(existsSync(join(fx.AppsDir, 'shop')), false)
        assert.equal(existsSync(join(fx.PackagesDir)), false)
        assert.deepEqual(fx.Gate.Delivered, [])
    })
})

test('a manifest-referenced package that is not supplied is rejected', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const params = IngestFixture.Params()
        params.manifest.packages.push({ id: 'ghost', version: '1.0.0' })
        const result = await fx.Service.Ingest(params)
        assert.notEqual(result.status, AppWriteStatus.Applied)
        assert.match(result.reason ?? '', /ghost@1\.0\.0/)
    })
})

test('path traversal in UI paths, package ids and app name is rejected without leaking payload bytes', async () =>
{
    const mutations: Array<(p: CypherAppDeployParamsDto) => void> = [
        p => { p.uiBundle[0]!.path = '../evil.js' },
        p => { p.uiBundle[0]!.path = 'a/../../evil.js' },
        p => { p.uiBundle[0]!.path = '/etc/passwd' },
        p => { p.uiBundle[0]!.path = 'C:/evil.js' },
        p => { p.uiBundle[0]!.path = 'a/.../b.js' },
        p => { p.uiBundle[0]!.path = '.git/config' },
        p => { p.uiBundle[0]!.path = 'CON' },
        p => { p.uiBundle[0]!.path = 'x/nul.txt' },
        p => { p.uiBundle[0]!.path = 'trailing.' },
        p => { p.uiBundle[0]!.path = 'trailing ' },
        p => { p.uiBundle[0]!.contentBase64 = '' },
        p => { p.packages[1]!.id = 'COM1' },
        p => { p.uiBundle[0]!.path = 'a\\..\\evil.js' },
        p => { p.packages[1]!.id = '..' },
        p => { p.packages[1]!.id = '../x' },
        p => { p.packages[1]!.version = 'C:' },
        p => { p.appName = '..' },
        p => { p.appName = 'a/b' },
    ]
    for (const mutate of mutations)
    {
        await IngestFixture.Run(async fx =>
        {
            const params = IngestFixture.Params()
            mutate(params)
            const result = await fx.Service.Ingest(params)
            assert.equal(result.status, AppWriteStatus.Invalid)
            assert.equal((result.reason ?? '').includes(IngestFixture.Secret), false)
            assert.equal(existsSync(fx.PackagesDir), false)
            assert.equal(existsSync(fx.AppsDir), false)
            assert.equal(existsSync(join(fx.Root, 'evil.js')), false)
            assert.deepEqual(await fx.Registry.List(), [])
        })
    }
})

class DeployWire
{
    public static async Attach(fx: IngestFixture, role: Role): Promise<{ client: PragmaticClient; Dispose: () => Promise<void> }>
    {
        const server = new PragmaticServer({ platform: CustomPlatformFixture.Mem(), environmentId: CustomPlatformFixture.EnvironmentId, packagesRoot: fx.PackagesDir, applicationsRoot: fx.AppsDir, graphsRoot: join(fx.Root, 'graphs'), purpose: EnvironmentPurpose.Runtime })
        await server.Start()
        const languageService = await server.LanguageService()
        const manager = await server.Manager()
        const [serverSocket, clientSocket] = InMemoryMessageSocket.Pair()
        const runtime = ServerConnectionHandler.RuntimeAttachArgs(server, server.Purpose())
        const handler = ServerConnectionHandler.Attach(
            serverSocket, languageService, manager, IngestFixture.Context(role),
            undefined, undefined,
            undefined, undefined, undefined, undefined, undefined, undefined, EnvironmentPurpose.Runtime,
            runtime.applications, runtime.data,
            undefined, undefined, runtime.deployProvider)
        const client = PragmaticClient.CreateOverSocket(clientSocket)
        return {
            client,
            Dispose: async () =>
            {
                await client.DisposeAsync()
                handler.Dispose()
                await server.Dispose()
            },
        }
    }
}

test('RunDeploy denies a principal without environment Administer and writes nothing', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const wire = await DeployWire.Attach(fx, Role.Editor)
        try
        {
            await assert.rejects(() => wire.client.DeployApplication(IngestFixture.Params()))
            assert.equal(existsSync(join(fx.AppsDir, 'shop')), false)
            assert.deepEqual(await wire.client.ListApplications(), [])
        }
        finally
        {
            await wire.Dispose()
        }
    })
})

test('RunDeploy lets an Admin deploy and the app is then listed', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const wire = await DeployWire.Attach(fx, Role.Admin)
        try
        {
            const result = await wire.client.DeployApplication(IngestFixture.ServableParams())
            assert.equal(result.status, AppWriteStatus.Applied, result.reason)
            const apps = await wire.client.ListApplications()
            assert.ok(apps.some(a => a.name === 'shop' && a.version === '1.0.0'))
        }
        finally
        {
            await wire.Dispose()
        }
    })
})

class FailingStorage extends RecordingStorage
{
    public FailRenameTo = ''

    public override async Rename(from: string, to: string): Promise<void>
    {
        if (to === this.FailRenameTo)
        {
            throw new Error('boom ' + IngestFixture.Secret)
        }
        await super.Rename(from, to)
    }
}

test('redeploying an existing name@version is refused and leaves the live app untouched', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        const before = await fx.Registry.ManifestOf('shop', '1.0.0')
        const again = IngestFixture.Params()
        again.uiBundle[0]!.contentBase64 = Buffer.from('<html>changed</html>').toString('base64')
        const result = await fx.Service.Ingest(again)
        assert.equal(result.status, AppWriteStatus.Conflict)
        assert.match(result.reason ?? '', /immutable/)
        assert.deepEqual(await fx.Registry.ManifestOf('shop', '1.0.0'), before)
        assert.equal(await fx.Registry.LiveVersion('shop'), '1.0.0')
        assert.equal(readFileSync(fx.UiFile('1.0.0', IngestFixture.Entry), 'utf8'), IngestFixture.Shell)
    })
})

test('a package version already deployed with different content is refused', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        const next = IngestFixture.ParamsOf(IngestFixture.NextVersion)
        next.packages[1]!.modelJson = '{"changed":true}'
        const result = await fx.Service.Ingest(next)
        assert.equal(result.status, AppWriteStatus.Conflict)
        assert.equal(readFileSync(join(fx.PackagesDir, 'shop.base', '2.0.0', 'model.json'), 'utf8'), '{}')
        assert.equal(await fx.Registry.ManifestOf('shop', IngestFixture.NextVersion), undefined)
    })
})

test('a delivery the gate refuses is invalid with its message and writes neither the UI tree nor the registry record', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const refusal = new EnvironmentCatalogError(EnvironmentCatalogErrorCode.IncompatibleVersions, 'shop.core', ['shop'], 'incompatible')
        const service = new AppIngestService(fx.Packages, fx.Apps, fx.Registry, new RefusingGate(refusal))
        const result = await service.Ingest(IngestFixture.Params())
        assert.equal(result.status, AppWriteStatus.Invalid)
        assert.equal(result.reason, 'incompatible')
        assert.ok(existsSync(join(fx.PackagesDir, 'shop.core', '1.0.0', 'model.json')), 'the packages are stored first (immutable)')
        assert.equal(existsSync(join(fx.AppsDir, 'shop')), false)
        assert.equal(await fx.Registry.ManifestOf('shop', '1.0.0'), undefined)
    })
})

test('an upgrade failure after the commit answers failed with the upgrade reason and the app is live', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const service = new AppIngestService(fx.Packages, fx.Apps, fx.Registry, new UpgradeFailingGate())
        const result = await service.Ingest(IngestFixture.Params())
        assert.equal(result.status, AppWriteStatus.Failed)
        assert.equal(result.reason, EnvironmentUpgradeFailedError.Reason)
        assert.equal(await fx.Registry.LiveVersion('shop'), '1.0.0')
    })
})

test('a failure while renaming the UI files removes the renamed files, logs only class/code, and keeps the reason secret-free', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const apps = new FailingStorage(fx.AppsDir)
        apps.FailRenameTo = 'shop/1.0.0/ui/assets/app.js'
        const lines: string[] = []
        const logger = StructuredLogger.ToSink(line => lines.push(line))
        const service = new AppIngestService(fx.Packages, apps, fx.Registry, fx.Gate, logger)
        const result = await service.Ingest(IngestFixture.Params())
        assert.equal(result.status, AppWriteStatus.Failed)
        assert.equal(JSON.stringify(result).includes(IngestFixture.Secret), false)
        assert.equal(lines.join('').includes(IngestFixture.Secret), false)
        assert.match(lines.join(''), /"errorClass":"Error"/)
        assert.equal(existsSync(fx.UiFile('1.0.0', IngestFixture.Entry)), false)
        assert.equal(existsSync(fx.UiFile('1.0.0', IngestFixture.Asset)), false)
        assert.deepEqual(readdirSync(join(fx.AppsDir, 'shop', '1.0.0', 'ui')).filter(n => n.includes(IngestFixture.StagingMarker)), [])
        assert.equal(await fx.Registry.ManifestOf('shop', '1.0.0'), undefined)
        assert.deepEqual(fx.Gate.Delivered, [])
    })
})

test('an ingest that fails before Commit leaves the old live version and no new manifest', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.ParamsOf(IngestFixture.Version))).status, AppWriteStatus.Applied)
        const registry = new CommitFailingRegistry(IngestFixture.Records(fx.Database))
        const lines: string[] = []
        const service = new AppIngestService(fx.Packages, fx.Apps, registry, fx.Gate, StructuredLogger.ToSink(line => lines.push(line)))
        const result = await service.Ingest(IngestFixture.ParamsOf(IngestFixture.NextVersion))
        assert.equal(result.status, AppWriteStatus.Failed)
        assert.equal(JSON.stringify(result).includes(IngestFixture.Secret), false)
        assert.equal(lines.join('').includes(IngestFixture.Secret), false)
        assert.equal(await fx.Registry.LiveVersion('shop'), IngestFixture.Version)
        assert.equal(await fx.Registry.ManifestOf('shop', IngestFixture.NextVersion), undefined)
        const serving = await AppServingHarness.Start(IngestFixture.EnvironmentId, { AppsStorage: () => fx.Apps, Applications: () => fx.Registry })
        try
        {
            const shell = await serving.Get(IngestFixture.ShopRoute)
            assert.equal(shell.status, 200)
            assert.equal(shell.body, IngestFixture.ShellOf(IngestFixture.Version), 'serving still serves the old live version')
        }
        finally
        {
            await serving.Dispose()
        }
    })
})

test('a retry after a failed Commit ingests again and goes live', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const registry = new CommitFailingRegistry(IngestFixture.Records(fx.Database))
        const service = new AppIngestService(fx.Packages, fx.Apps, registry, fx.Gate)
        assert.equal((await service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Failed)
        assert.equal(await registry.ManifestOf('shop', '1.0.0'), undefined, 'the orphan UI files are not a committed version')
        registry.Fail = false
        assert.equal((await service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        assert.equal(await registry.LiveVersion('shop'), '1.0.0')
        assert.equal((await service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Conflict)
    })
})

test('a bundle asset named like a temp file does not collide with staging', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const params = IngestFixture.Params()
        params.uiBundle.push({ path: 'assets/app.js.ingest-tmp', contentBase64: Buffer.from('x').toString('base64') })
        const result = await fx.Service.Ingest(params)
        assert.equal(result.status, AppWriteStatus.Applied)
        assert.equal(readFileSync(fx.UiFile('1.0.0', IngestFixture.Asset), 'utf8'), IngestFixture.Secret)
        assert.equal(readFileSync(fx.UiFile('1.0.0', 'assets/app.js.ingest-tmp'), 'utf8'), 'x')
    })
})

test('a multi-megabyte UI asset is accepted (base64 validation scales past the regex stack limit)', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const largeBytes = 8 * 1024 * 1024
        const params = IngestFixture.Params()
        params.uiBundle[0]!.contentBase64 = Buffer.alloc(largeBytes, 0x61).toString('base64')
        const result = await fx.Service.Ingest(params)
        assert.equal(result.status, AppWriteStatus.Applied)
        assert.equal(readFileSync(fx.UiFile('1.0.0', IngestFixture.Entry)).length, largeBytes)
    })
})

test('a UI asset whose length is not a base64 multiple of four is rejected', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const params = IngestFixture.Params()
        params.uiBundle[0]!.contentBase64 = 'QUJD'.slice(0, 3)
        const result = await fx.Service.Ingest(params)
        assert.equal(result.status, AppWriteStatus.Invalid)
    })
})

test('concurrent deploys of the same app serialize: exactly one is Applied, the other is a Conflict', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const results = await Promise.all([fx.Service.Ingest(IngestFixture.Params()), fx.Service.Ingest(IngestFixture.Params())])
        assert.deepEqual(results.map(r => r.status).sort(), [AppWriteStatus.Applied, AppWriteStatus.Conflict])
    })
})

test('only a whitelisted manifest projection is persisted', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        const params = IngestFixture.Params()
        ;(params.manifest as unknown as Record<string, unknown>).evil = 'x'
        ;(params.manifest.packages[0] as unknown as Record<string, unknown>).extra = 'y'
        await fx.Service.Ingest(params)
        assert.deepEqual(await fx.Registry.ManifestOf('shop', '1.0.0'), {
            name: 'shop', version: '1.0.0', packages: [{ id: 'shop.core', version: '1.0.0' }],
            ui: { entry: 'index.html', assets: ['assets/app.js'] },
        })
    })
})

test('a mid-commit failure of a later version leaves the earlier version tree and the live version untouched', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        const apps = new FailingStorage(fx.AppsDir)
        apps.FailRenameTo = 'shop/2.0.0/ui/extra.js'
        const service = new AppIngestService(fx.Packages, apps, fx.Registry, fx.Gate)
        const next = IngestFixture.ParamsOf(IngestFixture.NextVersion)
        next.uiBundle.push({ path: 'extra.js', contentBase64: Buffer.from('n').toString('base64') })
        const result = await service.Ingest(next)
        assert.equal(result.status, AppWriteStatus.Failed)
        assert.ok(existsSync(fx.UiFile('1.0.0', IngestFixture.Entry)))
        assert.ok(existsSync(fx.UiFile('1.0.0', IngestFixture.Asset)))
        assert.equal(existsSync(fx.UiFile('2.0.0', IngestFixture.Entry)), false)
        assert.equal(existsSync(fx.UiFile('2.0.0', 'extra.js')), false)
        assert.equal(await fx.Registry.LiveVersion('shop'), '1.0.0')
        assert.equal(await fx.Registry.ManifestOf('shop', '2.0.0'), undefined)
        assert.equal((await fx.Registry.ManifestOf('shop', '1.0.0'))?.version, '1.0.0')
    })
})

test('Ingest writes UI under <app>/<version>/ui and the manifest only to the registry', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        assert.equal(readFileSync(fx.UiFile('1.0.0', IngestFixture.Entry), 'utf8'), IngestFixture.Shell)
        assert.equal((await fx.Registry.ManifestOf('shop', '1.0.0'))?.version, '1.0.0')
        assert.equal(existsSync(join(fx.AppsDir, 'shop', '1.0.0', 'application.json')), false)
        assert.equal(existsSync(join(fx.AppsDir, 'shop', 'ui')), false)
        assert.equal(existsSync(join(fx.AppsDir, 'shop', 'application.json')), false)
        assert.equal(existsSync(join(fx.AppsDir, 'shop', 'live')), false)
    })
})

test('deploying a second version leaves the first version tree and manifest intact and moves live', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        const next = IngestFixture.ParamsOf(IngestFixture.NextVersion)
        assert.equal((await fx.Service.Ingest(next)).status, AppWriteStatus.Applied)
        assert.equal(readFileSync(fx.UiFile('1.0.0', IngestFixture.Entry), 'utf8'), IngestFixture.Shell)
        assert.equal((await fx.Registry.ManifestOf('shop', '1.0.0'))?.version, '1.0.0')
        assert.equal(readFileSync(fx.UiFile('2.0.0', IngestFixture.Entry), 'utf8'), IngestFixture.ShellOf(IngestFixture.NextVersion))
        assert.equal(await fx.Registry.LiveVersion('shop'), '2.0.0')
        assert.equal((await fx.Registry.ApplicationFor('shop')).Manifest.version, '2.0.0')
    })
})

test('the reserved version names live and ui are rejected', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        for (const reserved of ['live', 'ui', 'application.json'])
        {
            const params = IngestFixture.Params()
            params.appVersion = reserved
            params.manifest.version = reserved
            const result = await fx.Service.Ingest(params)
            assert.equal(result.status, AppWriteStatus.Invalid)
            assert.match(result.reason ?? '', /reserved/)
        }
        assert.equal(existsSync(join(fx.AppsDir, 'shop')), false)
    })
})

test('a resume writes a package the interrupted deploy had not stored', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        assert.equal((await fx.Service.Ingest(IngestFixture.ParamsOf(IngestFixture.NextVersion))).status, AppWriteStatus.Applied)
        const missing = join(fx.PackagesDir, IngestFixture.BasePackage, IngestFixture.BaseVersion, IngestFixture.ModelFile)
        rmSync(missing)
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        assert.ok(existsSync(missing), 'the gate composes over the full closure')
        assert.equal(await fx.Registry.LiveVersion('shop'), '1.0.0')
    })
})

test('re-deploying an existing non-live version with identical UI and manifest but a differing package is a Conflict', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        const next = IngestFixture.Params()
        next.appVersion = '2.0.0'
        next.manifest.version = '2.0.0'
        assert.equal((await fx.Service.Ingest(next)).status, AppWriteStatus.Applied)
        const differingPackage = IngestFixture.Params()
        differingPackage.packages[1]!.modelJson = '{"changed":true}'
        assert.equal((await fx.Service.Ingest(differingPackage)).status, AppWriteStatus.Conflict)
        assert.equal(await fx.Registry.LiveVersion('shop'), '2.0.0')
    })
})

test('re-deploying an existing non-live version is a Conflict when the content differs and a repoint when identical', async () =>
{
    await IngestFixture.Run(async fx =>
    {
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        const next = IngestFixture.Params()
        next.appVersion = '2.0.0'
        next.manifest.version = '2.0.0'
        assert.equal((await fx.Service.Ingest(next)).status, AppWriteStatus.Applied)
        assert.equal(await fx.Registry.LiveVersion('shop'), '2.0.0')
        const differing = IngestFixture.Params()
        differing.uiBundle[0]!.contentBase64 = Buffer.from('<html>changed</html>').toString('base64')
        assert.equal((await fx.Service.Ingest(differing)).status, AppWriteStatus.Conflict)
        assert.equal(await fx.Registry.LiveVersion('shop'), '2.0.0')
        assert.equal(readFileSync(fx.UiFile('1.0.0', IngestFixture.Entry), 'utf8'), IngestFixture.Shell)
        const differingManifest = IngestFixture.Params()
        differingManifest.manifest.packages = []
        assert.equal((await fx.Service.Ingest(differingManifest)).status, AppWriteStatus.Conflict)
        assert.equal((await fx.Service.Ingest(IngestFixture.Params())).status, AppWriteStatus.Applied)
        assert.equal(await fx.Registry.LiveVersion('shop'), '1.0.0')
    })
})

SqlTestSessions.DescribeLive('AppIngestService', makeDatabase =>
{
    describe('two workers', () =>
    {
        it('two ingests of one application land one after the other [live]', async () =>
        {
            const live = await makeDatabase()
            const fx = new IngestFixture()
            try
            {
                const workers = [0, 1].map(() =>
                {
                    const registry = new PragmaticAppsRegistry(IngestFixture.Records(EnvServerDatabase.Over(live.Session())))
                    return { registry, service: new AppIngestService(new NodeFsStorage(fx.PackagesDir), new NodeFsStorage(fx.AppsDir), registry, new RecordingGate()) }
                })
                const versions = [IngestFixture.Version, IngestFixture.NextVersion]
                const results = await Promise.all(workers.map((worker, i) => worker.service.Ingest(IngestFixture.ParamsOf(versions[i]!))))
                assert.deepEqual(results.map(r => r.status), [AppWriteStatus.Applied, AppWriteStatus.Applied], JSON.stringify(results))
                const record = await IngestFixture.Records(EnvServerDatabase.Over(live.Session())).Get(IngestFixture.App)
                assert.deepEqual(Object.keys(record?.versions ?? {}).sort(), versions)
                assert.ok(versions.includes(record?.live ?? ''), 'live is one of the two versions')
                for (const version of versions)
                {
                    assert.equal(readFileSync(fx.UiFile(version, IngestFixture.Entry), 'utf8'), IngestFixture.ShellOf(version))
                }
            }
            finally
            {
                fx.Dispose()
                await live.Dispose()
            }
        })

        it('two ingests of one version with different content: exactly one lands, the other is a Conflict, the winner\'s shell serves [live]', async () =>
        {
            const live = await makeDatabase()
            const fx = new IngestFixture()
            try
            {
                const workers = [0, 1].map(() =>
                {
                    const registry = new PragmaticAppsRegistry(IngestFixture.Records(EnvServerDatabase.Over(live.Session())))
                    return new AppIngestService(new NodeFsStorage(fx.PackagesDir), new NodeFsStorage(fx.AppsDir), registry, new RecordingGate())
                })
                const shells = ['<html>first</html>', '<html>second</html>']
                const params = shells.map(shell =>
                {
                    const p = IngestFixture.Params()
                    p.uiBundle[0]!.contentBase64 = Buffer.from(shell).toString('base64')
                    return p
                })
                const results = await Promise.all(workers.map((service, i) => service.Ingest(params[i]!)))
                assert.deepEqual(results.map(r => r.status).sort(), [AppWriteStatus.Applied, AppWriteStatus.Conflict].sort(), JSON.stringify(results))
                const winner = results.findIndex(r => r.status === AppWriteStatus.Applied)
                assert.equal(readFileSync(fx.UiFile(IngestFixture.Version, IngestFixture.Entry), 'utf8'), shells[winner], 'the served shell is the winner\'s')
                const record = await IngestFixture.Records(EnvServerDatabase.Over(live.Session())).Get(IngestFixture.App)
                assert.equal(record?.live, IngestFixture.Version)
                assert.equal(record?.claims, undefined)
            }
            finally
            {
                fx.Dispose()
                await live.Dispose()
            }
        })
    })
})
