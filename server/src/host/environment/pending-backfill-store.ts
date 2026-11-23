import { StructuredLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import type { EnvironmentRecords } from '../../storage/environment-records.js'

/** Where the store reports a malformed pending list (listed as empty; the next write replaces it). */
export interface IPendingBackfillDiagnostics
{
    Unreadable(error: unknown): void
}

/** Reports a malformed pending list as one warning on the server logger, by error name only. */
export class LoggerPendingBackfillDiagnostics implements IPendingBackfillDiagnostics
{
    private static readonly Line = 'pending ownership backfill list malformed; listed as empty: '
    private static readonly UnknownName = 'UnknownError'

    public constructor(private readonly logger: ILogger = StructuredLogger.ToStdout())
    {
    }

    public Unreadable(error: unknown): void
    {
        this.logger.Warn(LoggerPendingBackfillDiagnostics.Line + (error instanceof Error ? error.name : LoggerPendingBackfillDiagnostics.UnknownName))
    }
}

/** The stored pending list is not a list of concept names. */
class MalformedPendingBackfillError extends Error
{
    private static readonly ErrorName = 'MalformedPendingBackfillError'
    private static readonly Text = 'the pending backfill list is not a list of concept names'

    public constructor()
    {
        super(MalformedPendingBackfillError.Text)
        this.name = MalformedPendingBackfillError.ErrorName
    }
}

/** The environment's one record in the pending backfill registry: the owed concept names, sorted and unique. */
export type PendingBackfillRecord = { id: string; concepts: string[] }

/**
 * The concepts whose ownership backfill is still owed (S4 Task 13, PR16): one record in the env server database
 * (registry `env_pending_backfill`, A5), a sorted unique list of concept names. A delivery adds its newly owned concepts
 * BEFORE its persist step, so a crash or a lost lease between the persist and the backfill cannot lose them: whichever
 * server opens the environment next resumes them. A concept leaves the list once its backfill committed, or when an open
 * finds the catalog it launches does not own it (left by a delivery whose persist step failed). Every change is one
 * optimistic Update of the record (concurrent writers, also on other workers, all land). A malformed record lists as
 * empty (reported, error name only) and the next write replaces it, so a corrupt list never blocks a delivery; a
 * database read error propagates (the delivery rejects before persisting, the backfill reports and retries), so a list
 * that could not be read is never overwritten.
 */
export class PendingBackfillStore
{
    /** The key of the environment's one pending record. */
    public static readonly RecordKey = 'pending'

    public constructor(private readonly records: EnvironmentRecords<PendingBackfillRecord>, private readonly diagnostics: IPendingBackfillDiagnostics = new LoggerPendingBackfillDiagnostics())
    {
    }

    public Add(concepts: readonly string[]): Promise<void>
    {
        return this.Change(pending => [...new Set([...pending, ...concepts])])
    }

    public Remove(concepts: readonly string[]): Promise<void>
    {
        const removed = new Set(concepts)
        return this.Change(pending => pending.filter(concept => !removed.has(concept)))
    }

    /** Keeps only the owed concepts `owned` holds (the catalog an open launches). */
    public Retain(owned: ReadonlySet<string>): Promise<void>
    {
        return this.Change(pending => pending.filter(concept => owned.has(concept)))
    }

    /**
     * The owed concepts; empty when none were ever recorded or the stored content is malformed (reported). A database
     * read error propagates (fail closed): a valid list is never overwritten because it could not be read.
     */
    public async List(): Promise<string[]>
    {
        return this.ConceptsOf(await this.records.Get(PendingBackfillStore.RecordKey))
    }

    /** Writes `next(pending)` sorted, unless it equals what is stored (re-computed on the latest record when written). */
    private async Change(next: (pending: readonly string[]) => string[]): Promise<void>
    {
        const pending = this.ConceptsOf(await this.records.Get(PendingBackfillStore.RecordKey))
        if (PendingBackfillStore.Same(pending, next(pending).sort()))
        {
            return
        }
        await this.records.Update(PendingBackfillStore.RecordKey, current => ({ id: PendingBackfillStore.RecordKey, concepts: next(this.ConceptsOf(current)).sort() }))
    }

    private static Same(a: readonly string[], b: readonly string[]): boolean
    {
        return a.length === b.length && a.every((concept, i) => concept === b[i])
    }

    private ConceptsOf(record: PendingBackfillRecord | undefined): string[]
    {
        if (record === undefined)
        {
            return []
        }
        if (!Array.isArray(record.concepts) || !record.concepts.every(concept => typeof concept === 'string'))
        {
            this.diagnostics.Unreadable(new MalformedPendingBackfillError())
            return []
        }
        return [...record.concepts].sort()
    }
}
