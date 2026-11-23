/** PRAGMATIC_AUDIT_SINK=file is refused: the env server's access audit goes to its database (A5), and the JSONL file
 *  sink is retired. */
export class AuditSinkRetiredError extends Error
{
    private static readonly ErrorName = 'AuditSinkRetiredError'
    private static readonly Text = 'PRAGMATIC_AUDIT_SINK=file is retired: the access audit is stored in the env server database (use sql, the default, or none)'

    public constructor()
    {
        super(AuditSinkRetiredError.Text)
        this.name = AuditSinkRetiredError.ErrorName
    }
}
