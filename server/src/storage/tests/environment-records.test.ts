import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { EnvServerDatabase } from '../env-server-database.js'
import { EnvServerRegistry } from '../env-server-registry.js'
import { EnvironmentIdInvalidError, EnvironmentRecords, EnvironmentRecordKeyChangedError } from '../environment-records.js'

type Note = { id: string; text: string }

SqlTestSessions.Describe('EnvironmentRecords', (makeSession, label) =>
{
    describe(label, () =>
    {
        it('records of two environments in one registry never mix', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const a = await EnvironmentRecords.Open<Note>(database, EnvServerRegistry.DevGraphs, 'env-a')
            const b = await EnvironmentRecords.Open<Note>(database, EnvServerRegistry.DevGraphs, 'env-b')
            await a.Put({ id: 'g', text: 'from a' })
            await b.Put({ id: 'g', text: 'from b' })
            await a.Put({ id: 'h', text: 'only a' })
            assert.deepEqual(await a.Get('g'), { id: 'g', text: 'from a' })
            assert.deepEqual(await b.Get('g'), { id: 'g', text: 'from b' })
            assert.equal(await b.Get('h'), undefined)
            assert.deepEqual((await a.List()).map(n => n.id), ['g', 'h'])
            assert.deepEqual(await b.List(), [{ id: 'g', text: 'from b' }])
            assert.equal(await b.Delete('h'), false)
            assert.equal(await a.Delete('h'), true)
            assert.deepEqual((await a.List()).map(n => n.id), ['g'])
        })

        it('an environment whose id prefixes another one sees only its own records', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const short = new EnvironmentRecords<Note>(database, EnvServerRegistry.Applications, 'acme')
            const long = new EnvironmentRecords<Note>(database, EnvServerRegistry.Applications, 'acme-dev')
            await long.Put({ id: 'x', text: 'long' })
            assert.deepEqual(await short.List(), [])
            assert.equal(await short.Get('x'), undefined)
        })

        it('List reads only its own prefix from the database (ListPrefix), never the rows of every environment', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const records = await EnvironmentRecords.Open<Note>(database, EnvServerRegistry.DevGraphs, 'env-a')
            await new EnvironmentRecords<Note>(database, EnvServerRegistry.DevGraphs, 'env-b').Put({ id: 'g', text: 'b' })
            await records.Put({ id: 'g', text: 'a' })
            const store = await database.Records<Note>(EnvServerRegistry.DevGraphs)
            const prefixes: string[] = []
            const listPrefix = store.ListPrefix.bind(store)
            store.ListPrefix = async (prefix: string) =>
            {
                prefixes.push(prefix)
                return listPrefix(prefix)
            }
            store.List = async () => assert.fail('List must not read the rows of every environment')
            assert.deepEqual(await records.List(), [{ id: 'g', text: 'a' }])
            assert.deepEqual(prefixes, ['env-a/'])
        })

        it('refuses an environment id that is empty or holds a / (it would read the keys of another environment)', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            assert.throws(() => new EnvironmentRecords<Note>(database, EnvServerRegistry.DevGraphs, 'a/b'), EnvironmentIdInvalidError)
            assert.throws(() => new EnvironmentRecords<Note>(database, EnvServerRegistry.DevGraphs, ''), EnvironmentIdInvalidError)
            await assert.rejects(EnvironmentRecords.Open<Note>(database, EnvServerRegistry.DevGraphs, 'a/b'), EnvironmentIdInvalidError)
        })

        it('Update reads, writes and deletes under the environment key and keeps the key', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const records = new EnvironmentRecords<Note>(database, EnvServerRegistry.SecurityChanges, 'env-a')
            assert.deepEqual(await records.Update('n', current => ({ id: 'n', text: (current?.text ?? '') + '1' })), { id: 'n', text: '1' })
            assert.deepEqual(await records.Update('n', current => ({ id: 'n', text: (current?.text ?? '') + '2' })), { id: 'n', text: '12' })
            await assert.rejects(records.Update('n', () => ({ id: 'other', text: 'x' })), EnvironmentRecordKeyChangedError)
            assert.equal(await records.Update('n', () => undefined), undefined)
            assert.equal(await records.Get('n'), undefined)
        })
    })
})
