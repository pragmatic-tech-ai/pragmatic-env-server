import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { NodeFsStorage } from '@pragmatic-tech-ai/todl-runtime/node'
import { Grant, Realm, RealmKind, ResourceRef, type Role, type ResourceKind, type IdentityStoreSet } from '@pragmatic-tech-ai/pragmatic-identity'
import { FileAuditSink, FileIdentityStores, FileRealmConfigStore } from '@pragmatic-tech-ai/pragmatic-identity-store'
import { AuditCheckpoint } from '@pragmatic-tech-ai/pragmatic-identity-realm'
import { SqlAuditCheckpointStore, SqlMigrationTransactionRequiredError } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { GraphLoadedDto, SecurityChangesDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { DevGraphStore, type DevGraphRecord, type DevGraphRow } from '../host/graphs/dev-graph-store.js'
import { SecurityChangeLog, type SecurityChangeLogRecord } from '../host/environment/security-change-log.js'
import { PendingBackfillStore, type PendingBackfillRecord } from '../host/environment/pending-backfill-store.js'
import { PromoteRecordStore, type PromoteRecord } from '../host/environment/promote-record-store.js'
import type { ApplicationRecord } from '../host/apps/pragmatic-apps-registry.js'
import { PragmaticAppManifestParser, type PragmaticAppManifest } from '../host/apps/pragmatic-app-manifest.js'
import { SqlIdentityStoreSet } from '../platform/sql-identity-store-set.js'
import { EnvServerDatabase } from './env-server-database.js'
import { EnvServerImportReport } from './env-server-import-report.js'
import { EnvServerImportSource } from './env-server-import-source.js'
import { EnvServerRegistry } from './env-server-registry.js'
import { EnvironmentRecords } from './environment-records.js'

/** The database already holds records of an environment the import would write, and the import was not forced. */
export class EnvServerImportRefusedError extends Error
{
    private static readonly ErrorName = 'EnvServerImportRefusedError'
    private static readonly MessagePrefix = 'The env server database already holds records of '
    private static readonly MessageSuffix = '; run with --force to import over them.'
    private static readonly ListSeparator = ', '

    public constructor(public readonly NonEmpty: readonly string[])
    {
        super(EnvServerImportRefusedError.MessagePrefix + NonEmpty.join(EnvServerImportRefusedError.ListSeparator) + EnvServerImportRefusedError.MessageSuffix)
        this.name = EnvServerImportRefusedError.ErrorName
    }
}

/** The completion record of one environment's import, written last. */
export type EnvServerImportState = { id: string; importedAt: string }

/** A service token as the pre-A5 file store kept it (keyed by its hash). */
type FileTokenRecord = { tokenRef: string; principalId: string; realmId: string; scopes: string[]; expiresAt: string | null; revoked: boolean }

/** A role grant as the pre-A5 file store kept it. */
type FileGrantRecord = { subject: string; role: Role; resourceKind: ResourceKind; resourceRealmId: string; resourcePath: string[] }

/** A signed audit checkpoint as the pre-A5 file store kept it. */
type FileCheckpointRecord = { realmId: string; sequence: number; headHash: string; at: string; signature: string }

/** One environment's import: the database it writes (the import's transaction), whether an earlier import of it
 *  finished, and the report. */
export class EnvironmentImport
{
    private static readonly SkipSeparator = ': '

    public constructor(
        public readonly Database: EnvServerDatabase,
        public readonly EnvironmentId: string,
        /** A finished earlier import: the server may have run since, so the database is newer than the files. */
        public readonly Finished: boolean,
        public readonly Report: EnvServerImportReport)
    {
    }

    public Count(kind: string, n: number): void
    {
        this.Report.Count(this.EnvironmentId, kind, n)
    }

    public Skip(line: string): void
    {
        this.Report.Skipped.push(this.EnvironmentId + EnvironmentImport.SkipSeparator + line)
    }
}

/**
 * The one-time move of the env server's pre-A5 data into its database (A5 sub-task 5), read through the storage the
 * server kept it in (the base folder; a cloud platform's object store): for every environment folder
 * `<baseDir>/<environmentId>/` the identity stores (`identity/*.json`: accounts and groups, service tokens, role
 * grants, the IdP directory, the identity audit with its anchors, the realm configuration and the sealed secrets,
 * re-sealed under scope `env-server/<environmentId>`; a cloud platform kept only the secrets there), the graph
 * registries (`graphs/graphs.json`, `security-changes.json`, `pending-backfill.json`, `loaded-graph.json`) and the
 * applications' manifests and live pointers (`applications/<name>/{live,<version>/application.json}`, and the legacy
 * `<name>/application.json`, imported as not live). The blobs (packages, UI files, solutions) and the LMDB graph store
 * stay where they are. Not imported, on purpose: sessions (users sign in again) and the access audit JSONL (logs, kept
 * as files).
 *
 * The data is only read (the identity files through a private local copy, since the file stores rewrite legacy layouts
 * when they open); it stays as the backup. Each environment is imported in one transaction under an advisory lock, and
 * its completion record `pre-a5/<environmentId>` is written last, so a failed import is never mistaken for a finished
 * one and two replicas starting together import once (the one that waited for the lock finds it finished and writes
 * nothing). A start that fails one environment's import reports it and goes on; until an environment's import finished
 * no server has served it (EnvironmentRegistry refuses its open while IsPending), so a re-run adds whatever is missing.
 * Only the environment's own realm is imported: a token, grant or realm configuration of another realm in its files is
 * reported and skipped (the tables are shared by every environment). A forced re-run of a FINISHED environment never moves the
 * database back: it adds only documents and secrets that are absent and application versions the database lacks
 * (keeping its live pointers), and leaves identity rows and the audit alone (the server may have revoked, re-enabled or
 * recorded since). One unreadable record (an invalid realm configuration, an account whose email another account holds)
 * is reported and skipped, never blocking the start.
 */
export class EnvServerImport
{
    public static readonly StatePrefix = 'pre-a5/'
    public static readonly IdentityDir = 'identity'
    public static readonly GraphsDir = 'graphs'
    public static readonly ApplicationsDir = 'applications'
    public static readonly AccountsFile = 'accounts.json'
    public static readonly SecretsFile = 'secrets.json'
    public static readonly TokensFile = 'service-tokens.json'
    public static readonly SessionsFile = 'sessions.json'
    public static readonly GrantsFile = 'grants.json'
    public static readonly AuditFile = 'audit.json'
    public static readonly AnchorsFile = 'audit-anchors.json'
    public static readonly DirectoryFile = 'idp-directory.json'
    public static readonly RealmConfigFile = 'realm-config.json'
    public static readonly LegacyRealmConfigFile = 'tenant-config.json'
    public static readonly IdentityFiles: readonly string[] = [EnvServerImport.AccountsFile, EnvServerImport.SecretsFile, EnvServerImport.TokensFile, EnvServerImport.SessionsFile, EnvServerImport.GrantsFile, EnvServerImport.AuditFile, EnvServerImport.AnchorsFile, EnvServerImport.DirectoryFile, EnvServerImport.RealmConfigFile, EnvServerImport.LegacyRealmConfigFile]
    public static readonly DevGraphsFile = 'graphs.json'
    public static readonly SecurityChangesFile = 'security-changes.json'
    public static readonly PendingBackfillFile = 'pending-backfill.json'
    public static readonly LoadedGraphFile = 'loaded-graph.json'
    public static readonly GraphFiles: readonly string[] = [EnvServerImport.DevGraphsFile, EnvServerImport.SecurityChangesFile, EnvServerImport.PendingBackfillFile, EnvServerImport.LoadedGraphFile]
    public static readonly ManifestFile = 'application.json'
    public static readonly LivePointerFile = 'live'
    private static readonly Root = ''
    private static readonly HiddenPrefix = '.'
    private static readonly ModuleName = 'env-server-import'
    private static readonly GraphsRootKey = 'graphs'
    private static readonly TokensRootKey = 'records'
    private static readonly GrantsRootKey = 'grants'
    private static readonly AnchorsRootKey = 'checkpoints'
    private static readonly TempPrefix = 'env-server-import-'
    private static readonly Utf8 = 'utf8'
    private static readonly SessionsSkipped = 'sessions: not imported (users sign in again)'
    private static readonly AccessAuditSkipped = 'access audit JSONL: not imported (logs, kept as files)'
    private static readonly IdentityKept = 'identity: kept as the database holds it (the import finished earlier)'
    private static readonly AuditKept = 'audit: kept as the database holds it (its events do not continue the files)'
    private static readonly RealmConfigUnreadable = 'realm config unreadable, not imported: '
    private static readonly AccountRefused = 'account not imported: '
    private static readonly EmailTaken = ' (another account holds its email)'
    private static readonly TokenOtherRealm = 'service token not imported (another realm): '
    private static readonly GrantOtherRealm = 'grant not imported (on another realm): '
    private static readonly RealmConfigOtherRealm = 'realm config not imported (another realm): '
    private static readonly RealmSuffix = ' in '
    private static readonly ReasonSeparator = ' '
    private static readonly UnknownReason = 'UnknownError'
    private static readonly LockSql = 'SELECT pg_advisory_xact_lock($1::bigint)'
    private static readonly AuditRowsSql = 'SELECT COUNT(*) AS n FROM identity_audit WHERE realm_id = $1'
    private static readonly LockNamespace = 'env-server-import/'
    private static readonly InsertTokenSql = 'INSERT INTO identity_service_tokens (hash, token_ref, principal_id, realm_id, scopes, expires_at, revoked) SELECT $1, $2, $3, $4, $5, $6, $7 WHERE NOT EXISTS (SELECT 1 FROM identity_service_tokens WHERE hash = $1)'
    private static readonly FnvOffset = 0xcbf29ce484222325n
    private static readonly FnvPrime = 0x100000001b3n
    private static readonly Int64Mask = 0xffffffffffffffffn
    private static readonly Int64Sign = 0x8000000000000000n
    private static readonly Int64Range = 0x10000000000000000n
    private static readonly Accounts = 'accounts'
    private static readonly Groups = 'groups'
    private static readonly Secrets = 'secrets'
    private static readonly Tokens = 'service_tokens'
    private static readonly Grants = 'grants'
    private static readonly Directory = 'idp_directory'
    private static readonly RealmConfigs = 'realm_configs'
    private static readonly Audit = 'audit'
    private static readonly Anchors = 'audit_anchors'
    private static readonly DevGraphs = 'dev_graphs'
    private static readonly SecurityChanges = 'security_changes'
    private static readonly PendingBackfill = 'pending_backfill'
    private static readonly LoadedGraph = 'loaded_graph'
    private static readonly Applications = 'applications'
    private static readonly RecordedRegistries: readonly EnvServerRegistry[] = [EnvServerRegistry.DevGraphs, EnvServerRegistry.SecurityChanges, EnvServerRegistry.PendingBackfill, EnvServerRegistry.LoadedGraph, EnvServerRegistry.Applications]

    private readonly source: EnvServerImportSource

    /** `storage` is the base folder's storage (environment folders at its root). */
    public constructor(private readonly database: EnvServerDatabase, storage: IStorage, private readonly masterKey: Buffer)
    {
        this.source = new EnvServerImportSource(storage)
    }

    /** At start: imports every environment folder that holds pre-A5 data and has no completion record yet; undefined when
     *  there is nothing to import. */
    public async ImportIfPending(): Promise<EnvServerImportReport | undefined>
    {
        const pending: string[] = []
        for (const environmentId of await this.EnvironmentsWithFiles())
        {
            if (!await EnvServerImport.Finished(this.database, environmentId))
            {
                pending.push(environmentId)
            }
        }
        return pending.length === 0 ? undefined : this.Import(pending, false, true)
    }

    /** Imports every environment folder that holds pre-A5 data; refuses environments the database already holds records
     *  of unless forced (EnvServerImportRefusedError). */
    public async Run(force: boolean): Promise<EnvServerImportReport>
    {
        const environments = await this.EnvironmentsWithFiles()
        if (!force)
        {
            const nonEmpty: string[] = []
            for (const environmentId of environments)
            {
                if (await this.HoldsRecords(environmentId))
                {
                    nonEmpty.push(environmentId)
                }
            }
            if (nonEmpty.length > 0)
            {
                throw new EnvServerImportRefusedError(nonEmpty)
            }
        }
        return this.Import(environments, force, false)
    }

    /** Whether the environment holds pre-A5 files and no finished import (it must not be served: its records are not
     *  all in the database yet). */
    public IsPending(environmentId: string): Promise<boolean>
    {
        return EnvServerImport.PendingIn(this.database, this.source, environmentId)
    }

    /** IsPending without a master key (an environment's open checks it before anything else). */
    public static async PendingIn(database: EnvServerDatabase, source: EnvServerImportSource, environmentId: string): Promise<boolean>
    {
        return EnvServerImport.IsEnvironmentName(environmentId) && await EnvServerImport.HoldsFiles(source, environmentId) && !await EnvServerImport.Finished(database, environmentId)
    }

    /** The environment folders at the storage root that hold any file the import reads, by name. */
    public async EnvironmentsWithFiles(): Promise<string[]>
    {
        const result: string[] = []
        for (const name of await this.source.Folders(EnvServerImport.Root))
        {
            if (EnvServerImport.IsEnvironmentName(name) && await EnvServerImport.HoldsFiles(this.source, name))
            {
                result.push(name)
            }
        }
        return result
    }

    private static async HoldsFiles(source: EnvServerImportSource, folder: string): Promise<boolean>
    {
        const I = EnvServerImport
        const S = EnvServerImportSource
        const identity = await source.Files(S.Join(folder, I.IdentityDir))
        const graphs = await source.Files(S.Join(folder, I.GraphsDir))
        // Not the applications folder: its manifests and live pointers are the in-cluster unpacker's handoff files, written
        // after A5 too (ApplicationFiles; taken in at every start, PragmaticAppsRegistry.TakeUnpacked), so they do not
        // make an environment pre-A5. An environment with pre-A5 identity or graph files imports its applications too.
        return identity.some(file => I.IdentityFiles.includes(file))
            || graphs.some(file => I.GraphFiles.includes(file))
    }

    /** `forced`: re-import environments whose import finished (the CLI's --force); otherwise an environment another
     *  replica finished while this one waited for its lock is left alone. `continueOnFailure` (a start): one
     *  environment's failure is reported (`Failed`) and the others go on, and EnvironmentRegistry refuses only that
     *  environment's open; otherwise (the CLI) the first failure throws. */
    private async Import(environments: readonly string[], forced: boolean, continueOnFailure: boolean): Promise<EnvServerImportReport>
    {
        const report = new EnvServerImportReport()
        const session = this.database.Session
        if (session.Transaction === undefined)
        {
            throw new SqlMigrationTransactionRequiredError(EnvServerImport.ModuleName)
        }
        for (const environmentId of environments)
        {
            try
            {
                await session.Transaction(tx => this.ImportEnvironment(EnvServerDatabase.Over(tx), environmentId, report, forced))
            }
            catch (error)
            {
                if (!continueOnFailure)
                {
                    throw error
                }
                // Rolled back: no completion record, so the environment stays pending (and refused) until a start imports it.
                report.Fail(environmentId, EnvServerImport.NameOf(error))
            }
        }
        report.Skipped.push(EnvServerImport.SessionsSkipped, EnvServerImport.AccessAuditSkipped)
        return report
    }

    /** One environment, over the import's transaction: the lock, every step, the completion record last. */
    private async ImportEnvironment(database: EnvServerDatabase, environmentId: string, report: EnvServerImportReport, forced: boolean): Promise<void>
    {
        const I = EnvServerImport
        const S = EnvServerImportSource
        await database.Session.Query(I.LockSql, [I.LockKey(environmentId)])
        const finished = await I.Finished(database, environmentId)
        if (finished && !forced)
        {
            // Another replica imported it while this one waited for the lock: nothing to write, nothing to report.
            return
        }
        const run = new EnvironmentImport(database, environmentId, finished, report)
        await this.ImportIdentity(run, S.Join(environmentId, I.IdentityDir))
        const graphs = S.Join(environmentId, I.GraphsDir)
        await this.ImportDevGraphs(run, graphs)
        await this.ImportSecurityChanges(run, graphs)
        await this.ImportPendingBackfill(run, graphs)
        await this.ImportLoadedGraph(run, graphs)
        await this.ImportApplications(run, S.Join(environmentId, I.ApplicationsDir))
        const state = await database.Records<EnvServerImportState>(EnvServerRegistry.Import)
        await state.Put({ id: I.StatePrefix + environmentId, importedAt: new Date().toISOString() })
        report.Environments.push(environmentId)
    }

    /** The identity stores, read through a private local copy of the folder's files. */
    protected async ImportIdentity(run: EnvironmentImport, folder: string): Promise<void>
    {
        const I = EnvServerImport
        if ((await this.source.Files(folder)).length === 0)
        {
            return
        }
        const copy = mkdtempSync(join(tmpdir(), I.TempPrefix))
        try
        {
            await this.source.CopyFilesInto(folder, copy)
            const storage = new NodeFsStorage(copy)
            const files = await FileIdentityStores.Open(storage, this.masterKey)
            const set = await SqlIdentityStoreSet.Open(run.Database.Session)
            const target = set.For(run.EnvironmentId, await run.Database.Secrets(run.EnvironmentId, this.masterKey))
            run.Count(I.Secrets, await this.ImportSecrets(copy, files, target))
            if (run.Finished)
            {
                run.Skip(I.IdentityKept)
                return
            }
            const realm = new Realm(run.EnvironmentId, RealmKind.SelfHosted, run.EnvironmentId)
            run.Count(I.Accounts, await this.ImportAccounts(run, realm, files, target))
            run.Count(I.Groups, await this.ImportGroups(realm, files, target))
            run.Count(I.Tokens, await this.ImportTokens(run, copy))
            run.Count(I.Grants, await this.ImportGrants(run, copy, target))
            const snapshot = await files.IdpDirectory.Get(run.EnvironmentId)
            if (snapshot !== null && await target.IdpDirectory.Get(run.EnvironmentId) === null)
            {
                await target.IdpDirectory.Save(run.EnvironmentId, snapshot)
                run.Count(I.Directory, 1)
            }
            run.Count(I.RealmConfigs, await this.ImportRealmConfigs(run, storage, set))
            run.Count(I.Audit, await this.ImportAudit(run, await FileAuditSink.Open(storage), set))
            run.Count(I.Anchors, await this.ImportAnchors(run.Database.Session, copy, run.EnvironmentId))
        }
        finally
        {
            rmSync(copy, { recursive: true, force: true })
        }
    }

    /** Every sealed secret the database lacks, opened under the master key and re-sealed under the environment's scope. */
    private async ImportSecrets(copy: string, files: IdentityStoreSet, target: IdentityStoreSet): Promise<number>
    {
        let count = 0
        for (const reference of Object.keys(EnvServerImport.ReadLocalJson<Record<string, string>>(join(copy, EnvServerImport.SecretsFile), {})))
        {
            const secret = await files.Secrets.Get(reference)
            if (secret !== null && await target.Secrets.Get(reference) === null)
            {
                await target.Secrets.Put(reference, secret)
                count++
            }
        }
        return count
    }

    /** The accounts the database lacks (with their disabled state); one it refuses is reported and skipped. */
    private async ImportAccounts(run: EnvironmentImport, realm: Realm, files: IdentityStoreSet, target: IdentityStoreSet): Promise<number>
    {
        let count = 0
        for (const account of await files.Accounts.ListAccounts(realm))
        {
            if (await target.Accounts.FindByPrincipalId(realm, account.PrincipalId) !== null)
            {
                continue
            }
            // Checked first, not caught: a failed statement would abort the import's transaction.
            if (await target.Accounts.FindByEmail(realm, account.Email) !== null)
            {
                run.Skip(EnvServerImport.AccountRefused + account.PrincipalId + EnvServerImport.EmailTaken)
                continue
            }
            await target.Accounts.CreateAccount(realm, account.Email, account.PrincipalId, account.SecretRef)
            if (account.Disabled)
            {
                await target.Accounts.Disable(realm, account.PrincipalId)
            }
            count++
        }
        return count
    }

    /** The groups the database lacks, with their members. */
    private async ImportGroups(realm: Realm, files: IdentityStoreSet, target: IdentityStoreSet): Promise<number>
    {
        const existing = new Set((await target.Accounts.ListGroups(realm)).map(group => group.GroupId))
        let count = 0
        for (const group of await files.Accounts.ListGroups(realm))
        {
            if (existing.has(group.GroupId))
            {
                continue
            }
            await target.Accounts.CreateGroup(realm, group.GroupId, group.Name)
            for (const member of group.MemberIds)
            {
                await target.Accounts.AddMember(realm, group.GroupId, member)
            }
            count++
        }
        return count
    }

    /** The service tokens with their hashes (the file and SQL stores hash a token the same way), so issued tokens keep working. */
    private async ImportTokens(run: EnvironmentImport, copy: string): Promise<number>
    {
        const document = EnvServerImport.ReadLocalJson<Record<string, Record<string, FileTokenRecord>>>(join(copy, EnvServerImport.TokensFile), {})
        let count = 0
        for (const [hash, token] of Object.entries(document[EnvServerImport.TokensRootKey] ?? {}))
        {
            // The tables are shared by every environment: a token of another realm in this folder would act there.
            if (token.realmId !== run.EnvironmentId)
            {
                run.Skip(EnvServerImport.TokenOtherRealm + token.tokenRef + EnvServerImport.RealmSuffix + token.realmId)
                continue
            }
            count += await run.Database.Session.Execute(EnvServerImport.InsertTokenSql, [hash, token.tokenRef, token.principalId, token.realmId, JSON.stringify([...token.scopes]), token.expiresAt, token.revoked]) > 0 ? 1 : 0
        }
        return count
    }

    /** The role grants on this environment's resources the database lacks; a grant on another realm is skipped. */
    private async ImportGrants(run: EnvironmentImport, copy: string, target: IdentityStoreSet): Promise<number>
    {
        const document = EnvServerImport.ReadLocalJson<Record<string, FileGrantRecord[]>>(join(copy, EnvServerImport.GrantsFile), {})
        let count = 0
        for (const record of document[EnvServerImport.GrantsRootKey] ?? [])
        {
            if (record.resourceRealmId !== run.EnvironmentId)
            {
                run.Skip(EnvServerImport.GrantOtherRealm + record.subject + EnvServerImport.RealmSuffix + record.resourceRealmId)
                continue
            }
            const resource = new ResourceRef(record.resourceKind, record.resourceRealmId, [...record.resourcePath])
            const stored = await target.Grants.GrantsOn(resource)
            if (!stored.some(grant => grant.Subject === record.subject && grant.Role === record.role))
            {
                await target.Grants.Save(new Grant(record.subject, record.role, resource))
                count++
            }
        }
        return count
    }

    /** The environment's own realm configuration when the database lacks it; one of another realm, or an unreadable
     *  one, is reported and skipped. */
    private async ImportRealmConfigs(run: EnvironmentImport, storage: NodeFsStorage, set: SqlIdentityStoreSet): Promise<number>
    {
        const configs = await FileRealmConfigStore.Open(storage)
        let count = 0
        for (const realmId of await configs.List())
        {
            if (realmId !== run.EnvironmentId)
            {
                run.Skip(EnvServerImport.RealmConfigOtherRealm + realmId)
                continue
            }
            try
            {
                const config = await configs.Get(realmId)
                if (config !== null && await set.RealmConfig().Get(realmId) === null)
                {
                    await set.RealmConfig().Save(realmId, config)
                    count++
                }
            }
            catch (error)
            {
                run.Skip(EnvServerImport.RealmConfigUnreadable + realmId + EnvServerImport.ReasonSeparator + EnvServerImport.NameOf(error))
            }
        }
        return count
    }

    /**
     * The audit events in order after the ones an earlier part-failed import stored (the file and SQL stores chain
     * identically, so the stored events must be the files' first ones, hash for hash); stored events that do not
     * continue the files are kept and the files' events are not imported (reported).
     */
    private async ImportAudit(run: EnvironmentImport, files: FileAuditSink, set: SqlIdentityStoreSet): Promise<number>
    {
        const source = files.Records(run.EnvironmentId)
        const stored = set.Audit().Records(run.EnvironmentId)
        if (stored.length > source.length || stored.some((record, i) => record.Hash !== source[i]!.Hash))
        {
            run.Skip(EnvServerImport.AuditKept)
            return 0
        }
        for (const record of source.slice(stored.length))
        {
            await set.Audit().Record(record.Event)
        }
        return source.length - stored.length
    }

    /** The signed audit checkpoints beyond the newest one stored. */
    private async ImportAnchors(session: ISqlSession, copy: string, environmentId: string): Promise<number>
    {
        const document = EnvServerImport.ReadLocalJson<Record<string, FileCheckpointRecord[]>>(join(copy, EnvServerImport.AnchorsFile), {})
        const checkpoints = (document[EnvServerImport.AnchorsRootKey] ?? []).filter(c => c.realmId === environmentId).sort((a, b) => a.sequence - b.sequence)
        if (checkpoints.length === 0)
        {
            return 0
        }
        const store = await SqlAuditCheckpointStore.Open(session)
        const latest = (await store.Latest(environmentId))?.Sequence ?? -1
        const missing = checkpoints.filter(c => c.sequence > latest)
        for (const c of missing)
        {
            await store.Append(new AuditCheckpoint(c.realmId, c.sequence, c.headHash, c.at, c.signature))
        }
        return missing.length
    }

    /** The dev graphs the database lacks (one row per graph name). */
    protected async ImportDevGraphs(run: EnvironmentImport, folder: string): Promise<void>
    {
        const document = await this.source.ReadJson<Record<string, Record<string, DevGraphRecord>> | undefined>(EnvServerImportSource.Join(folder, EnvServerImport.DevGraphsFile), undefined)
        if (document === undefined)
        {
            return
        }
        const rows = new EnvironmentRecords<DevGraphRow>(run.Database, EnvServerRegistry.DevGraphs, run.EnvironmentId)
        for (const [name, graph] of Object.entries(document[EnvServerImport.GraphsRootKey] ?? {}))
        {
            if (await rows.Get(name) === undefined)
            {
                await rows.Put({ id: name, graph: DevGraphStore.Copy({ ...graph, name }) })
                run.Count(EnvServerImport.DevGraphs, 1)
            }
        }
    }

    /** The security change log, when the database holds none. */
    protected async ImportSecurityChanges(run: EnvironmentImport, folder: string): Promise<void>
    {
        const entries = await this.source.ReadJson<SecurityChangesDto[] | undefined>(EnvServerImportSource.Join(folder, EnvServerImport.SecurityChangesFile), undefined)
        const records = new EnvironmentRecords<SecurityChangeLogRecord>(run.Database, EnvServerRegistry.SecurityChanges, run.EnvironmentId)
        if (!Array.isArray(entries) || await records.Get(SecurityChangeLog.RecordKey) !== undefined)
        {
            return
        }
        const kept = entries.slice(0, SecurityChangeLog.MaxEntries)
        await records.Put({ id: SecurityChangeLog.RecordKey, entries: kept })
        run.Count(EnvServerImport.SecurityChanges, kept.length)
    }

    /** The owed backfills, added to what the database owes (a union: an owed concept is never dropped). */
    protected async ImportPendingBackfill(run: EnvironmentImport, folder: string): Promise<void>
    {
        const concepts = await this.source.ReadJson<string[] | undefined>(EnvServerImportSource.Join(folder, EnvServerImport.PendingBackfillFile), undefined)
        if (!Array.isArray(concepts))
        {
            return
        }
        const owed = concepts.filter(concept => typeof concept === 'string')
        await new PendingBackfillStore(new EnvironmentRecords<PendingBackfillRecord>(run.Database, EnvServerRegistry.PendingBackfill, run.EnvironmentId)).Add(owed)
        run.Count(EnvServerImport.PendingBackfill, new Set(owed).size)
    }

    /** The promote record, when the database holds none. */
    protected async ImportLoadedGraph(run: EnvironmentImport, folder: string): Promise<void>
    {
        const loaded = await this.source.ReadJson<GraphLoadedDto | undefined>(EnvServerImportSource.Join(folder, EnvServerImport.LoadedGraphFile), undefined)
        const records = new EnvironmentRecords<PromoteRecord>(run.Database, EnvServerRegistry.LoadedGraph, run.EnvironmentId)
        if (loaded === undefined || await records.Get(PromoteRecordStore.RecordKey) !== undefined)
        {
            return
        }
        await records.Put({ id: PromoteRecordStore.RecordKey, loaded })
        run.Count(EnvServerImport.LoadedGraph, 1)
    }

    /** Each application's version manifests and its live pointer (only when it names a version that has a manifest),
     *  merged into what the database holds: its versions and its live pointer win. */
    protected async ImportApplications(run: EnvironmentImport, folder: string): Promise<void>
    {
        const I = EnvServerImport
        const S = EnvServerImportSource
        const records = new EnvironmentRecords<ApplicationRecord>(run.Database, EnvServerRegistry.Applications, run.EnvironmentId)
        for (const name of await this.ApplicationNames(folder))
        {
            const appFolder = S.Join(folder, name)
            const versions: Record<string, PragmaticAppManifest> = {}
            for (const version of await this.source.Folders(appFolder))
            {
                const manifest = await this.ManifestAt(S.Join(appFolder, version, I.ManifestFile))
                if (manifest !== undefined && manifest.version === version && manifest.name === name)
                {
                    versions[version] = manifest
                }
            }
            const legacy = await this.ManifestAt(S.Join(appFolder, I.ManifestFile))
            if (legacy !== undefined && legacy.name === name && !Object.hasOwn(versions, legacy.version))
            {
                versions[legacy.version] = legacy
            }
            if (Object.keys(versions).length === 0)
            {
                continue
            }
            const pointer = S.Join(appFolder, I.LivePointerFile)
            const named = await this.source.Exists(pointer) ? (await this.source.ReadText(pointer)).trim() : I.Root
            const live = Object.hasOwn(versions, named) ? named : null
            await records.Update(name, current => ({ id: name, live: current?.live ?? live, versions: { ...versions, ...(current?.versions ?? {}) } }))
            run.Count(I.Applications, 1)
        }
    }

    /** Whether the database holds records of the environment: its completion record, accounts, audit or registry rows. */
    private async HoldsRecords(environmentId: string): Promise<boolean>
    {
        const I = EnvServerImport
        if (await I.Finished(this.database, environmentId))
        {
            return true
        }
        const set = await SqlIdentityStoreSet.Open(this.database.Session)
        const realm = new Realm(environmentId, RealmKind.SelfHosted, environmentId)
        if ((await set.For(environmentId, await this.database.Secrets(environmentId, this.masterKey)).Accounts.ListAccounts(realm)).length > 0)
        {
            return true
        }
        if (Number((await this.database.Session.Query(I.AuditRowsSql, [environmentId]))[0]?.n ?? 0) > 0)
        {
            return true
        }
        for (const registry of I.RecordedRegistries)
        {
            if ((await new EnvironmentRecords<{ id: string }>(this.database, registry, environmentId).List()).length > 0)
            {
                return true
            }
        }
        return false
    }

    private static async Finished(database: EnvServerDatabase, environmentId: string): Promise<boolean>
    {
        return await (await database.Records<EnvServerImportState>(EnvServerRegistry.Import)).Get(EnvServerImport.StatePrefix + environmentId) !== undefined
    }

    /** The application folders (any subfolder of `applications/` holding a manifest at either layout). */
    private async ApplicationNames(folder: string): Promise<string[]>
    {
        const I = EnvServerImport
        const S = EnvServerImportSource
        const result: string[] = []
        for (const name of await this.source.Folders(folder))
        {
            const appFolder = S.Join(folder, name)
            if ((await this.source.Files(appFolder)).includes(I.ManifestFile))
            {
                result.push(name)
                continue
            }
            for (const version of await this.source.Folders(appFolder))
            {
                if ((await this.source.Files(S.Join(appFolder, version))).includes(I.ManifestFile))
                {
                    result.push(name)
                    break
                }
            }
        }
        return result
    }

    /** A valid manifest file, or undefined when it is absent or invalid (an incomplete or corrupt version is skipped). */
    private async ManifestAt(path: string): Promise<PragmaticAppManifest | undefined>
    {
        if (!await this.source.Exists(path))
        {
            return undefined
        }
        try
        {
            return PragmaticAppManifestParser.Parse(await this.source.ReadText(path))
        }
        catch
        {
            return undefined
        }
    }

    /** A JSON file of the local identity copy, or `absent` when there is none. */
    private static ReadLocalJson<T>(file: string, absent: T): T
    {
        return existsSync(file) ? JSON.parse(readFileSync(file, EnvServerImport.Utf8)) as T : absent
    }

    /** An environment folder's name: not dot-led (`.postgres`, the server database's data on the volume; `.git`). */
    private static IsEnvironmentName(name: string): boolean
    {
        return name !== EnvServerImport.Root && !name.startsWith(EnvServerImport.HiddenPrefix)
    }

    private static NameOf(error: unknown): string
    {
        return error instanceof Error ? error.name : EnvServerImport.UnknownReason
    }

    /** A stable signed 64-bit advisory lock key for the environment's import (FNV-1a). */
    private static LockKey(environmentId: string): string
    {
        const I = EnvServerImport
        let hash = I.FnvOffset
        for (const byte of Buffer.from(I.LockNamespace + environmentId, I.Utf8))
        {
            hash = ((hash ^ BigInt(byte)) * I.FnvPrime) & I.Int64Mask
        }
        return String(hash >= I.Int64Sign ? hash - I.Int64Range : hash)
    }
}
