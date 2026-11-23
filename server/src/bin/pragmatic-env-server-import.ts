import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { MasterKeyRef } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { MasterKeyResolver } from '../identity/master-key-resolver.js'
import { EnvServerDatabase } from '../storage/env-server-database.js'
import { EnvServerImport, EnvServerImportRefusedError } from '../storage/env-server-import.js'

/** What the command line asked for. */
export class EnvServerImportArguments
{
    public constructor(public readonly BaseDir: string, public readonly Force: boolean)
    {
    }
}

/** The master key setting is missing (the import re-seals the environments' secrets under it). */
export class EnvServerImportMasterKeyMissingError extends Error
{
    private static readonly ErrorName = 'EnvServerImportMasterKeyMissingError'
    private static readonly Text = 'PRAGMATIC_MASTER_KEY_FILE (or PRAGMATIC_MASTER_KEY_B64_ENV) must name the master key'

    public constructor()
    {
        super(EnvServerImportMasterKeyMissingError.Text)
        this.name = EnvServerImportMasterKeyMissingError.ErrorName
    }
}

/**
 * The import of the env server's pre-A5 file data into its Postgres database, run inside the env server image:
 * `node dist/bin/pragmatic-env-server-import.js --base-dir /data [--force]`. The server and its workers also import by
 * themselves at start (EnvServerImport.ImportIfPending); this command is for dev data and a forced re-run. The database
 * is the server's own (PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE), the master key its own (PRAGMATIC_MASTER_KEY_FILE, or
 * PRAGMATIC_MASTER_KEY_B64_ENV naming a variable). The base folder is only read. Prints what it wrote as JSON; exits 2 on
 * a usage error, 3 when the database already holds records of an environment (pass --force to import over them), 1 on
 * any other failure (its message never carries a secret).
 */
export class EnvServerImportBin
{
    public static readonly BaseDirFlag = '--base-dir'
    public static readonly ForceFlag = '--force'
    public static readonly UsageExit = 2
    public static readonly RefusedExit = 3
    public static readonly FailedExit = 1
    private static readonly MasterKeyFileEnvVar = 'PRAGMATIC_MASTER_KEY_FILE'
    private static readonly MasterKeyB64EnvVar = 'PRAGMATIC_MASTER_KEY_B64_ENV'
    private static readonly Usage = 'usage: pragmatic-env-server-import --base-dir <folder> [--force]   (PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE names the database, PRAGMATIC_MASTER_KEY_FILE the master key)'
    private static readonly FailurePrefix = 'pragmatic-env-server-import: '
    private static readonly ArgumentsStart = 2
    private static readonly Blank = ''

    /** The parsed arguments, or undefined when they are not `--base-dir <folder> [--force]`. */
    public static Parse(argv: readonly string[]): EnvServerImportArguments | undefined
    {
        const B = EnvServerImportBin
        let baseDir: string | undefined
        let force = false
        for (let i = 0; i < argv.length; i++)
        {
            const arg = argv[i] as string
            if (arg === B.ForceFlag)
            {
                force = true
            }
            else if (arg === B.BaseDirFlag && i + 1 < argv.length && baseDir === undefined)
            {
                baseDir = argv[++i] as string
            }
            else
            {
                return undefined
            }
        }
        return baseDir === undefined || baseDir.trim() === B.Blank ? undefined : new EnvServerImportArguments(resolve(baseDir), force)
    }

    /** Runs the import; answers the process exit code. `database` replaces the one the environment names (tests). */
    public static async Run(argv: readonly string[], env: NodeJS.ProcessEnv, out: (line: string) => void = console.log, err: (line: string) => void = console.error, database?: EnvServerDatabase): Promise<number>
    {
        const B = EnvServerImportBin
        const args = B.Parse(argv)
        if (args === undefined)
        {
            err(B.Usage)
            return B.UsageExit
        }
        let opened: EnvServerDatabase | undefined
        try
        {
            const masterKey = MasterKeyResolver.Resolve(B.MasterKeyRefOf(env))
            opened = database ?? await EnvServerDatabase.Open(env)
            const report = await new EnvServerImport(opened, new NodeFsStorage(args.BaseDir), masterKey).Run(args.Force)
            out(JSON.stringify(report.ToJson()))
            return 0
        }
        catch (e)
        {
            err(B.FailurePrefix + (e instanceof Error ? e.message : String(e)))
            return e instanceof EnvServerImportRefusedError ? B.RefusedExit : B.FailedExit
        }
        finally
        {
            if (database === undefined)
            {
                await opened?.Close()
            }
        }
    }

    private static MasterKeyRefOf(env: NodeJS.ProcessEnv): MasterKeyRef
    {
        const B = EnvServerImportBin
        const file = env[B.MasterKeyFileEnvVar]?.trim() ?? B.Blank
        if (file !== B.Blank)
        {
            return { keyFilePath: file }
        }
        const variable = env[B.MasterKeyB64EnvVar]?.trim() ?? B.Blank
        if (variable !== B.Blank)
        {
            return { base64Env: variable }
        }
        throw new EnvServerImportMasterKeyMissingError()
    }

    public static IsEntryPoint(): boolean
    {
        return process.argv[1] !== undefined && fileURLToPath(import.meta.url) === resolve(process.argv[1])
    }

    public static async Main(): Promise<void>
    {
        process.exitCode = await EnvServerImportBin.Run(process.argv.slice(EnvServerImportBin.ArgumentsStart), process.env)
    }
}

if (EnvServerImportBin.IsEntryPoint())
{
    await EnvServerImportBin.Main()
}
