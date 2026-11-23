import type { ServerConfig } from '@pragmatic-tech-ai/pragmatic-env-cluster'
import type { ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import type { PlatformServices } from '../platform/platform-services.js'
import { EnvServerImport } from '../storage/env-server-import.js'
import type { EnvServerImportReport } from '../storage/env-server-import-report.js'

/** The pre-A5 import a server or worker runs at start, before its environments open: the data the platform kept under
 *  the base folder (files on the custom platform; the object store of a cloud platform, whose identity folders held the
 *  sealed secrets) moves into the database once. */
export class EnvServerStartImport
{
    private static readonly ImportedLine = 'imported pre-A5 file data into the env server database'
    private static readonly EventKey = 'event'
    private static readonly ImportEvent = 'pre-a5-import'
    private static readonly ReportKey = 'report'

    public static async Run(config: ServerConfig, platform: PlatformServices, logger: ILogger): Promise<EnvServerImportReport | undefined>
    {
        const report = await new EnvServerImport(platform.Database, platform.CreateStorage(config.baseDir), platform.ResolveMasterKey(config.masterKey)).ImportIfPending()
        if (report !== undefined)
        {
            logger.Info(EnvServerStartImport.ImportedLine, { [EnvServerStartImport.EventKey]: EnvServerStartImport.ImportEvent, [EnvServerStartImport.ReportKey]: report.ToJson() })
        }
        return report
    }
}
