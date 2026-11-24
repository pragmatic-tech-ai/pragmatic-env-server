import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OidcFlowState } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { PgSession, SqlOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { EnvironmentFlowStateStore } from '../environment-flow-state-store.js'
import { EnvironmentIdInvalidError } from '../../storage/environment-records.js'

class FlowFixture
{
    public static State(key: string, returnPath: string | null = null): OidcFlowState
    {
        return new OidcFlowState(key, 'nonce-' + key, 'verifier-' + key, 'https://env.example/callback', new Date(Date.now() + 600_000), returnPath)
    }
}

SqlTestSessions.Describe('EnvironmentFlowStateStore', (makeSession, label) =>
{
    describe(label, () =>
    {
        it('a state put by environment A is not taken by environment B', async () =>
        {
            const inner = await SqlOidcFlowStateStore.Open(await makeSession())
            const a = new EnvironmentFlowStateStore(inner, 'env-a')
            const b = new EnvironmentFlowStateStore(inner, 'env-b')
            await a.Put(FlowFixture.State('s1'))
            assert.equal(await b.Take('s1'), null)
            const taken = await a.Take('s1')
            assert.equal(taken?.State, 's1', 'the key comes back without the environment prefix')
            assert.equal(taken?.Nonce, 'nonce-s1')
        })

        it('refuses an environment id that is empty or holds a / (environment a with state b/s would be environment a/b with state s)', async () =>
        {
            const inner = await SqlOidcFlowStateStore.Open(await makeSession())
            assert.throws(() => new EnvironmentFlowStateStore(inner, 'a/b'), EnvironmentIdInvalidError)
            assert.throws(() => new EnvironmentFlowStateStore(inner, ''), EnvironmentIdInvalidError)
        })

        it('a state is taken once and keeps its return path', async () =>
        {
            const store = new EnvironmentFlowStateStore(await SqlOidcFlowStateStore.Open(await makeSession()), 'env-a')
            await store.Put(FlowFixture.State('s2', '/apps/demo/'))
            assert.equal((await store.Take('s2'))?.ReturnPath, '/apps/demo/')
            assert.equal(await store.Take('s2'), null)
        })
    })
})

SqlTestSessions.DescribeLive('EnvironmentFlowStateStore', makeDatabase =>
{
    it('a flow begun through one store instance is taken through another over the same database [live]', async () =>
    {
        const live = await makeDatabase()
        try
        {
            // Two workers: each opens its own store over its own session to the one database.
            const begun = new EnvironmentFlowStateStore(await SqlOidcFlowStateStore.Open(live.Session()), 'env-a')
            const completed = new EnvironmentFlowStateStore(await SqlOidcFlowStateStore.Open(live.Session()), 'env-a')
            await begun.Put(FlowFixture.State('s3'))
            assert.equal((await completed.Take('s3'))?.CodeVerifier, 'verifier-s3')
            assert.equal(await begun.Take('s3'), null)
        }
        finally
        {
            await live.Dispose()
        }
    })
})

describe('EnvironmentFlowStateStore over one pg-mem database', () =>
{
    it('a flow begun through one store instance is taken through another over the same database', async () =>
    {
        const session = new PgSession(SqlTestSessions.MemPool())
        const begun = new EnvironmentFlowStateStore(await SqlOidcFlowStateStore.Open(session), 'env-a')
        const completed = new EnvironmentFlowStateStore(await SqlOidcFlowStateStore.Open(session), 'env-a')
        await begun.Put(FlowFixture.State('s4'))
        assert.equal((await completed.Take('s4'))?.State, 's4')
    })
})
