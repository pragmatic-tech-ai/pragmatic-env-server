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
import { EnvServerStartConfiguration } from '../env-server-start-configuration.js'
import { EnvServerTuningBounds } from '../env-server-tuning-bounds.js'

type Options = Record<string, Record<string, unknown>>

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
    /** The 0.1.1 descriptor (A5.4), whose image never read its configuration. */
    public static readonly OldDigest = 'sha256:4ffdd3b2e19fd5a6ad36d651c6906298019c3686782f26104f98e5c2ebff48a8'
    private static readonly FileName = 'configuration.json'
    private static readonly Realm = 'acme'
    private static readonly ImportFlag = '--import'
    private static readonly Tsx = 'tsx'
    private static readonly Utf8 = 'utf8'
    /** Long enough for a cold tsx compile of either main on the hive; the child is killed after it. */
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

    /** The applied form the console writes: the authored `options` validated against this descriptor, defaults filled. */
    public static async Configuration(folder: string, options: Options): Promise<string>
    {
        const d = EnvServerComponent.Descriptor()
        const applied = AppliedConfiguration.From({ Scope: { Realm: EnvServerStart.Realm, Component: d.Name }, Number: 1, ComponentVersion: d.Version, DescriptorDigest: d.ContentDigest(), Document: { options } }, d)
        return EnvServerStart.Write(folder, applied)
    }

    /** A file as written, without validation (an invalid document, or one validated for another descriptor). */
    public static async Raw(folder: string, options: Options, componentVersion: string = EnvServerComponent.Version, digest: string = EnvServerComponent.Descriptor().ContentDigest()): Promise<string>
    {
        return EnvServerStart.Write(folder, new AppliedConfiguration(EnvServerStart.Realm, EnvServerComponent.Name, 3, componentVersion, digest, { options } as never))
    }

    /** Starts `main` with `env` only (no inherited variables) and waits for it to exit, killing it at the timeout. */
    public static Run(main: string, env: NodeJS.ProcessEnv): Promise<MainRun>
    {
        return new Promise((resolve, reject) =>
        {
            const child = spawn(process.execPath, [EnvServerStart.ImportFlag, EnvServerStart.Tsx, main], { env: { ...env, PATH: process.env.PATH }, cwd: EnvServerStart.Here })
            const timer = setTimeout(() => child.kill(), EnvServerStart.SpawnTimeoutMs - 5000)
            let stderr = ''
            child.stderr.setEncoding(EnvServerStart.Utf8)
            child.stderr.on('data', (chunk: string) => { stderr += chunk })
            child.stdout.resume()
            child.on('error', error => { clearTimeout(timer); reject(error) })
            child.on('exit', code => { clearTimeout(timer); resolve(new MainRun(code, stderr)) })
        })
    }

    private static async Write(folder: string, applied: AppliedConfiguration): Promise<string>
    {
        const path = join(folder, EnvServerStart.FileName)
        await writeFile(path, applied.ToCanonicalJson())
        return path
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
                rateLimit: { environmentRps: '5', environmentBurst: 10 },
            }))
            env.PRAGMATIC_IDLE_TTL_MS = '1000'
            const report = await EnvServerStartConfiguration.ApplyOrExit(env, new ExitRecorder(), EnvServerStart.NoFile)
            const config = ServerConfigLoader.Load(env, EnvServerStart.NoFile)
            assert.equal(report.Version, 1)
            assert.deepEqual([config.idleTtlMs, config.wsResilience?.heartbeatIntervalMs, config.pagingMaxPageSize], [600000, 15000, 500])
            assert.equal(env.PRAGMATIC_RATELIMIT_ENVIRONMENT_RPS, '5')
        })
    })

    it('the defaults an applied document carries load as the loader own defaults (a touched option pins nothing)', async () =>
    {
        await EnvServerStart.InFolder(async folder =>
        {
            const every = Object.fromEntries(EnvServerComponent.Descriptor().Options.map(o => [o.Name, {}]))
            const env = EnvServerStart.Env(await EnvServerStart.Configuration(folder, every))
            const rendered = { ...env }
            const report = await EnvServerStartConfiguration.ApplyOrExit(env, new ExitRecorder(), EnvServerStart.NoFile)
            assert.ok(report.Settings.length > 0, 'the defaults were written')
            assert.deepEqual(ServerConfigLoader.Load(env, EnvServerStart.NoFile), ServerConfigLoader.Load(rendered, EnvServerStart.NoFile))
        })
    })

    it('no configuration starts as before', async () =>
    {
        const env = EnvServerStart.Env('/no/such/configuration.json')
        env.PRAGMATIC_IDLE_TTL_MS = '1000'
        const before = { ...env }
        assert.equal((await EnvServerStartConfiguration.ApplyOrExit(env, new ExitRecorder(), EnvServerStart.NoFile)).Applied, false)
        assert.deepEqual(env, before)
        assert.equal(ServerConfigLoader.Load(env, EnvServerStart.NoFile).idleTtlMs, 1000)
    })

    it('an invalid configuration exits with the start error code 78 and the reason', async () =>
    {
        await EnvServerStart.InFolder(async folder =>
        {
            const exits = new ExitRecorder()
            const env = EnvServerStart.Env(await EnvServerStart.Raw(folder, { core: { idleTtlMs: 'soon' } }))
            await assert.rejects(EnvServerStartConfiguration.ApplyOrExit(env, exits, EnvServerStart.NoFile))
            assert.equal(exits.Code, 78)
            assert.match(exits.Text, /^pragmatic-env-server: .*\(invalid\)\n$/)
        })
    })

    it('a platform-owned setting cannot be configured: the start is refused and the rendered value stays', async () =>
    {
        const platformOwned: Options[] = [
            { core: { port: 9090 } },
            { core: { baseDir: '/elsewhere' } },
            { core: { allowedOrigins: ['https://evil.example'] } },
            { database: { databaseUrl: 'secret:file/other-database' } },
            { audit: { sink: 'none' } },
            { observability: { otlpEndpoint: 'https://collector.example' } },
            { observability: { metricsPort: 9464 } },
            { webSocket: { readIdleMs: 1000 } },
            { adapterPacks: { scriptAllowlist: ['a'] } },
        ]
        for (const options of platformOwned)
        {
            await EnvServerStart.InFolder(async folder =>
            {
                const exits = new ExitRecorder()
                const env = EnvServerStart.Env(await EnvServerStart.Raw(folder, options))
                const rendered = { ...env }
                await assert.rejects(EnvServerStartConfiguration.ApplyOrExit(env, exits, EnvServerStart.NoFile))
                assert.equal(exits.Code, 78, JSON.stringify(options))
                assert.deepEqual(env, rendered, JSON.stringify(options))
            })
        }
    })

    it('a configured timing out of its bound exits 78: no spinning sweep or heartbeat, no drain past the grace period', async () =>
    {
        const outOfBound: Options[] = [
            { core: { idleSweepMs: 0 } },
            { core: { idleSweepMs: 3000000000 } },
            { core: { idleTtlMs: -1 } },
            { core: { drainTimeoutMs: 60000 } },
            { webSocket: { heartbeatMs: 3000000000 } },
            { webSocket: { heartbeatMs: 10 } },
            { webSocket: { backpressureGraceMs: 0 } },
        ]
        for (const options of outOfBound)
        {
            await EnvServerStart.InFolder(async folder =>
            {
                const exits = new ExitRecorder()
                const env = EnvServerStart.Env(await EnvServerStart.Configuration(folder, options))
                await assert.rejects(EnvServerStartConfiguration.ApplyOrExit(env, exits, EnvServerStart.NoFile))
                assert.equal(exits.Code, 78, JSON.stringify(options))
                assert.match(exits.Text, /is out of range: accepted/, JSON.stringify(options))
            })
        }
        assert.deepEqual(EnvServerTuningBounds.Bounded(), ['core.idleTtlMs', 'core.idleSweepMs', 'core.drainTimeoutMs', 'webSocket.heartbeatMs', 'webSocket.backpressureGraceMs'])
    })

    it('the bounds are the edges: the smallest and largest accepted values start', async () =>
    {
        await EnvServerStart.InFolder(async folder =>
        {
            const env = EnvServerStart.Env(await EnvServerStart.Configuration(folder, {
                core: { idleSweepMs: 1000, idleTtlMs: EnvServerTuningBounds.LargestTimerMs, drainTimeoutMs: EnvServerTuningBounds.LongestDrainMs },
                webSocket: { heartbeatMs: 1000, backpressureGraceMs: 1 },
            }))
            assert.equal((await EnvServerStartConfiguration.ApplyOrExit(env, new ExitRecorder(), EnvServerStart.NoFile)).Applied, true)
        })
    })

    it('a configured value the settings loader refuses exits 78 with its reason, not 1 later', async () =>
    {
        const refusedByLoader: Options[] = [
            { rateLimit: { environmentRps: '5' } },
            { rateLimit: { principalRps: 'fast', principalBurst: 3 } },
            { paging: { pageSizeDefault: 900, pageSizeMax: 100 } },
            { webSocket: { backpressureSoftBytes: 0 } },
        ]
        for (const options of refusedByLoader)
        {
            await EnvServerStart.InFolder(async folder =>
            {
                const exits = new ExitRecorder()
                const env = EnvServerStart.Env(await EnvServerStart.Configuration(folder, options))
                assert.doesNotThrow(() => ServerConfigLoader.Load(EnvServerStart.Env('/none'), EnvServerStart.NoFile), 'the rendered environment loads')
                await assert.rejects(EnvServerStartConfiguration.ApplyOrExit(env, exits, EnvServerStart.NoFile))
                assert.equal(exits.Code, 78, JSON.stringify(options))
                assert.match(exits.Text, /^pragmatic-env-server: .*\(invalid\)\n$/, JSON.stringify(options))
            })
        }
    })

    it('a rendered environment the loader refuses stays the platform failure: the start step passes it on', async () =>
    {
        await EnvServerStart.InFolder(async folder =>
        {
            const env = EnvServerStart.Env(await EnvServerStart.Configuration(folder, { core: { idleTtlMs: 600000 } }))
            delete env.PRAGMATIC_BASE_DIR
            const exits = new ExitRecorder()
            assert.equal((await EnvServerStartConfiguration.ApplyOrExit(env, exits, EnvServerStart.NoFile)).Applied, true)
            assert.equal(exits.Code, undefined)
            assert.throws(() => ServerConfigLoader.Load(env, EnvServerStart.NoFile))
        })
    })

    it('an applied file validated for 0.1.1 (never read by any image) with no entry for this version starts as rendered, saying so', async () =>
    {
        await EnvServerStart.InFolder(async folder =>
        {
            const exits = new ExitRecorder()
            const env = EnvServerStart.Env(await EnvServerStart.Raw(folder, { core: { baseDir: '/typed', masterKey: 'secret:file/k' } }, '0.1.1', EnvServerStart.OldDigest))
            const rendered = { ...env }
            const report = await EnvServerStartConfiguration.ApplyOrExit(env, exits, EnvServerStart.NoFile)
            assert.equal(report.Applied, false)
            assert.equal(exits.Code, undefined)
            assert.deepEqual(env, rendered)
            assert.match(exits.Text, /^pragmatic-env-server: started without the applied configuration: version 3 was validated for 0\.1\.1, /)
        })
    })

    it('an applied file for another descriptor of a version that reads its configuration still refuses the start (descriptor-mismatch)', async () =>
    {
        await EnvServerStart.InFolder(async folder =>
        {
            const exits = new ExitRecorder()
            const env = EnvServerStart.Env(await EnvServerStart.Raw(folder, { core: { idleTtlMs: 1000 } }, '0.1.3', 'sha256:' + 'a'.repeat(64)))
            await assert.rejects(EnvServerStartConfiguration.ApplyOrExit(env, exits, EnvServerStart.NoFile))
            assert.equal(exits.Code, 78)
            assert.match(exits.Text, /\(descriptor-mismatch\)\n$/)
        })
    })

    it('every list setting reads the JSON array encoding', () =>
    {
        const lists = EnvServerComponent.Descriptor().Options.flatMap(o => o.Settings).filter(s => s.Type === SettingType.List)
        assert.deepEqual(lists, [], 'the env server declares no list setting (its two lists, origins and the pack script allowlist, are platform-owned)')
        // The readers of those lists still take what the start step writes, should one be declared again.
        const env = { ...EnvServerStart.Env('/none'), PRAGMATIC_ALLOWED_ORIGINS: '["https://a.example","https://b.example"]' }
        assert.deepEqual(ServerConfigLoader.Load(env, EnvServerStart.NoFile).allowedOrigins, ['https://a.example', 'https://b.example'])
    })

    it('the shared start step and the env server agree on the exit code', () =>
    {
        assert.equal(ComponentStartConfiguration.ExitCode, 78)
    })

    for (const main of [EnvServerStart.ServerMain, EnvServerStart.WorkerMain])
    {
        const which = main.endsWith('worker-main.ts') ? 'the worker' : 'the server'
        it(`${which} applies its configuration first: an invalid one exits 78 before the settings are read`, { timeout: EnvServerStart.SpawnTimeoutMs }, async () =>
        {
            await EnvServerStart.InFolder(async folder =>
            {
                // No base folder: a main that read its settings before the configuration would fail on that instead (exit 1).
                const env = EnvServerStart.Env(await EnvServerStart.Raw(folder, { core: { idleTtlMs: 'soon' } }))
                delete env.PRAGMATIC_BASE_DIR
                const run = await EnvServerStart.Run(main, env)
                assert.equal(run.Code, 78, run.Stderr)
                assert.match(run.Stderr, /pragmatic-env-server: /)
            })
        })

        it(`${which} exits 78 on a configured value its loader refuses`, { timeout: EnvServerStart.SpawnTimeoutMs }, async () =>
        {
            await EnvServerStart.InFolder(async folder =>
            {
                const env = EnvServerStart.Env(await EnvServerStart.Configuration(folder, { rateLimit: { environmentRps: '5' } }))
                const run = await EnvServerStart.Run(main, env)
                assert.equal(run.Code, 78, run.Stderr)
            })
        })
    }
})
