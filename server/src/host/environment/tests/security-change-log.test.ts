import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { EnvServerDatabase } from '../../../storage/env-server-database.js'
import { EnvServerRegistry } from '../../../storage/env-server-registry.js'
import { EnvironmentRecords } from '../../../storage/environment-records.js'
import { EnvServerTestDatabase } from '../../../storage/tests/env-server-test-database.js'
import type { SecurityChangesDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { DeliverySecurity } from '../delivery-security.js'
import type { EnvironmentSecuritySetting } from '../environment-security-setting.js'
import { SecurityChangeLog, type ISecurityChangeLogDiagnostics, type SecurityChangeLogRecord } from '../security-change-log.js'
import type { PendingBackfillStore } from '../pending-backfill-store.js'
import type { SecurityDeployDiff } from '../security-deploy-diff.js'
import type { SystemPrincipalScope } from '../system-principal-scope.js'

class LogFx
{
    public static readonly App = 'suite'
    public static readonly Environment = 'rt-1'
    private static readonly Unused = 'unused'

    public static async Run(body: (log: SecurityChangeLog) => Promise<void>): Promise<void>
    {
        await body(new SecurityChangeLog(LogFx.Records(EnvServerTestDatabase.Mem())))
    }

    public static Records(database: EnvServerDatabase, environment: string = LogFx.Environment): EnvironmentRecords<SecurityChangeLogRecord>
    {
        return new EnvironmentRecords<SecurityChangeLogRecord>(database, EnvServerRegistry.SecurityChanges, environment)
    }

    public static Entry(version: number): SecurityChangesDto
    {
        return {
            at: new Date(version * 1000).toISOString(), delivery: LogFx.App, version: String(version),
            roleDefaults: [], profileDefaults: [], securedFieldsAdded: [{ concept: 'hr.Employee', field: 'Bonus' }], securedFieldsRemoved: [],
            roleOverridesDropped: [], profileOverridesDropped: [], rolesRemoved: [], profilesRemoved: [],
        }
    }

    /** A DeliverySecurity over no stored setting; its system principal and backfill store are never reached. */
    public static Security(log: SecurityChangeLog): DeliverySecurity
    {
        const setting = { Exclusive: <T>(section: () => Promise<T>): Promise<T> => section(), Config: async () => undefined, Reconcile: () => undefined }
        return new DeliverySecurity(setting as unknown as EnvironmentSecuritySetting, log, () => Promise.reject(new Error(LogFx.Unused)) as Promise<SystemPrincipalScope>, {} as PendingBackfillStore)
    }
}

describe('security change log', () =>
{
    test('entries are newest first and capped', async () =>
    {
        await LogFx.Run(async log =>
        {
            const count = SecurityChangeLog.MaxEntries + 2
            for (let version = 1; version <= count; version++) await log.Append(LogFx.Entry(version))
            const listed = await log.List()
            assert.equal(listed.length, SecurityChangeLog.MaxEntries)
            assert.equal(listed[0].version, String(count), 'newest first')
            assert.equal(listed[listed.length - 1].version, String(count - SecurityChangeLog.MaxEntries + 1), 'the oldest beyond the cap are dropped')
        })
    })

    test('empty diff is not logged', async () =>
    {
        await LogFx.Run(async log =>
        {
            const empty = { IsEmpty: true, Prunes: false, NewlyOwned: [], Prospective: undefined, Rebased: (): unknown => empty } as unknown as SecurityDeployDiff
            assert.equal(await LogFx.Security(log).Commit(empty, LogFx.App, LogFx.App), undefined)
            assert.deepEqual(await log.List(), [])
        })
    })

    test('a malformed record lists as empty, is reported, and the next append replaces it', async () =>
    {
        const database = EnvServerTestDatabase.Mem()
        const diagnostics = new RecordingDiagnostics()
        await LogFx.Records(database).Put({ id: SecurityChangeLog.RecordKey, entries: 'not a list' } as unknown as SecurityChangeLogRecord)
        const log = new SecurityChangeLog(LogFx.Records(database), diagnostics)
        assert.deepEqual(await log.List(), [])
        assert.equal(diagnostics.Unreadables.length, 1)
        await log.Append(LogFx.Entry(1))
        assert.deepEqual((await log.List()).map(e => e.version), ['1'])
    })

    test('an append that cannot reach the database is reported, not thrown', async () =>
    {
        const diagnostics = new RecordingDiagnostics()
        const failing = { Update: () => Promise.reject(new Error('database down')) } as unknown as EnvironmentRecords<SecurityChangeLogRecord>
        await new SecurityChangeLog(failing, diagnostics).Append(LogFx.Entry(1))
        assert.equal(diagnostics.AppendFailures.length, 1)
    })

    test('the log survives a restart and is kept per environment', async () =>
    {
        const database = EnvServerTestDatabase.Mem()
        await new SecurityChangeLog(LogFx.Records(database)).Append(LogFx.Entry(7))
        assert.deepEqual((await new SecurityChangeLog(LogFx.Records(database)).List()).map(e => e.version), ['7'])
        assert.deepEqual(await new SecurityChangeLog(LogFx.Records(database, 'rt-2')).List(), [])
    })
})

SqlTestSessions.DescribeLive('security change log', makeDatabase =>
{
    test('security change log keeps the newest 50 under 8 concurrent writers [live]', async () =>
    {
        const live = await makeDatabase()
        try
        {
            const database = EnvServerDatabase.Over(live.Session())
            await LogFx.Records(database).Put({ id: SecurityChangeLog.RecordKey, entries: Array.from({ length: SecurityChangeLog.MaxEntries }, (_, i) => LogFx.Entry(i + 1)).reverse() })
            const diagnostics = new RecordingDiagnostics()
            // Eight workers, each its own log over the same database, append concurrently.
            const writers = Array.from({ length: 8 }, () => new SecurityChangeLog(LogFx.Records(EnvServerDatabase.Over(live.Session())), diagnostics))
            await Promise.all(writers.map((log, i) => log.Append(LogFx.Entry(1000 + i))))
            assert.deepEqual(diagnostics.AppendFailures, [])
            const listed = await new SecurityChangeLog(LogFx.Records(database)).List()
            assert.equal(listed.length, SecurityChangeLog.MaxEntries)
            const versions = listed.map(e => e.version)
            for (let i = 0; i < 8; i++) assert.ok(versions.includes(String(1000 + i)), 'every writer landed: ' + (1000 + i))
            assert.deepEqual(versions.slice(8), Array.from({ length: SecurityChangeLog.MaxEntries - 8 }, (_, i) => String(SecurityChangeLog.MaxEntries - i)), 'the oldest dropped')
        }
        finally
        {
            await live.Dispose()
        }
    })
})

class RecordingDiagnostics implements ISecurityChangeLogDiagnostics
{
    public readonly Unreadables: unknown[] = []
    public readonly AppendFailures: unknown[] = []

    public Unreadable(error: unknown): void
    {
        this.Unreadables.push(error)
    }

    public AppendFailed(error: unknown): void
    {
        this.AppendFailures.push(error)
    }
}
