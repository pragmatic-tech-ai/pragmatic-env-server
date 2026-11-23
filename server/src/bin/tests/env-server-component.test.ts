import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { SettingDescriptor } from '@pragmatic-tech-ai/pragmatic-component'
import { EnvServerComponent } from '../env-server-component.js'
import { ComponentGolden } from '../../component/tests/component-golden.js'
import { ComponentSources } from '../../component/tests/component-sources.js'

class EnvServerComponentFixture
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly Golden = join(EnvServerComponentFixture.Here, 'fixtures', 'pragmatic-env-server.component.json')
    public static readonly Digest = 'sha256:c80632390c7f4be5793acff795145713a84944ba2c0c6d7b939a046a3a42cbb2'
    public static readonly Readers = [
        ComponentSources.InPackage('@pragmatic-tech-ai/pragmatic-env-cluster', 'config', 'server-config-loader.js'),
        join(EnvServerComponentFixture.Here, '..', '..', 'storage', 'env-server-database.ts'),
    ]
    /** PRAGMATIC_MASTER_KEY_B64_ENV: the documented alternative of masterKey; PRAGMATIC_AUDIT_FILE: the shared loader still
     *  reads it for the gateway, the env server refuses the retired file sink (AuditSinkRetiredError). */
    public static readonly Undeclared: readonly string[] = ['PRAGMATIC_MASTER_KEY_B64_ENV', 'PRAGMATIC_AUDIT_FILE']

    public static Setting(option: string, name: string): SettingDescriptor
    {
        const found = EnvServerComponent.Descriptor().Options.find(o => o.Name === option)?.Settings.find(s => s.Name === name)
        assert.ok(found !== undefined, option + '.' + name)
        return found
    }
}

describe('EnvServerComponent', () =>
{
    it('pins the descriptor: golden JSON and content digest', () =>
    {
        ComponentGolden.Check(EnvServerComponent.Descriptor(), EnvServerComponentFixture.Golden, EnvServerComponentFixture.Digest)
    })

    it('declares exactly the variables its configuration readers read', () =>
    {
        ComponentSources.AssertCovers(EnvServerComponent.Descriptor(), EnvServerComponentFixture.Readers, EnvServerComponentFixture.Undeclared)
    })

    it('declares databaseUrl as a required secret read from PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE', () =>
    {
        const setting = EnvServerComponentFixture.Setting('core', 'databaseUrl')
        assert.equal(setting.Required, true)
        assert.equal(setting.Secret, true)
        assert.ok(setting.Description.startsWith('PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE: '))
    })

    it('audit sink allows none and sql only', () =>
    {
        const sink = EnvServerComponentFixture.Setting('audit', 'sink')
        assert.equal(sink.Default, 'sql')
        assert.match(sink.Description, /^PRAGMATIC_AUDIT_SINK: sql .* or none;/)
        assert.equal(EnvServerComponent.Descriptor().Options.find(o => o.Name === 'audit')!.Settings.length, 1, 'no audit file setting')
    })

    it('is named for its release image', () =>
    {
        assert.equal(EnvServerComponent.Descriptor().Name, 'pragmatic-env-server')
    })
})
