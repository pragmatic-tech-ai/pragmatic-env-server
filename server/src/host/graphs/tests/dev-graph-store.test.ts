import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { EnvServerDatabase } from '../../../storage/env-server-database.js'
import { EnvServerRegistry } from '../../../storage/env-server-registry.js'
import { EnvironmentRecords } from '../../../storage/environment-records.js'
import { DevGraphStore, type DevGraphRecord, type DevGraphRow } from '../dev-graph-store.js'

class Fixture
{
    public static readonly Environment = 'dev-1'

    public static Record(name: string, description: string): DevGraphRecord
    {
        return { name, description, slices: {}, createdAt: '2026-10-20T00:00:00.000Z' }
    }

    public static Rows(database: EnvServerDatabase, environment: string = Fixture.Environment): EnvironmentRecords<DevGraphRow>
    {
        return new EnvironmentRecords<DevGraphRow>(database, EnvServerRegistry.DevGraphs, environment)
    }

    public static async Reload(database: EnvServerDatabase, environment: string = Fixture.Environment): Promise<DevGraphStore>
    {
        const store = new DevGraphStore(Fixture.Rows(database, environment))
        await store.Load()
        return store
    }
}

SqlTestSessions.Describe('DevGraphStore', (makeSession, label) =>
{
    describe(label, () =>
    {
        it('a graph with no slices round-trips through Put/Load', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const store = await Fixture.Reload(database)
            await store.Put(Fixture.Record('g', 'd'))
            const got = (await Fixture.Reload(database)).Get('g')
            assert.equal(got?.description, 'd')
            assert.deepEqual(got?.slices, {})
        })

        it('Load on an empty database yields an empty list', async () =>
        {
            const store = await Fixture.Reload(EnvServerDatabase.Over(await makeSession()))
            assert.deepEqual(store.List(), [])
        })

        it('Remove deletes a graph; it is gone after reload', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const store = await Fixture.Reload(database)
            await store.Put(Fixture.Record('a', 'x'))
            await store.Put(Fixture.Record('b', 'y'))
            await store.Remove('a')
            assert.deepEqual((await Fixture.Reload(database)).List().map(r => r.name), ['b'])
        })

        it('mutating a returned record does not change stored state', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const store = await Fixture.Reload(database)
            await store.Put({ ...Fixture.Record('g', 'd'), slices: { s1: [{ id: 'a', version: '1' }] } })
            const got = store.Get('g')
            got?.slices.s1.push({ id: 'x', version: '1' })
            assert.equal(store.Get('g')?.slices.s1.length, 1)
            assert.equal((await Fixture.Reload(database)).Get('g')?.slices.s1.length, 1)
        })

        it('a record with two slices persists and reloads intact', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const record: DevGraphRecord = { ...Fixture.Record('g', 'd'), slices: { s1: [{ id: 'a', version: '1' }], s2: [{ id: 'b', version: '2' }, { id: 'c', version: '3' }] } }
            await (await Fixture.Reload(database)).Put(record)
            assert.deepEqual((await Fixture.Reload(database)).Get('g'), record)
        })

        it('an empty slice round-trips as an empty array', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            await (await Fixture.Reload(database)).Put({ ...Fixture.Record('g', 'd'), slices: { s1: [] } })
            assert.deepEqual((await Fixture.Reload(database)).Get('g')?.slices, { s1: [] })
        })

        it('a row without slices yields empty slices and ignores legacy packages', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            await Fixture.Rows(database).Put({ id: 'g', graph: { name: 'g', description: 'd', createdAt: 't', packages: [{ id: 'a', version: '1' }] } as unknown as DevGraphRecord })
            assert.deepEqual((await Fixture.Reload(database)).Get('g'), { name: 'g', description: 'd', slices: {}, createdAt: 't' })
        })

        it('two environments keep separate graphs', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            await (await Fixture.Reload(database, 'dev-a')).Put(Fixture.Record('g', 'from a'))
            assert.deepEqual((await Fixture.Reload(database, 'dev-b')).List(), [])
            assert.equal((await Fixture.Reload(database, 'dev-a')).Get('g')?.description, 'from a')
        })
    })
})
