import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { EnvServerDatabase } from '../../../storage/env-server-database.js'
import { EnvServerRegistry } from '../../../storage/env-server-registry.js'
import { EnvironmentRecords } from '../../../storage/environment-records.js'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { AppVersionConflictError, PragmaticAppsRegistry, type ApplicationRecord } from '../pragmatic-apps-registry.js'
import { ApplicationFiles } from '../application-files.js'
import type { PragmaticAppManifest } from '../pragmatic-app-manifest.js'

class AppsFixture
{
    public static readonly Environment = 'rt-1'

    public static Records(database: EnvServerDatabase, environment: string = AppsFixture.Environment): EnvironmentRecords<ApplicationRecord>
    {
        return new EnvironmentRecords<ApplicationRecord>(database, EnvServerRegistry.Applications, environment)
    }

    public static Registry(database: EnvServerDatabase, environment: string = AppsFixture.Environment): PragmaticAppsRegistry
    {
        return new PragmaticAppsRegistry(AppsFixture.Records(database, environment))
    }

    /** A registry over the handoff files in a fresh folder (the applications storage the unpacker writes). */
    public static WithFiles(database: EnvServerDatabase): { registry: PragmaticAppsRegistry; dir: string; files: ApplicationFiles }
    {
        const dir = mkdtempSync(join(tmpdir(), 'apps-files-'))
        const files = new ApplicationFiles(new NodeFsStorage(dir))
        return { registry: new PragmaticAppsRegistry(AppsFixture.Records(database), files), dir, files }
    }

    /** What the unpacker writes for name@version: the manifest, then the live pointer. */
    public static Unpack(dir: string, manifest: PragmaticAppManifest): void
    {
        mkdirSync(join(dir, manifest.name, manifest.version), { recursive: true })
        writeFileSync(join(dir, manifest.name, manifest.version, 'application.json'), JSON.stringify(manifest))
        writeFileSync(join(dir, manifest.name, 'live'), manifest.version)
    }

    public static Manifest(name: string, version: string): PragmaticAppManifest
    {
        return { name, version, packages: [{ id: 'acme.catalog', version: '1.0.0' }] }
    }
}

