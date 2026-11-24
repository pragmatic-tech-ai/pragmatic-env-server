import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { OidcFlowState } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { EnvServerRegistry } from '../../storage/env-server-registry.js'
import { IdentityRuntimeFactory } from '../../identity/identity-runtime-factory.js'
import { AuthMethod, Credential, PresentedSecret, AuthenticatedResult } from '@pragmatic-tech-ai/pragmatic-identity'
import { DeploymentMode } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { EnvironmentImportPendingError, EnvironmentRegistry, InMemoryEnvironmentProvisioning } from '../environment-registry.js'
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
    public static readonly KeyEnv = 'PS_CUSTOM2E_KEY'
    public static readonly TempPrefix = 'ps-custom2e-'

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

    public static async Run(session: ISqlSession): Promise<void>
    {
        const F = CustomTwoEnvironmentFixture
        process.env[F.KeyEnv] = Buffer.alloc(32, 8).toString('base64')
        const baseDir = mkdtempSync(join(tmpdir(), F.TempPrefix))
        const platform = CustomPlatformFixture.Over(session)
        const runtime = await IdentityRuntimeFactory.Build(platform)
        const registry = new EnvironmentRegistry(baseDir, { base64Env: F.KeyEnv }, F.Provisioning(), new InMemoryEnvironmentCoordinator(), platform, DeploymentMode.Local, undefined, undefined, runtime)
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
            // A record of one environment's registry is not the other's, under the same key.
            await one.Records<{ id: string; owner: string }>(EnvServerRegistry.DevGraphs).Put({ id: 'g', owner: F.EnvironmentOneId })
            assert.equal(await two.Records<{ id: string; owner: string }>(EnvServerRegistry.DevGraphs).Get('g'), undefined)
            assert.deepEqual(await two.Records(EnvServerRegistry.DevGraphs).List(), [])
            // A sign-in begun in one cannot be completed in the other (the flow states the servers are composed with).
            const flowOne = runtime.FlowStateFor(F.EnvironmentOneId)
            const flowTwo = runtime.FlowStateFor(F.EnvironmentTwoId)
            await flowOne.Put(new OidcFlowState('state-1', 'nonce', 'verifier', 'https://c1.example/callback', new Date(Date.now() + 600_000), null))
            assert.equal(await flowTwo.Take('state-1'), null)
            assert.equal((await flowOne.Take('state-1'))?.Nonce, 'nonce')
        }
        finally
        {
            await registry.DisposeAll()
            rmSync(baseDir, { recursive: true, force: true })
            delete process.env[F.KeyEnv]
        }
    }
}

SqlTestSessions.Describe('custom platform, two environments', (makeSession, label) =>
{
    describe(label, () =>
    {
        it('two custom-platform environments over one database stay isolated: secrets, sessions, grants, records and flow states of one never serve the other', async () =>
        {
            await CustomTwoEnvironmentFixture.Run(await makeSession())
        })

        it('an environment whose pre-A5 import has not finished is not opened; the others are', async () =>
        {
            const F = CustomTwoEnvironmentFixture
            process.env[F.KeyEnv] = Buffer.alloc(32, 8).toString('base64')
            const baseDir = mkdtempSync(join(tmpdir(), F.TempPrefix))
            // Environment c1 holds pre-A5 identity files and no completion record (its import failed at start).
            cpSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'storage', 'tests', 'fixtures', 'pre-a5', 'acme-dev', 'identity'), join(baseDir, F.EnvironmentOneId, 'identity'), { recursive: true })
            const registry = new EnvironmentRegistry(baseDir, { base64Env: F.KeyEnv }, F.Provisioning(), new InMemoryEnvironmentCoordinator(), CustomPlatformFixture.Over(await makeSession()), DeploymentMode.Local)
            try
            {
                await assert.rejects(registry.ServerFor(F.EnvironmentOneId), EnvironmentImportPendingError)
                assert.ok(await registry.ServerFor(F.EnvironmentTwoId))
            }
            finally
            {
                await registry.DisposeAll()
                rmSync(baseDir, { recursive: true, force: true })
                delete process.env[F.KeyEnv]
            }
        })
    })
})
