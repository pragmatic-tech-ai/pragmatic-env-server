import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Realm, RealmKind } from '@pragmatic-tech-ai/pragmatic-identity'
import { ObjectStoreProviderRegistry, SqlSecretKeyRing, SqlSecretStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { FileAuditSink } from '@pragmatic-tech-ai/pragmatic-identity-store'
import { EnvServerDatabase } from '../env-server-database.js'
import { EnvServerImport, EnvServerImportRefusedError, type EnvironmentImport } from '../env-server-import.js'
import { SqlIdentityStoreSet } from '../../platform/sql-identity-store-set.js'
import { PragmaticAppsRegistry, type ApplicationRecord } from '../../host/apps/pragmatic-apps-registry.js'
import { DevGraphStore, type DevGraphRow } from '../../host/graphs/dev-graph-store.js'
import { SecurityChangeLog, type SecurityChangeLogRecord } from '../../host/environment/security-change-log.js'
import { PendingBackfillStore, type PendingBackfillRecord } from '../../host/environment/pending-backfill-store.js'
import { PromoteRecordStore, type PromoteRecord } from '../../host/environment/promote-record-store.js'
import { EnvServerRegistry } from '../env-server-registry.js'
import { EnvironmentRecords } from '../environment-records.js'

class ImportFixture
{
    public static readonly Golden = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pre-a5')
    /** The key the fixture's secrets were sealed with (fixtures only). */
    public static readonly Key = Buffer.alloc(32, 42)
    public static readonly Dev = 'acme-dev'
    public static readonly Runtime = 'acme-rt'

    /** A private copy of the golden layout as a base folder. */
    public static BaseDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), 'env-import-'))
        cpSync(ImportFixture.Golden, dir, { recursive: true })
        return dir
    }

    public static Realm(id: string): Realm
    {
        return new Realm(id, RealmKind.SelfHosted, id)
    }

    /** Every file under `dir` with its sha256, by relative path. */
    public static Digests(dir: string): Map<string, string>
    {
        const digests = new Map<string, string>()
        const walk = (folder: string): void =>
        {
            for (const entry of readdirSync(folder))
            {
                const path = join(folder, entry)
                if (statSync(path).isDirectory())
                {
                    walk(path)
                }
                else
                {
                    digests.set(relative(dir, path), createHash('sha256').update(readFileSync(path)).digest('hex'))
                }
            }
        }
        walk(dir)
        return digests
    }

    public static async AuditRows(database: EnvServerDatabase, environmentId: string): Promise<number>
    {
        return (await database.Session.Query('SELECT seq FROM identity_audit WHERE realm_id = $1', [environmentId])).length
    }
}

/** Fails the pending backfill step of the first environment it reaches, once. */
class FailingOnceImport extends EnvServerImport
{
    public Failed = false

    protected override async ImportPendingBackfill(run: EnvironmentImport, folder: string): Promise<void>
    {
        if (!this.Failed && run.EnvironmentId === ImportFixture.Runtime)
        {
            this.Failed = true
            throw new Error('injected failure between two registries')
        }
        await super.ImportPendingBackfill(run, folder)
    }
}

