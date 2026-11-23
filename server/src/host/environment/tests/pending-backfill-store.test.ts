import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { EnvServerDatabase } from '../../../storage/env-server-database.js'
import { EnvServerRegistry } from '../../../storage/env-server-registry.js'
import { EnvironmentRecords } from '../../../storage/environment-records.js'
import { PendingBackfillStore, type IPendingBackfillDiagnostics, type PendingBackfillRecord } from '../pending-backfill-store.js'

class BackfillFixture
{
    public static readonly Environment = 'rt-1'

    public static Records(database: EnvServerDatabase, environment: string = BackfillFixture.Environment): EnvironmentRecords<PendingBackfillRecord>
    {
        return new EnvironmentRecords<PendingBackfillRecord>(database, EnvServerRegistry.PendingBackfill, environment)
    }
}

class RecordingBackfillDiagnostics implements IPendingBackfillDiagnostics
{
    public readonly Errors: unknown[] = []

    public Unreadable(error: unknown): void
    {
        this.Errors.push(error)
    }
}

SqlTestSessions.Describe('PendingBackfillStore', (makeSession, label) =>
{
    describe(label, () =>
    {
        it('pending backfill keeps a sorted unique list', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const store = new PendingBackfillStore(BackfillFixture.Records(database))
            assert.deepEqual(await store.List(), [])
            await store.Add(['hr.Employee', 'crm.Account'])
            await store.Add(['crm.Account', 'ops.Ticket'])
            assert.deepEqual(await store.List(), ['crm.Account', 'hr.Employee', 'ops.Ticket'])
            await store.Remove(['hr.Employee', 'missing.Concept'])
            assert.deepEqual(await store.List(), ['crm.Account', 'ops.Ticket'])
            await store.Retain(new Set(['ops.Ticket']))
            assert.deepEqual(await new PendingBackfillStore(BackfillFixture.Records(database)).List(), ['ops.Ticket'], 'survives a restart')
        })

        it('two environments owe their own concepts', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            await new PendingBackfillStore(BackfillFixture.Records(database, 'rt-a')).Add(['hr.Employee'])
            assert.deepEqual(await new PendingBackfillStore(BackfillFixture.Records(database, 'rt-b')).List(), [])
        })

        it('a malformed record lists as empty, is reported, and the next write replaces it', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            await BackfillFixture.Records(database).Put({ id: PendingBackfillStore.RecordKey, concepts: [1, 2] } as unknown as PendingBackfillRecord)
            const diagnostics = new RecordingBackfillDiagnostics()
            const store = new PendingBackfillStore(BackfillFixture.Records(database), diagnostics)
            assert.deepEqual(await store.List(), [])
            assert.ok(diagnostics.Errors.length >= 1)
            await store.Add(['hr.Employee'])
            assert.deepEqual(await store.List(), ['hr.Employee'])
        })

        it('a database read error propagates (a list that could not be read is never overwritten)', async () =>
        {
            const failing = { Get: () => Promise.reject(new Error('database down')), Update: () => assert.fail('must not write') } as unknown as EnvironmentRecords<PendingBackfillRecord>
            await assert.rejects(new PendingBackfillStore(failing).Add(['hr.Employee']), /database down/)
        })
    })
})

SqlTestSessions.DescribeLive('PendingBackfillStore', makeDatabase =>
{
    it('concurrent adds from several workers all land [live]', async () =>
    {
        const live = await makeDatabase()
        try
        {
            const stores = Array.from({ length: 6 }, () => new PendingBackfillStore(BackfillFixture.Records(EnvServerDatabase.Over(live.Session()))))
            await Promise.all(stores.map((store, i) => store.Add(['c.' + i])))
            assert.deepEqual(await stores[0]!.List(), ['c.0', 'c.1', 'c.2', 'c.3', 'c.4', 'c.5'])
        }
        finally
        {
            await live.Dispose()
        }
    })
})
