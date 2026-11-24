import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SettingType } from '@pragmatic-tech-ai/pragmatic-component'
import { AppliedConfiguration, ComponentStartConfiguration, type IStartProcess } from '@pragmatic-tech-ai/pragmatic-configuration-runtime'
import { ServerConfigLoader } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { EnvServerComponent } from '../env-server-component.js'

/** The process outcome of one main started as the image starts it (`node` on the entry), by exit code and stderr. */
class MainRun
{
    public constructor(public readonly Code: number | null, public readonly Stderr: string)
    {
    }
}

class EnvServerStart
{
    public static readonly Here = dirname(fileURLToPath(import.meta.url))
    public static readonly ServerMain = join(EnvServerStart.Here, '..', 'server-main.ts')
    public static readonly WorkerMain = join(EnvServerStart.Here, '..', 'worker-main.ts')
    private static readonly FileName = 'configuration.json'
    private static readonly Realm = 'acme'
    private static readonly ImportFlag = '--import'
    private static readonly Tsx = 'tsx'
    private static readonly ExitEvent = 'exit'
    private static readonly Utf8 = 'utf8'
    /** Long enough for a cold tsx compile of either main on the hive. */
    public static readonly SpawnTimeoutMs = 60000

    /** What the manifests render (the platform's wiring), with the configuration file at `path`. */
    public static Env(path: string): NodeJS.ProcessEnv
    {
        return {
            PRAGMATIC_CONFIGURATION_FILE: path,
            PRAGMATIC_BASE_DIR: '/data',
            PRAGMATIC_MASTER_KEY_B64_ENV: 'PRAGMATIC_MASTER_KEY',
            PRAGMATIC_ENVIRONMENT_ID: 'acme-dev',
            PRAGMATIC_PORT: '8080',
        }
    }

    public static NoFile(_path: string): string
    {
        throw new Error('no file')
    }

    public static async InFolder(body: (folder: string) => Promise<void>): Promise<void>
    {
        const folder = await mkdtemp(join(tmpdir(), 'env-server-start-'))
        try
        {
            await body(folder)
        }
        finally
        {
            await rm(folder, { recursive: true, force: true })
        }
    }

    /** An applied configuration for this image's own descriptor, holding `options` as authored. */
    public static async Configuration(folder: string, options: Record<string, Record<string, unknown>>): Promise<string>
    {
        const d = EnvServerComponent.Descriptor()
        const path = join(folder, EnvServerStart.FileName)
        await writeFile(path, new AppliedConfiguration(EnvServerStart.Realm, d.Name, 1, d.Version, d.ContentDigest(), { options } as never).ToCanonicalJson())
        return path
    }

    /** Starts `main` with `env` only (no inherited variables) and waits for it to exit. */
    public static Run(main: string, env: NodeJS.ProcessEnv): Promise<MainRun>
    {
        return new Promise((resolve, reject) =>
        {
            const child = spawn(process.execPath, [EnvServerStart.ImportFlag, EnvServerStart.Tsx, main], { env: { ...env, PATH: process.env.PATH }, cwd: EnvServerStart.Here })
            let stderr = ''
            child.stderr.setEncoding(EnvServerStart.Utf8)
            child.stderr.on('data', (chunk: string) => { stderr += chunk })
            child.stdout.resume()
            child.on('error', reject)
            child.on(EnvServerStart.ExitEvent, code => resolve(new MainRun(code, stderr)))
        })
    }
}

class ExitRecorder implements IStartProcess
{
    public Code: number | undefined
    public Text = ''
    public readonly stderr = { write: (text: string): boolean => { this.Text += text; return true } }

    public exit(code: number): never
    {
        this.Code = code
        throw new Error('exit')
    }
}

