import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { NodeStorageProviderRegistry } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { IdentityConfig, DelegationDepth, Realm, RealmKind, Role, Grant, ResourceRef, ResourceKind, Principal, PrincipalKind } from '@pragmatic-tech-ai/pragmatic-identity'
import { EnvServerDatabase } from '../../storage/env-server-database.js'
import { CustomPlatform } from '../custom-platform.js'
import { EnvServerTestDatabase } from '../../storage/tests/env-server-test-database.js'

class CustomFixture
{
    public static readonly Key = Buffer.alloc(32, 9)

    public static TempDir(): string
    {
        return mkdtempSync(join(tmpdir(), 'custom-platform-'))
    }

    public static KeyFile(dir: string, bytes: number): string
    {
        const path = join(dir, 'master.key')
        writeFileSync(path, Buffer.alloc(bytes, 3))
        return path
    }
}

SqlTestSessions.Describe('CustomPlatform', (makeSession, label) =>
{
    describe(label, () =>
    {
        it('custom platform stores accounts, sessions, grants, service tokens, secrets and realm config in SQL', async () =>
        {
            const session = await makeSession()
            const platform = new CustomPlatform(EnvServerDatabase.Over(session), new NodeStorageProviderRegistry())
            const realm = new Realm('env-1', RealmKind.SelfHosted, 'Env 1')
            const stores = await platform.CreateIdentityStores(realm.Id, CustomFixture.Key)
            await stores.Accounts.CreateAccount(realm, 'ann@x.io', 'ann', 'ann-pw')
            await stores.Grants.Save(new Grant('ann', Role.Owner, new ResourceRef(ResourceKind.Realm, realm.Id, [])))
            const config = new IdentityConfig('local', DelegationDepth.FullAuthz, new Map([['s', 'v']]), new Map([['g', Role.Editor]]), new Map())
            await (await platform.CreateRealmConfigStore(realm.Id)).Save(realm.Id, config)
            await stores.Secrets.Put('ann-pw', 'hash')
            const issued = await stores.Sessions.Issue(new Principal('ann', realm.Id, PrincipalKind.User, new Map(), []))
            await stores.Tokens.Issue(realm, 'ci-bot', ['deploy'], null)
            // A second platform over the same database (a restart, another worker) reads everything back.
            const again = new CustomPlatform(EnvServerDatabase.Over(session), new NodeStorageProviderRegistry())
            const reread = await again.CreateIdentityStores(realm.Id, CustomFixture.Key)
            assert.equal((await reread.Accounts.FindByEmail(realm, 'ann@x.io'))?.PrincipalId, 'ann')
            assert.equal((await reread.Grants.GrantsFor('ann', realm)).length, 1)
            assert.equal(await reread.Secrets.Get('ann-pw'), 'hash')
            assert.equal((await reread.Sessions.Validate(issued.Id))?.PrincipalId, 'ann')
            assert.deepEqual((await reread.Tokens.List(realm)).map(t => t.PrincipalId), ['ci-bot'])
            const got = await (await again.CreateRealmConfigStore(realm.Id)).Get(realm.Id)
            assert.equal(got?.GroupRoleMap.get('g'), Role.Editor)
        })

        it('shares one SQL store set between environments and isolates their secrets', async () =>
        {
            const platform = new CustomPlatform(EnvServerDatabase.Over(await makeSession()), new NodeStorageProviderRegistry())
            const [a, b] = await Promise.all([platform.CreateIdentityStores('env-a', CustomFixture.Key), platform.CreateIdentityStores('env-b', CustomFixture.Key)])
            assert.equal(a.Accounts, b.Accounts)
            await a.Secrets.Put('ref', 'only-a')
            assert.equal(await b.Secrets.Get('ref'), null)
            assert.notEqual(await platform.AuditSink(), a.Audit, 'the access audit is not the hash-chained identity audit')
        })
    })
})

describe('CustomPlatform master key and storage', () =>
{
    it('ResolveMasterKey reads a 32-byte key by reference and rejects another length', () =>
    {
        const platform = new CustomPlatform(EnvServerTestDatabase.Mem(), new NodeStorageProviderRegistry())
        const dir = CustomFixture.TempDir()
        assert.equal(platform.ResolveMasterKey({ keyFilePath: CustomFixture.KeyFile(dir, 32) }).length, 32)
        assert.throws(() => platform.ResolveMasterKey({ keyFilePath: CustomFixture.KeyFile(CustomFixture.TempDir(), 16) }))
    })

    it('storage from the registry reads back what it writes', async () =>
    {
        const platform = new CustomPlatform(EnvServerTestDatabase.Mem(), new NodeStorageProviderRegistry())
        const storage = platform.CreateStorage(CustomFixture.TempDir())
        await storage.WriteText('a.txt', 'hello')
        assert.equal(await storage.ReadText('a.txt'), 'hello')
    })
})
