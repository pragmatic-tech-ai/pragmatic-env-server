import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AuthMethod, Credential, PresentedSecret, AuthenticatedResult } from '@pragmatic-tech-ai/pragmatic-identity'
import { DeploymentMode } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { EnvironmentRegistry, InMemoryEnvironmentProvisioning } from '../environment-registry.js'
import { InMemoryEnvironmentCoordinator } from '../environment-coordinator.js'
import { CustomPlatformFixture } from '../../platform/tests/custom-platform-fixture.js'
import type { PragmaticServer } from '../../pragmatic-server.js'
import type { EnvironmentProvisioning } from '../environment-provisioning.js'

/** Two custom-platform environments over one database whose admins share the principal id, email and password ref (Review Focus 1). */
class CustomTwoEnvironmentFixture
{
    public static readonly EnvironmentOneId = 'c1'
    public static readonly EnvironmentTwoId = 'c2'
    public static readonly AdminId = 'admin'
    public static readonly AdminEmail = 'admin@x.io'
    public static readonly AdminRef = 'bootstrap/admin'
    public static readonly PasswordOne = 'pw-c1-123456'
    public static readonly PasswordTwo = 'pw-c2-123456'
    private static readonly KeyEnv = 'PS_CUSTOM2E_KEY'
    private static readonly TempPrefix = 'ps-custom2e-'

    public static Provisioning(): InMemoryEnvironmentProvisioning
    {
        const F = CustomTwoEnvironmentFixture
        const bootstrap = { adminEmail: F.AdminEmail, adminPrincipalId: F.AdminId, adminPasswordRef: F.AdminRef, ownerGrant: true }
        return new InMemoryEnvironmentProvisioning(new Map<string, EnvironmentProvisioning>([
            [F.EnvironmentOneId, { displayName: 'One', bootstrap }],
            [F.EnvironmentTwoId, { displayName: 'Two', bootstrap }],
        ]))
    }

    public static async SeedAndAuth(server: PragmaticServer, password: string): Promise<unknown>
    {
        const pack = await server.Pack()
        await pack.Secrets.Put(CustomTwoEnvironmentFixture.AdminRef, password)
        await server.SeedBootstrapForTest()
        return pack.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, CustomTwoEnvironmentFixture.AdminEmail), new PresentedSecret(password), server.Realm())
    }

    public static async Run(): Promise<void>
    {
        const F = CustomTwoEnvironmentFixture
        process.env[F.KeyEnv] = Buffer.alloc(32, 8).toString('base64')
        const baseDir = mkdtempSync(join(tmpdir(), F.TempPrefix))
        const registry = new EnvironmentRegistry(baseDir, { base64Env: F.KeyEnv }, F.Provisioning(), new InMemoryEnvironmentCoordinator(), CustomPlatformFixture.Mem(), DeploymentMode.Local)
        try
        {
            const one = await registry.ServerFor(F.EnvironmentOneId)
            const two = await registry.ServerFor(F.EnvironmentTwoId)
            assert.ok(await F.SeedAndAuth(one, F.PasswordOne) instanceof AuthenticatedResult)
            assert.ok(await F.SeedAndAuth(two, F.PasswordTwo) instanceof AuthenticatedResult)
            const packOne = await one.Pack()
            const packTwo = await two.Pack()
            // Environment two's password does not sign in to environment one (secrets are per environment).
            assert.ok(!(await packOne.AuthenticatorFor(AuthMethod.Local)!.Authenticate(new Credential(AuthMethod.Local, F.AdminEmail), new PresentedSecret(F.PasswordTwo), one.Realm()) instanceof AuthenticatedResult))
            assert.equal(await packOne.Secrets.Get(F.AdminRef), F.PasswordOne)
            assert.equal(await packTwo.Secrets.Get(F.AdminRef), F.PasswordTwo)
            // A session issued in one does not validate in two, though the principal id is the same.
            const principal = await packOne.Directory.Lookup(F.AdminId, one.Realm())
            assert.ok(principal !== null)
            const session = await packOne.Sessions.Issue(principal)
            assert.equal((await packOne.Sessions.Validate(session.Id))?.RealmId, F.EnvironmentOneId)
            assert.equal(await packTwo.Sessions.Validate(session.Id), null)
            // Each environment sees only the owner grant on its own realm.
            assert.deepEqual((await packOne.Grants.GrantsFor(F.AdminId, one.Realm())).map(g => g.Resource.RealmId), [F.EnvironmentOneId])
            assert.deepEqual((await packTwo.Grants.GrantsFor(F.AdminId, two.Realm())).map(g => g.Resource.RealmId), [F.EnvironmentTwoId])
        }
        finally
        {
            await registry.DisposeAll()
            rmSync(baseDir, { recursive: true, force: true })
            delete process.env[F.KeyEnv]
        }
    }
}

test('two custom-platform environments over one database stay isolated: secrets, sessions and grants of one never serve the other', async () =>
{
    await CustomTwoEnvironmentFixture.Run()
})
