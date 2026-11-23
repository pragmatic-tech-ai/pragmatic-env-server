import type { EnvironmentRecords } from '../../storage/environment-records.js'

export type PackageRef = { id: string; version: string }

/** Slices are keyed by stable solution id; each holds that solution's contributed package refs. */
export type DevGraphRecord = { name: string; description: string; slices: Record<string, PackageRef[]>; createdAt: string }

/** One graph's row in the dev graphs registry (keyed by graph name). */
export type DevGraphRow = { id: string; graph: DevGraphRecord }

/** Persistent store of a dev environment's graph records: one record per graph name in the env server database (registry
 *  `env_dev_graphs`, A5). `Load` reads the environment's graphs into memory; reads return defensive copies so callers
 *  cannot mutate persisted state; Put and Remove write through. */
export class DevGraphStore
{
    private readonly records = new Map<string, DevGraphRecord>()

    public constructor(private readonly rows: EnvironmentRecords<DevGraphRow>)
    {
    }

    public async Load(): Promise<void>
    {
        const rows = await this.rows.List()
        this.records.clear()
        for (const row of rows)
        {
            this.records.set(row.id, DevGraphStore.Copy(row.graph))
        }
    }

    public List(): readonly DevGraphRecord[]
    {
        return [...this.records.values()].map(r => DevGraphStore.Copy(r))
    }

    public Get(name: string): DevGraphRecord | undefined
    {
        const record = this.records.get(name)
        return record === undefined ? undefined : DevGraphStore.Copy(record)
    }

    public async Put(record: DevGraphRecord): Promise<void>
    {
        await this.rows.Put({ id: record.name, graph: DevGraphStore.Copy(record) })
        this.records.set(record.name, DevGraphStore.Copy(record))
    }

    public async Remove(name: string): Promise<void>
    {
        await this.rows.Delete(name)
        this.records.delete(name)
    }

    /** A deep copy holding only the record's fields. */
    public static Copy(record: DevGraphRecord): DevGraphRecord
    {
        const slices: Record<string, PackageRef[]> = {}
        for (const [solutionId, refs] of Object.entries(record.slices ?? {}))
        {
            slices[solutionId] = refs.map(p => ({ id: p.id, version: p.version }))
        }
        return { name: record.name, description: record.description, slices, createdAt: record.createdAt }
    }
}
