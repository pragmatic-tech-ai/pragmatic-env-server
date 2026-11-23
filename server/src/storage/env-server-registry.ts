/** The record registries of the env server's database: each is one `records_<registry>` table (SqlRecordStore), its
 *  rows keyed `<environmentId>/<key>` (EnvironmentRecords) except the import completion records. */
export enum EnvServerRegistry
{
    /** A development environment's graphs (one record per graph name). */
    DevGraphs = 'env_dev_graphs',
    /** The security change log (one record per environment, newest first, at most 50 entries). */
    SecurityChanges = 'env_security_changes',
    /** The concepts whose ownership backfill is still owed (one record per environment). */
    PendingBackfill = 'env_pending_backfill',
    /** A runtime environment's last promoted graph set (one record per environment). */
    LoadedGraph = 'env_loaded_graph',
    /** The applications of an environment: manifests per version and the live pointer (one record per application). */
    Applications = 'env_applications',
    /** The pre-A5 file data imports, one completion record per environment (`pre-a5/<environmentId>`). */
    Import = 'env_server_import',
}
