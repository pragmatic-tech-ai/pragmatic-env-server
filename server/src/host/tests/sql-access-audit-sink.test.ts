import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AuditSinkKind, AuditSurface, AuditOutcome, NullAccessAuditSink, type ServerConfig } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { NullLogger } from '@pragmatic-tech-ai/pragmatic-observability'
import { ServerBootstrap } from '../../bin/server-bootstrap.js'
import { AuditSinkRetiredError } from '../../bin/audit-sink-retired-error.js'
import { CustomPlatformFixture } from '../../platform/tests/custom-platform-fixture.js'

class AuditFixture
{
    public static Config(auditSink?: AuditSinkKind): ServerConfig
    {
        return { auditSink } as unknown as ServerConfig
    }
}

describe('env server access audit sink', () =>
{
    it('custom platform writes access audit rows with realm = environment id', async () =>
    {
        const platform = CustomPlatformFixture.Mem()
        const sink = await ServerBootstrap.AuditSink(AuditFixture.Config(), new NullLogger(), undefined, platform)
        await sink.Record({ Timestamp: new Date(), EnvironmentId: 'env-a', PrincipalId: 'ann', Surface: AuditSurface.Http, MethodOrPath: '/auth/login', Outcome: AuditOutcome.Deny, Reason: 'bad-credentials' })
        await sink.Record({ Timestamp: new Date(), EnvironmentId: 'env-b', Surface: AuditSurface.Http, MethodOrPath: '/auth/login', Outcome: AuditOutcome.Allow })
        await sink.Drain()
        const rows = await platform.Database.Session.Query('SELECT realm_id, principal_id FROM env_access_audit ORDER BY realm_id', [])
        assert.deepEqual(rows.map(r => [r.realm_id, r.principal_id]), [['env-a', 'ann'], ['env-b', null]])
    })

    it('sql is the default and none drops the records', async () =>
    {
        const platform = CustomPlatformFixture.Mem()
        assert.ok(!(await ServerBootstrap.AuditSink(AuditFixture.Config(AuditSinkKind.Sql), new NullLogger(), undefined, platform) instanceof NullAccessAuditSink))
        assert.ok(await ServerBootstrap.AuditSink(AuditFixture.Config(AuditSinkKind.None), new NullLogger(), undefined, platform) instanceof NullAccessAuditSink)
    })

    it('PRAGMATIC_AUDIT_SINK=file refuses the start naming the variable', async () =>
    {
        await assert.rejects(ServerBootstrap.AuditSink(AuditFixture.Config(AuditSinkKind.File), new NullLogger(), undefined, CustomPlatformFixture.Mem()), (error: Error) => error instanceof AuditSinkRetiredError && /PRAGMATIC_AUDIT_SINK/.test(error.message))
    })
})
