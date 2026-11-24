import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { EnvServerImport } from '../storage/env-server-import.js'
import { AppServingHarness } from '../host/apps/tests/app-serving-harness.js'
import { PragmaticServer } from '../pragmatic-server.js'
import { EnvironmentPurpose } from '../environments/environment-purpose.js'
import { CustomPlatformFixture } from '../platform/tests/custom-platform-fixture.js'
import { EnvServerRegistry } from '../storage/env-server-registry.js'

/** A pre-A5 base folder (the importer's golden fixture), and the in-cluster unpacker writing a UI release into it. */
class UnpackedReleaseFixture
{
    public static readonly Golden = join(dirname(fileURLToPath(import.meta.url)), '..', 'storage', 'tests', 'fixtures', 'pre-a5')
    public static readonly Key = Buffer.alloc(32, 42)
    public static readonly Environment = 'acme-rt'
    public static readonly App = 'demo'
    public static readonly Route = '/app/acme-rt/demo/'
    public readonly BaseDir = mkdtempSync(join(tmpdir(), 'srv-unpacked-'))
    public readonly AppsRoot = join(this.BaseDir, UnpackedReleaseFixture.Environment, 'applications')

    public constructor()
    {
        cpSync(UnpackedReleaseFixture.Golden, this.BaseDir, { recursive: true })
    }

    /** What pragmatic-ui-unpack writes: the UI tree, the manifest (packages carried over from the live one), then `live`. */
    public Unpack(version: string, shell: string): void
    {
        const app = join(this.AppsRoot, UnpackedReleaseFixture.App)
        const live = readFileSync(join(app, 'live'), 'utf8').trim()
        const packages = (JSON.parse(readFileSync(join(app, live, 'application.json'), 'utf8')) as { packages: unknown[] }).packages
        mkdirSync(join(app, version, 'ui'), { recursive: true })
        writeFileSync(join(app, version, 'ui', 'index.html'), shell)
        writeFileSync(join(app, version, 'application.json'), JSON.stringify({ name: UnpackedReleaseFixture.App, version, packages, ui: { entry: 'index.html', assets: [] } }, null, 2))
        writeFileSync(join(app, 'live'), version)
    }

    public LiveFile(): string
    {
        return readFileSync(join(this.AppsRoot, UnpackedReleaseFixture.App, 'live'), 'utf8').trim()
    }

    public Server(platform: ReturnType<typeof CustomPlatformFixture.Mem>): PragmaticServer
    {
        return new PragmaticServer({ platform, environmentId: UnpackedReleaseFixture.Environment, purpose: EnvironmentPurpose.Runtime, applicationsRoot: this.AppsRoot })
    }

    public Dispose(): void
    {
        rmSync(this.BaseDir, { recursive: true, force: true })
    }
}

class ApplicationsServerFixture
{
    private static readonly Prefix = 'srv-apps-'
    public readonly Dir = mkdtempSync(join(tmpdir(), ApplicationsServerFixture.Prefix))

    public Dispose(): void
    {
        rmSync(this.Dir, { recursive: true, force: true })
    }
}

test('Applications throws on a development environment', () =>
{
    const f = new ApplicationsServerFixture()
    try
    {
        const server = new PragmaticServer({ platform: CustomPlatformFixture.Mem(), environmentId: CustomPlatformFixture.EnvironmentId, applicationsRoot: f.Dir })
        assert.throws(() => server.Applications(), /runtime-environment feature/)
        const dev = new PragmaticServer({ platform: CustomPlatformFixture.Mem(), environmentId: CustomPlatformFixture.EnvironmentId, purpose: EnvironmentPurpose.Development, applicationsRoot: f.Dir })
        assert.throws(() => dev.Applications(), /runtime-environment feature/)
    }
    finally { f.Dispose() }
})

test('Applications and AppsStorage are memoised on a runtime environment', () =>
{
    const f = new ApplicationsServerFixture()
    try
    {
        const server = new PragmaticServer({ platform: CustomPlatformFixture.Mem(), environmentId: CustomPlatformFixture.EnvironmentId, purpose: EnvironmentPurpose.Runtime, applicationsRoot: f.Dir })
        assert.equal(server.Applications(), server.Applications())
        assert.equal(server.AppsStorage(), server.AppsStorage())
    }
    finally { f.Dispose() }
})

test('AppsStorage throws when a runtime environment has no applicationsRoot; Applications (the registry records) needs none', async () =>
{
    const server = new PragmaticServer({ platform: CustomPlatformFixture.Mem(), environmentId: CustomPlatformFixture.EnvironmentId, purpose: EnvironmentPurpose.Runtime })
    assert.throws(() => server.AppsStorage(), /applicationsRoot is required/)
    assert.deepEqual(await server.Applications().List(), [])
})

test('a UI release the in-cluster unpacker made live after the import is taken in at the next start and served', async () =>
{
    const f = new UnpackedReleaseFixture()
    const platform = CustomPlatformFixture.Mem()
    try
    {
        await new EnvServerImport(platform.Database, new NodeFsStorage(f.BaseDir), UnpackedReleaseFixture.Key).ImportIfPending()
        const first = f.Server(platform)
        await first.Start()
        assert.equal(await first.Applications().LiveVersion(UnpackedReleaseFixture.App), '2.0.0')
        await first.Dispose()

        f.Unpack('4.0.0', 'shell-4')
        const second = f.Server(platform)
        await second.Start()
        assert.equal(await second.Applications().LiveVersion(UnpackedReleaseFixture.App), '4.0.0')
        assert.deepEqual((await second.Applications().ManifestOf(UnpackedReleaseFixture.App, '4.0.0'))?.packages, [{ id: 'hr', version: '2.0.0' }], 'the data packages carried over')
        const serving = await AppServingHarness.Start(UnpackedReleaseFixture.Environment, second)
        try
        {
            assert.equal((await serving.Get(UnpackedReleaseFixture.Route)).body, 'shell-4')
        }
        finally
        {
            await serving.Dispose()
        }

        // A deploy through the server is mirrored to the handoff files, so a restart keeps it and the unpacker reads it.
        await second.Applications().Commit({ name: UnpackedReleaseFixture.App, version: '5.0.0', packages: [{ id: 'hr', version: '5.0.0' }] })
        assert.equal(f.LiveFile(), '5.0.0')
        await second.Dispose()
        const third = f.Server(platform)
        await third.Start()
        assert.equal(await third.Applications().LiveVersion(UnpackedReleaseFixture.App), '5.0.0')
        await third.Dispose()
    }
    finally
    {
        f.Dispose()
    }
})

test('a file pointer the database took already never moves the database back', async () =>
{
    const f = new UnpackedReleaseFixture()
    const platform = CustomPlatformFixture.Mem()
    try
    {
        await new EnvServerImport(platform.Database, new NodeFsStorage(f.BaseDir), UnpackedReleaseFixture.Key).ImportIfPending()
        const first = f.Server(platform)
        await first.Start()
        // A deploy whose mirror never reached the files (the process died after the commit): the files still name 2.0.0.
        const records = first.Records<{ id: string; live: string | null; versions: Record<string, unknown> }>(EnvServerRegistry.Applications)
        await records.Update(UnpackedReleaseFixture.App, current => ({ ...current!, live: '1.0.0' }))
        await first.Dispose()
        const second = f.Server(platform)
        await second.Start()
        assert.equal(await second.Applications().LiveVersion(UnpackedReleaseFixture.App), '1.0.0', 'the files named 2.0.0 when last taken: no move back')
        await second.Dispose()
    }
    finally
    {
        f.Dispose()
    }
})

