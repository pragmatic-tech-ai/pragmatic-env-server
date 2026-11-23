import { PgSession } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { EnvServerDatabase } from '../env-server-database.js'

/** Test databases for the env server: a fresh pg-mem database per call (the live cases use SqlTestSessions directly). */
export class EnvServerTestDatabase
{
    public static Mem(): EnvServerDatabase
    {
        return EnvServerDatabase.Over(new PgSession(SqlTestSessions.MemPool()))
    }
}
