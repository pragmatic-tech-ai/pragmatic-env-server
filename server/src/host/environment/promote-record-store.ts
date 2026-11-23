import type { GraphLoadedDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import type { EnvironmentRecords } from '../../storage/environment-records.js'

/** The environment's one record in the loaded graph registry. */
export type PromoteRecord = { id: string; loaded: GraphLoadedDto }

/**
 * The promote record of a runtime environment: one record in the env server database (registry `env_loaded_graph`,
 * A5), the last promoted set (`graph/load`) as refs only. It is both the input of `graph/loaded` and the environment's
 * Promote delivery (ruling S3); it survives a restart, and a re-promote replaces it in one write.
 */
export class PromoteRecordStore
{
    /** The key of the environment's one promote record. */
    public static readonly RecordKey = 'loaded'

    public constructor(private readonly records: EnvironmentRecords<PromoteRecord>)
    {
    }

    public async Save(record: GraphLoadedDto): Promise<void>
    {
        await this.records.Put({ id: PromoteRecordStore.RecordKey, loaded: record })
    }

    /** The persisted record, or null when nothing was ever promoted. */
    public async Read(): Promise<GraphLoadedDto | null>
    {
        return (await this.records.Get(PromoteRecordStore.RecordKey))?.loaded ?? null
    }
}
