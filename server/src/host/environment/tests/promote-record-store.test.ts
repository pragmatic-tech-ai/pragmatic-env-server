import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import type { GraphLoadedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { EnvServerDatabase } from '../../../storage/env-server-database.js'
import { EnvServerRegistry } from '../../../storage/env-server-registry.js'
import { EnvironmentRecords } from '../../../storage/environment-records.js'
import { PromoteRecordStore, type PromoteRecord } from '../promote-record-store.js'

class PromoteFixture
{
    public static Store(database: EnvServerDatabase, environment: string = 'rt-1'): PromoteRecordStore
    {
        return new PromoteRecordStore(new EnvironmentRecords<PromoteRecord>(database, EnvServerRegistry.LoadedGraph, environment))
    }

    public static Loaded(version: string): GraphLoadedDto
    {
        return { name: 'hr-graph', packages: [{ id: 'hr', version }], promotedAt: '2026-11-23T00:00:00.000Z' }
    }
}

SqlTestSessions.Describe('PromoteRecordStore', (makeSession, label) =>
{
    describe(label, () =>
    {
        it('promote record replaces the previous one', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const store = PromoteFixture.Store(database)
            assert.equal(await store.Read(), null)
            await store.Save(PromoteFixture.Loaded('1.0.0'))
            await store.Save(PromoteFixture.Loaded('2.0.0'))
            assert.deepEqual(await PromoteFixture.Store(database).Read(), PromoteFixture.Loaded('2.0.0'), 'survives a restart, newest wins')
        })

        it('each environment has its own promote record', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            await PromoteFixture.Store(database, 'rt-a').Save(PromoteFixture.Loaded('1.0.0'))
            assert.equal(await PromoteFixture.Store(database, 'rt-b').Read(), null)
        })
    })
})
