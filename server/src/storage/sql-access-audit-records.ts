import type { ISqlSession } from '@pragmatic-tech-ai/todl'
import type { AuditEvent, IAuditSink } from '@pragmatic-tech-ai/pragmatic-identity'
import { SqlMigration, SqlMigrationModule, SqlMigrationRunner } from '@pragmatic-tech-ai/pragmatic-realm-adapters'

/** Schema of the env server's access audit. */
export class SqlAccessAuditMigrations extends SqlMigrationModule
{
    private static readonly V1 = new SqlMigration(1, [
        'CREATE TABLE env_access_audit (id bigserial PRIMARY KEY, realm_id text NOT NULL, kind integer NOT NULL, principal_id text, at timestamptz NOT NULL, detail text NOT NULL)',
        'CREATE INDEX env_access_audit_realm_at ON env_access_audit (realm_id, at)',
    ])

    public readonly Name = 'env.access_audit'

    public Migrations(): readonly SqlMigration[]
    {
        return [SqlAccessAuditMigrations.V1]
    }
}

/**
 * The env server's access audit (every RPC, upgrade and HTTP decision, one row each, realm = environment id): an
 * append-only table of its own, apart from the hash-chained identity audit, so the high-volume access log is never
 * loaded into memory, chained or anchored (the identity audit keeps sign-ins and admin actions). Every worker of a
 * deployment appends to it independently; rows are logs, never read back by the server.
 */
export class SqlAccessAuditRecords implements IAuditSink
{
    private static readonly InsertSql = 'INSERT INTO env_access_audit (realm_id, kind, principal_id, at, detail) VALUES ($1, $2, $3, $4, $5)'

    private constructor(private readonly session: ISqlSession)
    {
    }

    public static async Open(session: ISqlSession): Promise<SqlAccessAuditRecords>
    {
        await SqlMigrationRunner.Run(session, new SqlAccessAuditMigrations())
        return new SqlAccessAuditRecords(session)
    }

    public async Record(event: AuditEvent): Promise<void>
    {
        await this.session.Execute(SqlAccessAuditRecords.InsertSql, [event.RealmId, event.Kind, event.PrincipalId, event.At, JSON.stringify([...event.Detail])])
    }
}
