import { NodeStorageProviderRegistry } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import { CustomPlatform } from '../custom-platform.js'
import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import { EnvServerDatabase } from '../../storage/env-server-database.js'
import { EnvServerTestDatabase } from '../../storage/tests/env-server-test-database.js'

/** Test platforms: the custom platform over a fresh pg-mem env server database and file blob storage. */
export class CustomPlatformFixture
{
    /** The environment id a test server composed without identity keys its records by. */
    public static readonly EnvironmentId = 'env-under-test'

    public static Mem(): CustomPlatform
    {
        return new CustomPlatform(EnvServerTestDatabase.Mem(), new NodeStorageProviderRegistry())
    }

    /** The custom platform over `session` (SqlTestSessions: pg-mem, and live when PRAGMATIC_TEST_PG_URL is set). */
    public static Over(session: ISqlSession): CustomPlatform
    {
        return new CustomPlatform(EnvServerDatabase.Over(session), new NodeStorageProviderRegistry())
    }
}
