import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DeploymentMode, AuditSinkKind, NullAccessAuditSink, type ServerConfig, HostBootstrap } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { ServerBootstrap } from '../server-bootstrap.js'
import { CustomPlatformFixture } from '../../platform/tests/custom-platform-fixture.js'
import { AuditSinkRetiredError } from '../audit-sink-retired-error.js'
import { NullLogger } from '@pragmatic-tech-ai/pragmatic-observability'

class SecurityFixture
{
    public static BaseConfig(): ServerConfig
    {
        return { host: '0.0.0.0', port: 8080, baseDir: '/d', masterKey: { keyFilePath: '/k' }, deploymentMode: DeploymentMode.Local }
    }
}

test('the startup line reports audit + ratelimit tokens and never the audit path', () =>
{
    const line = ServerBootstrap.StartupLine({ ...SecurityFixture.BaseConfig(), auditSink: AuditSinkKind.File, auditFile: '/secret/path/audit.log', rateLimit: { perEnvironment: { Rps: 1, Burst: 1 } } }, 1)
    assert.ok(line.includes('audit=file'))
    assert.ok(line.includes('ratelimit=on'))
    assert.equal(line.includes('/secret/path/audit.log'), false)
    const unset = ServerBootstrap.StartupLine(SecurityFixture.BaseConfig(), 1)
    assert.ok(unset.includes('audit=sql'))
    assert.ok(unset.includes('ratelimit=off'))
})

test('AuditSink writes to the platform audit store by default, drops for none and refuses the retired file sink', async () =>
{
    const platform = CustomPlatformFixture.Mem()
    const logger = new NullLogger()
    const sql = await ServerBootstrap.AuditSink(SecurityFixture.BaseConfig(), logger, undefined, platform)
    assert.equal(sql instanceof NullAccessAuditSink, false)
    const none = await ServerBootstrap.AuditSink({ ...SecurityFixture.BaseConfig(), auditSink: AuditSinkKind.None }, logger, undefined, platform)
    assert.ok(none instanceof NullAccessAuditSink)
    await assert.rejects(ServerBootstrap.AuditSink({ ...SecurityFixture.BaseConfig(), auditSink: AuditSinkKind.File }, logger, undefined, platform), AuditSinkRetiredError)
})

test('ComposeOptions threads the sink and guard through', () =>
{
    const audit = new NullAccessAuditSink()
    const guard = HostBootstrap.RateLimit(SecurityFixture.BaseConfig(), audit)
    const options = ServerBootstrap.ComposeOptions(SecurityFixture.BaseConfig(), {} as never, CustomPlatformFixture.Mem(), undefined, undefined, undefined, audit, guard)
    assert.equal(options.audit, audit)
    assert.equal(options.rateLimit, guard)
})