SqlTestSessions.Describe('EnvServerImport', (makeSession, label) =>
{
    const live = label.endsWith('[live]')
    describe(label, () =>
    {
        it('imports the golden fixture and the counts match', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const baseDir = ImportFixture.BaseDir()
            const report = await new EnvServerImport(database, new NodeFsStorage(baseDir), ImportFixture.Key).ImportIfPending()
            assert.ok(report !== undefined)
            assert.deepEqual(report.ToJson().environments, [ImportFixture.Dev, ImportFixture.Runtime])
            for (const environmentId of [ImportFixture.Dev, ImportFixture.Runtime])
            {
                assert.equal(report.CountOf(environmentId, 'accounts'), 2, environmentId)
                assert.equal(report.CountOf(environmentId, 'groups'), 1, environmentId)
                assert.equal(report.CountOf(environmentId, 'secrets'), 2, environmentId)
                assert.equal(report.CountOf(environmentId, 'service_tokens'), 1, environmentId)
                assert.equal(report.CountOf(environmentId, 'grants'), 2, environmentId)
                assert.equal(report.CountOf(environmentId, 'realm_configs'), 1, environmentId)
                assert.equal(report.CountOf(environmentId, 'audit'), 3, environmentId)
            }
            assert.equal(report.CountOf(ImportFixture.Dev, 'dev_graphs'), 2)
            assert.equal(report.CountOf(ImportFixture.Runtime, 'security_changes'), 2)
            assert.equal(report.CountOf(ImportFixture.Runtime, 'pending_backfill'), 2)
            assert.equal(report.CountOf(ImportFixture.Runtime, 'loaded_graph'), 1)
            assert.equal(report.CountOf(ImportFixture.Runtime, 'applications'), 2)
            assert.ok(report.Skipped.some(line => line.startsWith('sessions')))

            const set = await SqlIdentityStoreSet.Open(database.Session)
            const dev = set.For(ImportFixture.Dev, await database.Secrets(ImportFixture.Dev, ImportFixture.Key))
            const realm = ImportFixture.Realm(ImportFixture.Dev)
            assert.equal((await dev.Accounts.FindByPrincipalId(realm, 'ann'))?.Email, 'ann@acme.io')
            assert.equal((await dev.Accounts.FindByPrincipalId(realm, 'gone'))?.Disabled, true)
            assert.deepEqual((await dev.Accounts.ListGroups(realm)).map(g => [g.GroupId, [...g.MemberIds]]), [['eng', ['ann']]])
            assert.deepEqual((await dev.Tokens.List(realm)).map(t => t.PrincipalId), ['ci-bot'])
            assert.equal((await dev.Grants.GrantsFor('ann', realm)).length, 1)
            assert.equal((await set.RealmConfig().Get(ImportFixture.Dev))?.ProviderSettings.get('issuer'), 'https://idp.acme.io')
            // The audit chain is rebuilt with the same hashes as the files (anchors stay valid).
            const files = await FileAuditSink.Open(new NodeFsStorage(join(baseDir, ImportFixture.Dev, 'identity')))
            assert.deepEqual(set.Audit().Records(ImportFixture.Dev).map(r => r.Hash), files.Records(ImportFixture.Dev).map(r => r.Hash))
            assert.ok(set.Audit().Verify(ImportFixture.Dev))

            const graphs = new DevGraphStore(new EnvironmentRecords<DevGraphRow>(database, EnvServerRegistry.DevGraphs, ImportFixture.Dev))
            await graphs.Load()
            assert.deepEqual(graphs.List().map(g => g.name).sort(), ['crm', 'hr'])
            assert.deepEqual(graphs.Get('hr')?.slices, { 'sol-1': [{ id: 'hr', version: '1.0.0' }] })
            assert.deepEqual((await new SecurityChangeLog(new EnvironmentRecords<SecurityChangeLogRecord>(database, EnvServerRegistry.SecurityChanges, ImportFixture.Runtime)).List()).map(e => e.version), ['2', '1'])
            assert.deepEqual(await new PendingBackfillStore(new EnvironmentRecords<PendingBackfillRecord>(database, EnvServerRegistry.PendingBackfill, ImportFixture.Runtime)).List(), ['crm.Account', 'hr.Employee'])
            assert.equal((await new PromoteRecordStore(new EnvironmentRecords<PromoteRecord>(database, EnvServerRegistry.LoadedGraph, ImportFixture.Runtime)).Read())?.packages[0]?.version, '2.0.0')
            const apps = new PragmaticAppsRegistry(new EnvironmentRecords<ApplicationRecord>(database, EnvServerRegistry.Applications, ImportFixture.Runtime))
            assert.deepEqual(await apps.List(), [{ name: 'demo', version: '2.0.0' }])
            assert.ok(await apps.ManifestOf('demo', '1.0.0') !== undefined)
            assert.equal(await apps.ManifestOf('demo', '3.0.0'), undefined, 'a version without a manifest is not imported')
            assert.equal(await apps.LiveVersion('legacy'), undefined, 'a legacy app is imported as not live')
            assert.ok(await apps.ManifestOf('legacy', '0.9.0') !== undefined)
        })

        it('a second start imports nothing', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const baseDir = ImportFixture.BaseDir()
            assert.ok(await new EnvServerImport(database, new NodeFsStorage(baseDir), ImportFixture.Key).ImportIfPending() !== undefined)
            assert.equal(await new EnvServerImport(database, new NodeFsStorage(baseDir), ImportFixture.Key).ImportIfPending(), undefined)
            assert.equal(await ImportFixture.AuditRows(database, ImportFixture.Dev), 3)
        })

        it('a failure between two registries leaves no completion record and the next start finishes', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const baseDir = ImportFixture.BaseDir()
            const failing = new FailingOnceImport(database, new NodeFsStorage(baseDir), ImportFixture.Key)
            // One environment's failure is reported and the start goes on (only that environment stays pending).
            const failed = await failing.ImportIfPending()
            assert.deepEqual(failed?.ToJson().environments, [ImportFixture.Dev])
            assert.deepEqual(failed?.ToJson().failed, [ImportFixture.Runtime + ': Error'])
            assert.ok(failed?.Failed.every(line => !line.includes('injected')), 'the error name only, never its message')
            assert.equal(await failing.IsPending(ImportFixture.Runtime), true)
            assert.equal(await failing.IsPending(ImportFixture.Dev), false)
            const state = await database.Records<{ id: string }>(EnvServerRegistry.Import)
            assert.ok(await state.Get(EnvServerImport.StatePrefix + ImportFixture.Dev) !== undefined, 'the environment before the failure finished')
            assert.equal(await state.Get(EnvServerImport.StatePrefix + ImportFixture.Runtime), undefined, 'no completion record for the failed one')
            if (live)
            {
                // Rolled back (Postgres; pg-mem does not roll back): nothing of the failed environment's steps before the failure stayed.
                const realm = ImportFixture.Realm(ImportFixture.Runtime)
                const set = await SqlIdentityStoreSet.Open(database.Session)
                assert.equal((await set.For(ImportFixture.Runtime, await database.Secrets(ImportFixture.Runtime, ImportFixture.Key)).Accounts.ListAccounts(realm)).length, 0, 'no accounts')
                assert.equal(await ImportFixture.AuditRows(database, ImportFixture.Runtime), 0, 'no audit rows')
                assert.equal(await new EnvironmentRecords<SecurityChangeLogRecord>(database, EnvServerRegistry.SecurityChanges, ImportFixture.Runtime).Get(SecurityChangeLog.RecordKey), undefined, 'no security change log')
            }
            const report = await failing.ImportIfPending()
            assert.deepEqual(report?.ToJson().environments, [ImportFixture.Runtime])
            assert.ok(await state.Get(EnvServerImport.StatePrefix + ImportFixture.Runtime) !== undefined)
            assert.equal(await ImportFixture.AuditRows(database, ImportFixture.Runtime), 3, 'a re-run never duplicates audit events')
            assert.deepEqual(await new PendingBackfillStore(new EnvironmentRecords<PendingBackfillRecord>(database, EnvServerRegistry.PendingBackfill, ImportFixture.Runtime)).List(), ['crm.Account', 'hr.Employee'])
            const realm = ImportFixture.Realm(ImportFixture.Runtime)
            const set = await SqlIdentityStoreSet.Open(database.Session)
            assert.equal((await set.For(ImportFixture.Runtime, await database.Secrets(ImportFixture.Runtime, ImportFixture.Key)).Accounts.ListAccounts(realm)).length, 2, 'accounts not duplicated')
        })

        it('the CLI run stops at the first failing environment (it is not a start)', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            await assert.rejects(new FailingOnceImport(database, new NodeFsStorage(ImportFixture.BaseDir()), ImportFixture.Key).Run(false), /injected failure/)
        })

        it('imports only the environment\'s own realm: tokens, grants and realm configurations of another realm are skipped', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const baseDir = ImportFixture.BaseDir()
            const identity = join(baseDir, ImportFixture.Dev, 'identity')
            const grants = JSON.parse(readFileSync(join(identity, 'grants.json'), 'utf8')) as { grants: Record<string, unknown>[] }
            grants.grants.push({ subject: 'mallory', role: 3, resourceKind: 0, resourceRealmId: ImportFixture.Runtime, resourcePath: [] })
            writeFileSync(join(identity, 'grants.json'), JSON.stringify(grants))
            const tokens = JSON.parse(readFileSync(join(identity, 'service-tokens.json'), 'utf8')) as { records: Record<string, Record<string, unknown>> }
            tokens.records['other-realm-hash'] = { tokenRef: 'acme-rt/svctok/other', principalId: 'mallory-bot', realmId: ImportFixture.Runtime, scopes: ['deploy'], expiresAt: null, revoked: false }
            writeFileSync(join(identity, 'service-tokens.json'), JSON.stringify(tokens))
            const configs = JSON.parse(readFileSync(join(identity, 'realm-config.json'), 'utf8')) as { configs: Record<string, Record<string, unknown>> }
            const runtimeConfig = { ...configs.configs[ImportFixture.Dev]!, providerSettings: [['issuer', 'https://evil.example']] }
            configs.configs[ImportFixture.Runtime] = runtimeConfig
            writeFileSync(join(identity, 'realm-config.json'), JSON.stringify(configs))
            // acme-dev is imported alone first, so acme-rt's own files cannot mask what acme-dev's would write there.
            rmSync(join(baseDir, ImportFixture.Runtime), { recursive: true })
            const report = await new EnvServerImport(database, new NodeFsStorage(baseDir), ImportFixture.Key).ImportIfPending()
            assert.equal(report?.CountOf(ImportFixture.Dev, 'grants'), 2)
            assert.equal(report?.CountOf(ImportFixture.Dev, 'service_tokens'), 1)
            assert.equal(report?.CountOf(ImportFixture.Dev, 'realm_configs'), 1)
            assert.ok(report?.Skipped.some(line => line.startsWith(ImportFixture.Dev + ': grant not imported (on another realm): mallory')))
            assert.ok(report?.Skipped.some(line => line.startsWith(ImportFixture.Dev + ': service token not imported (another realm)')))
            assert.ok(report?.Skipped.some(line => line === ImportFixture.Dev + ': realm config not imported (another realm): ' + ImportFixture.Runtime))
            const set = await SqlIdentityStoreSet.Open(database.Session)
            const runtime = set.For(ImportFixture.Runtime, await database.Secrets(ImportFixture.Runtime, ImportFixture.Key))
            const realm = ImportFixture.Realm(ImportFixture.Runtime)
            assert.deepEqual(await runtime.Grants.GrantsFor('mallory', realm), [], 'acme-rt holds no grant from acme-dev\'s files')
            assert.deepEqual(await runtime.Tokens.List(realm), [], 'acme-rt holds no token from acme-dev\'s files')
            assert.equal(await set.RealmConfig().Get(ImportFixture.Runtime), null, 'acme-rt holds no realm configuration from acme-dev\'s files')
        })

        it('skips dot-led folders at the base (the server database\'s .postgres data) and a missing base folder', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const baseDir = ImportFixture.BaseDir()
            cpSync(join(baseDir, ImportFixture.Dev), join(baseDir, '.postgres'), { recursive: true })
            const importer = new EnvServerImport(database, new NodeFsStorage(baseDir), ImportFixture.Key)
            assert.deepEqual(await importer.EnvironmentsWithFiles(), [ImportFixture.Dev, ImportFixture.Runtime])
            assert.equal(await importer.IsPending('.postgres'), false)
            const missing = join(mkdtempSync(join(tmpdir(), 'env-import-missing-')), 'absent')
            assert.equal(await new EnvServerImport(database, new NodeFsStorage(missing), ImportFixture.Key).ImportIfPending(), undefined)
        })

        it('application handoff files alone (the unpacker\'s, written after A5 too) do not make an environment pending', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const baseDir = mkdtempSync(join(tmpdir(), 'env-import-apps-'))
            cpSync(join(ImportFixture.Golden, ImportFixture.Runtime, 'applications'), join(baseDir, 'fresh', 'applications'), { recursive: true })
            const importer = new EnvServerImport(database, new NodeFsStorage(baseDir), ImportFixture.Key)
            assert.equal(await importer.IsPending('fresh'), false)
            assert.equal(await importer.ImportIfPending(), undefined)
        })

        it('secrets open under the new scope', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            await new EnvServerImport(database, new NodeFsStorage(ImportFixture.BaseDir()), ImportFixture.Key).ImportIfPending()
            const ring = SqlSecretKeyRing.Single(EnvServerDatabase.SecretKeyId, ImportFixture.Key)
            assert.equal(await (await SqlSecretStore.Open(database.Session, ring, 'env-server/acme-dev')).Get('ann-pw'), 'argon2-hash-of-ann')
            assert.equal(await (await SqlSecretStore.Open(database.Session, ring, 'env-server/acme-dev')).Get('oidc-client-secret'), 'client-secret-acme-dev')
            assert.equal(await (await SqlSecretStore.Open(database.Session, ring, 'env-server/acme-rt')).Get('ann-pw'), null)
        })

        it('the data folder is byte-identical afterwards', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const baseDir = ImportFixture.BaseDir()
            const before = ImportFixture.Digests(baseDir)
            await new EnvServerImport(database, new NodeFsStorage(baseDir), ImportFixture.Key).Run(false)
            assert.deepEqual(ImportFixture.Digests(baseDir), before)
        })

        it('refuses a database that holds records unless forced, and a forced re-run is idempotent', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const baseDir = ImportFixture.BaseDir()
            await new EnvServerImport(database, new NodeFsStorage(baseDir), ImportFixture.Key).Run(false)
            await assert.rejects(new EnvServerImport(database, new NodeFsStorage(baseDir), ImportFixture.Key).Run(false), (error: Error) => error instanceof EnvServerImportRefusedError && error.message.includes(ImportFixture.Dev))
            await new EnvServerImport(database, new NodeFsStorage(baseDir), ImportFixture.Key).Run(true)
            assert.equal(await ImportFixture.AuditRows(database, ImportFixture.Dev), 3)
            const set = await SqlIdentityStoreSet.Open(database.Session)
            assert.equal((await set.For(ImportFixture.Dev, await database.Secrets(ImportFixture.Dev, ImportFixture.Key)).Grants.GrantsFor('ann', ImportFixture.Realm(ImportFixture.Dev))).length, 1)
        })

        it('a base folder without environment data imports nothing', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            assert.equal(await new EnvServerImport(database, new NodeFsStorage(mkdtempSync(join(tmpdir(), 'env-import-empty-'))), ImportFixture.Key).ImportIfPending(), undefined)
        })

        it('a forced re-run after the server ran never moves the database back', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const baseDir = ImportFixture.BaseDir()
            await new EnvServerImport(database, new NodeFsStorage(baseDir), ImportFixture.Key).Run(false)
            // The server runs: v3 goes live, a security change and a promote are recorded, a grant is revoked, an account re-enabled.
            const apps = new PragmaticAppsRegistry(new EnvironmentRecords<ApplicationRecord>(database, EnvServerRegistry.Applications, ImportFixture.Runtime))
            await apps.Commit({ name: 'demo', version: '3.0.0', packages: [{ id: 'hr', version: '3.0.0' }] })
            const log = new SecurityChangeLog(new EnvironmentRecords<SecurityChangeLogRecord>(database, EnvServerRegistry.SecurityChanges, ImportFixture.Runtime))
            const newest = { ...(await log.List())[0]!, version: '9' }
            await log.Append(newest)
            const promote = new PromoteRecordStore(new EnvironmentRecords<PromoteRecord>(database, EnvServerRegistry.LoadedGraph, ImportFixture.Runtime))
            await promote.Save({ name: 'suite', packages: [{ id: 'hr', version: '3.0.0' }], promotedAt: '2026-11-23T00:00:00.000Z' })
            const set = await SqlIdentityStoreSet.Open(database.Session)
            const dev = set.For(ImportFixture.Dev, await database.Secrets(ImportFixture.Dev, ImportFixture.Key))
            const realm = ImportFixture.Realm(ImportFixture.Dev)
            for (const grant of await dev.Grants.GrantsFor('ann', realm)) await dev.Grants.Revoke(grant)
            await dev.Accounts.Enable(realm, 'gone')
            const report = await new EnvServerImport(database, new NodeFsStorage(baseDir), ImportFixture.Key).Run(true)
            assert.equal(await apps.LiveVersion('demo'), '3.0.0', 'the live pointer the database holds wins')
            assert.ok(await apps.ManifestOf('demo', '1.0.0') !== undefined)
            assert.equal((await log.List())[0]?.version, '9')
            assert.equal((await promote.Read())?.packages[0]?.version, '3.0.0')
            assert.deepEqual(await dev.Grants.GrantsFor('ann', realm), [], 'a revoked grant is not resurrected')
            assert.equal((await dev.Accounts.FindByPrincipalId(realm, 'gone'))?.Disabled, false)
            assert.equal(await ImportFixture.AuditRows(database, ImportFixture.Dev), 3)
            assert.ok(report.Skipped.some(line => line.startsWith(ImportFixture.Dev + ': identity: kept')))
        })

        it('an unreadable realm configuration is reported and skipped, the rest imports', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const baseDir = ImportFixture.BaseDir()
            const file = join(baseDir, ImportFixture.Dev, 'identity', 'realm-config.json')
            const document = JSON.parse(readFileSync(file, 'utf8')) as { configs: Record<string, Record<string, unknown>> }
            document.configs[ImportFixture.Dev]!.securityModel = 'not an object'
            writeFileSync(file, JSON.stringify(document))
            const report = await new EnvServerImport(database, new NodeFsStorage(baseDir), ImportFixture.Key).ImportIfPending()
            assert.ok(report?.Skipped.some(line => line.startsWith(ImportFixture.Dev + ': realm config unreadable')))
            assert.equal(report?.CountOf(ImportFixture.Dev, 'accounts'), 2)
            assert.deepEqual(report?.ToJson().environments, [ImportFixture.Dev, ImportFixture.Runtime])
        })

        it('imports through an object store (the storage of a cloud platform)', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const storage = new ObjectStoreProviderRegistry().CreateStorage('base')
            const files = ImportFixture.Digests(ImportFixture.Golden)
            for (const path of files.keys())
            {
                await storage.WriteBytes(path.split(sep).join('/'), readFileSync(join(ImportFixture.Golden, path)))
            }
            const report = await new EnvServerImport(database, storage, ImportFixture.Key).ImportIfPending()
            assert.deepEqual(report?.ToJson().environments, [ImportFixture.Dev, ImportFixture.Runtime])
            assert.equal(report?.CountOf(ImportFixture.Dev, 'secrets'), 2)
            assert.equal(report?.CountOf(ImportFixture.Runtime, 'applications'), 2)
        })
    })
})

