import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { EnvServerImportBin } from '../pragmatic-env-server-import.js'
import { EnvServerTestDatabase } from '../../storage/tests/env-server-test-database.js'

class BinFixture
{
    public static readonly Golden = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'storage', 'tests', 'fixtures', 'pre-a5')
    public readonly Out: string[] = []
    public readonly Err: string[] = []

    public static Env(): NodeJS.ProcessEnv
    {
        const dir = mkdtempSync(join(tmpdir(), 'env-import-bin-'))
        const key = join(dir, 'master.key')
        writeFileSync(key, Buffer.alloc(32, 42))
        return { PRAGMATIC_MASTER_KEY_FILE: key }
    }

    public static BaseDir(): string
    {
        const dir = mkdtempSync(join(tmpdir(), 'env-import-bin-base-'))
        cpSync(BinFixture.Golden, dir, { recursive: true })
        return dir
    }

    public Run(argv: readonly string[], env: NodeJS.ProcessEnv, database = EnvServerTestDatabase.Mem()): Promise<number>
    {
        return EnvServerImportBin.Run(argv, env, line => this.Out.push(line), line => this.Err.push(line), database)
    }
}

describe('pragmatic-env-server-import', () =>
{
    it('exits 2 on bad arguments', async () =>
    {
        const f = new BinFixture()
        assert.equal(await f.Run([], BinFixture.Env()), EnvServerImportBin.UsageExit)
        assert.equal(await f.Run(['--base-dir'], BinFixture.Env()), EnvServerImportBin.UsageExit)
        assert.equal(await f.Run(['--base-dir', '/x', '--bogus'], BinFixture.Env()), EnvServerImportBin.UsageExit)
        assert.match(f.Err[0]!, /usage: pragmatic-env-server-import --base-dir/)
    })

    it('exits 0 and prints the report, then 3 when the database already holds the records, and 0 again with --force', async () =>
    {
        const f = new BinFixture()
        const database = EnvServerTestDatabase.Mem()
        const base = BinFixture.BaseDir()
        const env = BinFixture.Env()
        assert.equal(await f.Run(['--base-dir', base], env, database), 0)
        assert.deepEqual(JSON.parse(f.Out[0]!).environments, ['acme-dev', 'acme-rt'])
        assert.equal(await f.Run(['--base-dir', base], env, database), EnvServerImportBin.RefusedExit)
        assert.match(f.Err.at(-1)!, /--force/)
        assert.equal(await f.Run(['--base-dir', base, '--force'], env, database), 0)
    })

    it('exits 1 without a master key, naming the setting', async () =>
    {
        const f = new BinFixture()
        assert.equal(await f.Run(['--base-dir', BinFixture.BaseDir()], {}), EnvServerImportBin.FailedExit)
        assert.match(f.Err[0]!, /PRAGMATIC_MASTER_KEY_FILE/)
    })
})
