import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { IdentityConfig, DelegationDepth, Realm, RealmKind, Role, Grant, ResourceRef, ResourceKind, Principal, PrincipalKind } from '@pragmatic-tech-ai/pragmatic-identity'
import { EnvServerDatabase } from '../../storage/env-server-database.js'
import { SqlIdentityStoreSet } from '../sql-identity-store-set.js'

class StoreSetFixture
{
    public static readonly Key = Buffer.alloc(32, 4)

    public static Realm(id: string): Realm
    {
        return new Realm(id, RealmKind.SelfHosted, id)
    }
}

SqlTestSessions.Describe('SqlIdentityStoreSet', (makeSession, label) =>
{
    describe(label, () =>
    {
        it('two environments over one database see only their own accounts and grants', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const set = await SqlIdentityStoreSet.Open(database.Session)
            const a = set.For('env-a', await database.Secrets('env-a', StoreSetFixture.Key))
            const b = set.For('env-b', await database.Secrets('env-b', StoreSetFixture.Key))
            const ra = StoreSetFixture.Realm('env-a')
            const rb = StoreSetFixture.Realm('env-b')
            await a.Accounts.CreateAccount(ra, 'ann@a.io', 'ann', 'ann-pw')
            await a.Grants.Save(new Grant('ann', Role.Owner, new ResourceRef(ResourceKind.Realm, ra.Id, [])))
            assert.equal((await a.Accounts.FindByEmail(ra, 'ann@a.io'))?.PrincipalId, 'ann')
            assert.equal(await b.Accounts.FindByEmail(rb, 'ann@a.io'), null)
            // The same subject in both environments: each sees only the grants on its own resources.
            await b.Grants.Save(new Grant('ann', Role.Viewer, new ResourceRef(ResourceKind.Realm, rb.Id, [])))
            assert.deepEqual((await a.Grants.GrantsFor('ann', ra)).map(g => [g.Role, g.Resource.RealmId]), [[Role.Owner, ra.Id]])
            assert.deepEqual((await b.Grants.GrantsFor('ann', rb)).map(g => [g.Role, g.Resource.RealmId]), [[Role.Viewer, rb.Id]])
            assert.deepEqual(await b.Grants.GrantsOn(new ResourceRef(ResourceKind.Realm, ra.Id, [])), [])
            await a.Secrets.Put('ann-pw', 'hash-a')
            assert.equal(await b.Secrets.Get('ann-pw'), null)
        })

        it('a session issued in one environment does not validate in another, even for the same principal id', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const set = await SqlIdentityStoreSet.Open(database.Session)
            const a = set.For('env-a', await database.Secrets('env-a', StoreSetFixture.Key))
            const b = set.For('env-b', await database.Secrets('env-b', StoreSetFixture.Key))
            const issued = await a.Sessions.Issue(new Principal('dev', 'env-a', PrincipalKind.User, new Map(), []))
            assert.equal((await a.Sessions.Validate(issued.Id))?.PrincipalId, 'dev')
            assert.equal(await b.Sessions.Validate(issued.Id), null)
        })

        it('keeps one realm configuration per environment', async () =>
        {
            const set = await SqlIdentityStoreSet.Open(await makeSession())
            const config = new IdentityConfig('local', DelegationDepth.FullAuthz, new Map([['s', 'v']]), new Map(), new Map())
            await set.RealmConfig().Save('env-a', config)
            assert.equal((await set.RealmConfig().Get('env-a'))?.PackId, 'local')
            assert.equal(await set.RealmConfig().Get('env-b'), null)
        })
    })
})