SqlTestSessions.Describe('PragmaticAppsRegistry', (makeSession, label) =>
{
    describe(label, () =>
    {
        it('Commit adds the version and moves live; List and ApplicationFor read the live manifest', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const registry = AppsFixture.Registry(database)
            await registry.Commit(AppsFixture.Manifest('demo', '1.0.0'))
            await registry.Commit(AppsFixture.Manifest('demo', '2.0.0'))
            await registry.Commit(AppsFixture.Manifest('other', '1.0.0'))
            assert.deepEqual(await registry.List(), [{ name: 'demo', version: '2.0.0' }, { name: 'other', version: '1.0.0' }])
            assert.equal((await registry.ApplicationFor('demo')).Manifest.version, '2.0.0')
            assert.equal(await registry.LiveVersion('demo'), '2.0.0')
            assert.deepEqual(await registry.ManifestOf('demo', '1.0.0'), AppsFixture.Manifest('demo', '1.0.0'), 'earlier versions are kept')
            assert.equal(await registry.ManifestOf('demo', '3.0.0'), undefined)
            assert.deepEqual((await AppsFixture.Registry(database).LiveApplications()).map(a => a.Manifest.name), ['demo', 'other'], 'survives a restart')
        })

        it('ApplicationFor rejects an unknown application and a traversal name', async () =>
        {
            const registry = AppsFixture.Registry(EnvServerDatabase.Over(await makeSession()))
            await assert.rejects(registry.ApplicationFor('missing'), /application not found/)
            await assert.rejects(registry.ApplicationFor('../x'), /invalid application name/)
            assert.equal(await registry.LiveApplicationFor('..'), undefined)
        })

        it('a record with no live version, a dangling pointer or a malformed manifest is not live, the others still list', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const records = AppsFixture.Records(database)
            await records.Put({ id: 'none', live: null, versions: { '1.0.0': AppsFixture.Manifest('none', '1.0.0') } })
            await records.Put({ id: 'dangling', live: '9.9.9', versions: {} })
            await records.Put({ id: 'corrupt', live: '1.0.0', versions: { '1.0.0': { name: '', version: '1.0.0' } as unknown as PragmaticAppManifest } })
            await records.Put({ id: 'unsafe', live: '../1', versions: { '../1': AppsFixture.Manifest('unsafe', '../1') } })
            const registry = AppsFixture.Registry(database)
            await registry.Commit(AppsFixture.Manifest('good', '1.0.0'))
            assert.deepEqual(await registry.List(), [{ name: 'good', version: '1.0.0' }])
            assert.equal(await registry.LiveApplicationFor('corrupt'), undefined)
        })

        it('Commit refuses a version already live and one committed with other content (re-checked inside the write)', async () =>
        {
            const registry = AppsFixture.Registry(EnvServerDatabase.Over(await makeSession()))
            await registry.Commit(AppsFixture.Manifest('demo', '1.0.0'))
            await assert.rejects(registry.Commit(AppsFixture.Manifest('demo', '1.0.0')), AppVersionConflictError)
            await registry.Commit(AppsFixture.Manifest('demo', '2.0.0'))
            await assert.rejects(registry.Commit({ ...AppsFixture.Manifest('demo', '1.0.0'), packages: [] }), AppVersionConflictError)
            await registry.Commit(AppsFixture.Manifest('demo', '1.0.0'))
            assert.equal(await registry.LiveVersion('demo'), '1.0.0', 'the same content, not live, moves the pointer back')
        })

        it('a claim holds the version for its digest: another digest is refused, the same one resumes, the commit clears it', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const registry = AppsFixture.Registry(database)
            const manifest = AppsFixture.Manifest('demo', '1.0.0')
            await registry.Claim(manifest, 'digest-a')
            await assert.rejects(registry.Claim(manifest, 'digest-b'), AppVersionConflictError)
            await registry.Claim(manifest, 'digest-a')
            await assert.rejects(registry.Commit(manifest, 'digest-b'), AppVersionConflictError)
            assert.equal(await registry.LiveVersion('demo'), undefined)
            await registry.Commit(manifest, 'digest-a')
            assert.equal((await AppsFixture.Records(database).Get('demo'))?.claims, undefined, 'the claim is gone')
            await assert.rejects(registry.Claim(AppsFixture.Manifest('demo', '1.0.0'), 'digest-a'), AppVersionConflictError, 'a committed version cannot be claimed')
        })

        it('ReleaseClaim drops only its own digest\'s claim', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const registry = AppsFixture.Registry(database)
            const manifest = AppsFixture.Manifest('demo', '1.0.0')
            await registry.Claim(manifest, 'digest-a')
            await registry.ReleaseClaim(manifest, 'digest-b')
            await assert.rejects(registry.Claim(manifest, 'digest-b'), AppVersionConflictError)
            await registry.ReleaseClaim(manifest, 'digest-a')
            await registry.Claim(manifest, 'digest-b')
        })

        it('TakeUnpacked commits the version the unpacker made live, once; a later deploy is not moved back', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const { registry, dir } = AppsFixture.WithFiles(database)
            await registry.Commit(AppsFixture.Manifest('demo', '1.0.0'))
            AppsFixture.Unpack(dir, AppsFixture.Manifest('demo', '2.0.0'))
            assert.deepEqual(await registry.TakeUnpacked(), { Taken: ['demo'], Refused: [] })
            assert.equal(await registry.LiveVersion('demo'), '2.0.0')
            assert.deepEqual(await registry.TakeUnpacked(), { Taken: [], Refused: [] }, 'taken once')
            // A deploy without the mirror reaching the files (a registry without them): the files still name 2.0.0.
            await AppsFixture.Registry(database).Commit(AppsFixture.Manifest('demo', '3.0.0'))
            assert.deepEqual(await registry.TakeUnpacked(), { Taken: [], Refused: [] })
            assert.equal(await registry.LiveVersion('demo'), '3.0.0')
        })

        it('TakeUnpacked refuses a version committed with other content and leaves the live one', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const { registry, dir } = AppsFixture.WithFiles(database)
            await AppsFixture.Registry(database).Commit(AppsFixture.Manifest('demo', '2.0.0'))
            await AppsFixture.Registry(database).Commit(AppsFixture.Manifest('demo', '3.0.0'))
            AppsFixture.Unpack(dir, { ...AppsFixture.Manifest('demo', '2.0.0'), packages: [] })
            assert.deepEqual(await registry.TakeUnpacked(), { Taken: [], Refused: ['demo'] })
            assert.equal(await registry.LiveVersion('demo'), '3.0.0')
            assert.deepEqual((await registry.ManifestOf('demo', '2.0.0'))?.packages, AppsFixture.Manifest('demo', '2.0.0').packages)
        })

        it('TakeUnpacked passes over invalid names, a pointer without a manifest and a manifest of another app', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const { registry, dir } = AppsFixture.WithFiles(database)
            mkdirSync(join(dir, 'nomanifest'), { recursive: true })
            writeFileSync(join(dir, 'nomanifest', 'live'), '1.0.0')
            AppsFixture.Unpack(dir, AppsFixture.Manifest('other', '1.0.0'))
            mkdirSync(join(dir, 'wrong', '1.0.0'), { recursive: true })
            writeFileSync(join(dir, 'wrong', '1.0.0', 'application.json'), JSON.stringify(AppsFixture.Manifest('other', '1.0.0')))
            writeFileSync(join(dir, 'wrong', 'live'), '1.0.0')
            mkdirSync(join(dir, '.hidden'), { recursive: true })
            assert.deepEqual(await registry.TakeUnpacked(), { Taken: ['other'], Refused: [] })
            assert.deepEqual((await registry.List()).map(a => a.name), ['other'])
        })

        it('Commit mirrors the live manifest to the handoff files, so the unpacker reads what is live', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const { registry, dir, files } = AppsFixture.WithFiles(database)
            await registry.Commit(AppsFixture.Manifest('demo', '1.0.0'))
            assert.equal(readFileSync(join(dir, 'demo', 'live'), 'utf8'), '1.0.0')
            assert.deepEqual((await files.Live('demo'))?.manifest, AppsFixture.Manifest('demo', '1.0.0'))
            assert.equal((await AppsFixture.Records(database).Get('demo'))?.unpacked, '1.0.0')
            assert.deepEqual(await registry.TakeUnpacked(), { Taken: [], Refused: [] }, 'its own mirror is not taken again')
        })

        it('two environments keep their own applications', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            await AppsFixture.Registry(database, 'rt-a').Commit(AppsFixture.Manifest('demo', '1.0.0'))
            assert.deepEqual(await AppsFixture.Registry(database, 'rt-b').List(), [])
            assert.equal(await AppsFixture.Registry(database, 'rt-b').LiveApplicationFor('demo'), undefined)
        })
    })
})
