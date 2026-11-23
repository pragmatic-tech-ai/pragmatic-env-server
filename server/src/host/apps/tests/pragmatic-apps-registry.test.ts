import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { EnvServerDatabase } from '../../../storage/env-server-database.js'
import { EnvServerRegistry } from '../../../storage/env-server-registry.js'
import { EnvironmentRecords } from '../../../storage/environment-records.js'
import { PragmaticAppsRegistry, type ApplicationRecord } from '../pragmatic-apps-registry.js'
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

        it('two environments keep their own applications', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            await AppsFixture.Registry(database, 'rt-a').Commit(AppsFixture.Manifest('demo', '1.0.0'))
            assert.deepEqual(await AppsFixture.Registry(database, 'rt-b').List(), [])
            assert.equal(await AppsFixture.Registry(database, 'rt-b').LiveApplicationFor('demo'), undefined)
        })
    })
})
