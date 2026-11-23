import type { SqlRecordStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import type { EnvServerDatabase } from './env-server-database.js'
import type { EnvServerRegistry } from './env-server-registry.js'

/** An Update callback changed the record's key. */
export class EnvironmentRecordKeyChangedError extends Error
{
    private static readonly ErrorName = 'EnvironmentRecordKeyChangedError'
    private static readonly Text = 'an environment record update must keep its key'

    public constructor()
    {
        super(EnvironmentRecordKeyChangedError.Text)
        this.name = EnvironmentRecordKeyChangedError.ErrorName
    }
}

/**
 * One environment's records in a registry of the env server's database: the registry's SqlRecordStore is shared by
 * every environment of the process, and this view stores its records under `<environmentId>/<key>` (environment ids
 * hold no `/`), so two environments' records in one registry never mix. Keys go in and come out without the prefix.
 * Update is the store's optimistic read-modify-write (re-run on a concurrent write, also across workers); a mutate
 * returning undefined deletes.
 */
export class EnvironmentRecords<T extends { id: string }>
{
    private static readonly Separator = '/'

    private readonly prefix: string

    public constructor(private readonly database: EnvServerDatabase, private readonly registry: EnvServerRegistry, environmentId: string)
    {
        this.prefix = environmentId + EnvironmentRecords.Separator
    }

    /** The view, with its registry opened (and migrated) first. */
    public static async Open<T extends { id: string }>(database: EnvServerDatabase, registry: EnvServerRegistry, environmentId: string): Promise<EnvironmentRecords<T>>
    {
        const records = new EnvironmentRecords<T>(database, registry, environmentId)
        await records.Store()
        return records
    }

    public async Get(key: string): Promise<T | undefined>
    {
        const record = await (await this.Store()).Get(this.prefix + key)
        return record === undefined ? undefined : this.Out(record)
    }

    /** This environment's records, ordered by key. */
    public async List(): Promise<readonly T[]>
    {
        return (await (await this.Store()).List()).filter(record => record.id.startsWith(this.prefix)).map(record => this.Out(record))
    }

    public async Put(record: T): Promise<void>
    {
        await (await this.Store()).Put(this.In(record))
    }

    public async Update(key: string, mutate: (current: T | undefined) => T | undefined | Promise<T | undefined>): Promise<T | undefined>
    {
        const updated = await (await this.Store()).Update(this.prefix + key, async current =>
        {
            const next = await mutate(current === undefined ? undefined : this.Out(current))
            if (next === undefined)
            {
                return undefined
            }
            if (next.id !== key)
            {
                throw new EnvironmentRecordKeyChangedError()
            }
            return this.In(next)
        })
        return updated === undefined ? undefined : this.Out(updated)
    }

    public async Delete(key: string): Promise<boolean>
    {
        return (await this.Store()).Delete(this.prefix + key)
    }

    private Store(): Promise<SqlRecordStore<T>>
    {
        return this.database.Records<T>(this.registry)
    }

    private In(record: T): T
    {
        return { ...record, id: this.prefix + record.id }
    }

    private Out(record: T): T
    {
        return { ...record, id: record.id.slice(this.prefix.length) }
    }
}
