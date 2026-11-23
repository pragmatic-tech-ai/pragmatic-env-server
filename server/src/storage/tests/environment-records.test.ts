import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { EnvServerDatabase } from '../env-server-database.js'
import { EnvServerRegistry } from '../env-server-registry.js'
import { EnvironmentRecords, EnvironmentRecordKeyChangedError } from '../environment-records.js'

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
