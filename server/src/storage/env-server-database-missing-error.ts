/** The env server's database URL setting is missing or blank: every record it keeps lives in its own Postgres (A5),
 *  so it refuses to start without one. */
export class EnvServerDatabaseMissingError extends Error
{
    private static readonly ErrorName = 'EnvServerDatabaseMissingError'
    private static readonly Text = 'PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE must name the file holding the env server database URL'

    public constructor()
    {
        super(EnvServerDatabaseMissingError.Text)
        this.name = EnvServerDatabaseMissingError.ErrorName
    }
}