SqlTestSessions.DescribeLive('EnvServerImport', makeDatabase =>
{
    it('two replicas starting together import once: the one that waited for the lock writes and reports nothing [live]', async () =>
    {
        const live = await makeDatabase()
        try
        {
            const baseDir = ImportFixture.BaseDir()
            const reports = await Promise.all([1, 2].map(() => new EnvServerImport(EnvServerDatabase.Over(live.Session()), new NodeFsStorage(baseDir), ImportFixture.Key).ImportIfPending()))
            const database = EnvServerDatabase.Over(live.Session())
            const environments = reports.flatMap(report => report?.Environments ?? []).sort()
            assert.deepEqual(environments, [ImportFixture.Dev, ImportFixture.Runtime], 'each environment reported once')
            const state = await database.Records<{ id: string; importedAt: string }>(EnvServerRegistry.Import)
            const importedAt = (await state.Get(EnvServerImport.StatePrefix + ImportFixture.Dev))?.importedAt
            assert.ok(importedAt !== undefined)
            assert.equal(await ImportFixture.AuditRows(database, ImportFixture.Dev), 3)
            // A third start finds both finished and writes nothing.
            assert.equal(await new EnvServerImport(database, new NodeFsStorage(baseDir), ImportFixture.Key).ImportIfPending(), undefined)
            assert.equal((await state.Get(EnvServerImport.StatePrefix + ImportFixture.Dev))?.importedAt, importedAt, 'the completion record is not rewritten')
        }
        finally
        {
            await live.Dispose()
        }
    })
})