describe('the env server reads its configuration at start', () =>
{
    it('a mounted configuration overrides the declared variable before the settings are read', async () =>
    {
        await EnvServerStart.InFolder(async folder =>
        {
            const env = EnvServerStart.Env(await EnvServerStart.Configuration(folder, {
                core: { idleTtlMs: 600000 },
                webSocket: { heartbeatMs: 15000 },
                paging: { pageSizeMax: 500 },
                observability: { traceSampling: '0.25' },
            }))
            env.PRAGMATIC_IDLE_TTL_MS = '1000'
            const report = await ComponentStartConfiguration.Apply({ Declaration: EnvServerComponent.Declaration, Env: env, SecretsDir: join(folder, 'run') })
            const config = ServerConfigLoader.Load(env, EnvServerStart.NoFile)
            assert.equal(report.Version, 1)
            assert.deepEqual([config.idleTtlMs, config.wsResilience?.heartbeatIntervalMs, config.pagingMaxPageSize], [600000, 15000, 500])
            assert.equal(env.PRAGMATIC_TRACE_SAMPLING, '0.25')
        })
    })

    it('no configuration starts as before', async () =>
    {
        const env = EnvServerStart.Env('/no/such/configuration.json')
        env.PRAGMATIC_IDLE_TTL_MS = '1000'
        const before = { ...env }
        assert.equal((await ComponentStartConfiguration.ApplyOrExit({ Declaration: EnvServerComponent.Declaration, Env: env })).Applied, false)
        assert.deepEqual(env, before)
        assert.equal(ServerConfigLoader.Load(env, EnvServerStart.NoFile).idleTtlMs, 1000)
    })

    it('an invalid configuration exits with the start error code 78 and the reason', async () =>
    {
        await EnvServerStart.InFolder(async folder =>
        {
            const process = new ExitRecorder()
            const env = EnvServerStart.Env(await EnvServerStart.Configuration(folder, { core: { idleTtlMs: 'soon' } }))
            await assert.rejects(ComponentStartConfiguration.ApplyOrExit({ Declaration: EnvServerComponent.Declaration, Env: env }, process))
            assert.equal(process.Code, 78)
            assert.match(process.Text, /^pragmatic-env-server: /)
        })
    })

    it('a platform-owned setting cannot be configured: the start is refused and the rendered value stays', async () =>
    {
        const platformOwned: Record<string, Record<string, unknown>>[] = [{ core: { port: 9090 } }, { database: { databaseUrl: 'secret:file/other-database' } }, { audit: { sink: 'none' } }]
        for (const options of platformOwned)
        {
            await EnvServerStart.InFolder(async folder =>
            {
                const process = new ExitRecorder()
                const env = EnvServerStart.Env(await EnvServerStart.Configuration(folder, options))
                await assert.rejects(ComponentStartConfiguration.ApplyOrExit({ Declaration: EnvServerComponent.Declaration, Env: env }, process))
                assert.equal(process.Code, 78, JSON.stringify(options))
                assert.equal(env.PRAGMATIC_PORT, '8080')
                assert.equal(env.PRAGMATIC_AUDIT_SINK, undefined)
            })
        }
    })

    it('every list setting reads the JSON array encoding', () =>
    {
        const lists = EnvServerComponent.Descriptor().Options.flatMap(o => o.Settings).filter(s => s.Type === SettingType.List)
        assert.deepEqual(lists, [], 'the env server declares no list setting (its two lists, origins and the pack script allowlist, are platform-owned)')
        // The readers of those lists still take what the start step writes, should one be declared again.
        const env = { ...EnvServerStart.Env('/none'), PRAGMATIC_ALLOWED_ORIGINS: '["https://a.example","https://b.example"]' }
        assert.deepEqual(ServerConfigLoader.Load(env, EnvServerStart.NoFile).allowedOrigins, ['https://a.example', 'https://b.example'])
    })

    for (const main of [EnvServerStart.ServerMain, EnvServerStart.WorkerMain])
    {
        it(`${main.endsWith('worker-main.ts') ? 'the worker' : 'the server'} applies its configuration first: an invalid one exits 78 before the settings are read`, { timeout: EnvServerStart.SpawnTimeoutMs }, async () =>
        {
            await EnvServerStart.InFolder(async folder =>
            {
                // No base folder: a main that read its settings before the configuration would fail on that instead (exit 1).
                const env = EnvServerStart.Env(await EnvServerStart.Configuration(folder, { core: { idleTtlMs: 'soon' } }))
                delete env.PRAGMATIC_BASE_DIR
                const run = await EnvServerStart.Run(main, env)
                assert.equal(run.Code, 78, run.Stderr)
                assert.match(run.Stderr, /pragmatic-env-server: /)
            })
        })
    }
})
