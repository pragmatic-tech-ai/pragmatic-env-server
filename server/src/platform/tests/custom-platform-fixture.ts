import { NodeStorageProviderRegistry } from '@pragmatic-tech-ai/pragmatic-realm-custom'
import { CustomPlatform } from '../custom-platform.js'
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
}
