import type { SecurityChangesDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { StructuredLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import type { EnvironmentRecords } from '../../storage/environment-records.js'

/** The environment's one record in the security change log registry. */
export type SecurityChangeLogRecord = { id: string; entries: SecurityChangesDto[] }

/** Where the change log reports what it never throws: a malformed record and an append that did not land. */
export interface ISecurityChangeLogDiagnostics
{
    Unreadable(error: unknown): void
    AppendFailed(error: unknown): void
}

/** Reports each event as one line on the server logger, by error name only (messages can carry paths). */
export class LoggerSecurityChangeLogDiagnostics implements ISecurityChangeLogDiagnostics
{
    private static readonly UnreadableLine = 'security change log unreadable; listed as empty: '
    private static readonly AppendLine = 'security change log entry not written: '
    private static readonly UnknownName = 'UnknownError'

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public Unreadable(error: unknown): void
    {
        this.logger.Warn(LoggerSecurityChangeLogDiagnostics.UnreadableLine + LoggerSecurityChangeLogDiagnostics.NameOf(error))
    }

    public AppendFailed(error: unknown): void
    {
        this.logger.Error(LoggerSecurityChangeLogDiagnostics.AppendLine + LoggerSecurityChangeLogDiagnostics.NameOf(error))
    }

    private static NameOf(error: unknown): string
    {
        return error instanceof Error ? error.name : LoggerSecurityChangeLogDiagnostics.UnknownName
    }
}

/** The stored log is not a list of entries. */
class MalformedSecurityChangeLogError extends Error
{
    private static readonly ErrorName = 'MalformedSecurityChangeLogError'
    private static readonly Text = 'the security change log is not a list'

    public constructor()
    {
        super(MalformedSecurityChangeLogError.Text)
        this.name = MalformedSecurityChangeLogError.ErrorName
    }
}

/**
 * The environment's security change log (S4 Task 13, PR14): one record in the env server database (registry
 * `env_security_changes`, A5), the security changes of the last `MaxEntries` deploys and promotes that changed any, newest
 * first, for tenant-admin's change log. `Append` is called with a non-empty diff only; it prepends through the record
 * store's optimistic Update (so concurrent appends from several workers all land) and drops the oldest entries beyond
 * `MaxEntries`. The log is a record, never a gate: a malformed record lists as empty (reported), and an append that fails
 * (including a database error, which never overwrites the history) is reported, not thrown (a deploy whose setting is
 * already pruned is not failed by its log). Survives a restart.
 */
export class SecurityChangeLog
{
    public static readonly MaxEntries = 50
    /** The key of the environment's one log record. */
    public static readonly RecordKey = 'log'

    public constructor(private readonly records: EnvironmentRecords<SecurityChangeLogRecord>, private readonly diagnostics: ISecurityChangeLogDiagnostics = new LoggerSecurityChangeLogDiagnostics())
    {
    }

    /** Prepends `entry`; a failure is reported (AppendFailed), never thrown. */
    public async Append(entry: SecurityChangesDto): Promise<void>
    {
        try
        {
            await this.records.Update(SecurityChangeLog.RecordKey, current => ({ id: SecurityChangeLog.RecordKey, entries: [entry, ...this.EntriesOf(current)].slice(0, SecurityChangeLog.MaxEntries) }))
        }
        catch (error)
        {
            this.diagnostics.AppendFailed(error)
        }
    }

    /**
     * The logged changes, newest first; empty when nothing was ever logged or the stored record is malformed
     * (reported). A database read error propagates.
     */
    public async List(): Promise<SecurityChangesDto[]>
    {
        return this.EntriesOf(await this.records.Get(SecurityChangeLog.RecordKey))
    }

    /** The record's entries; a malformed record is reported and reads as empty (the next append replaces it). */
    private EntriesOf(record: SecurityChangeLogRecord | undefined): SecurityChangesDto[]
    {
        if (record === undefined)
        {
            return []
        }
        if (!Array.isArray(record.entries))
        {
            this.diagnostics.Unreadable(new MalformedSecurityChangeLogError())
            return []
        }
        return record.entries
    }
}
