/** What one import of pre-A5 file data wrote: the environments it finished, rows per environment and kind, what it
 *  left out on purpose, and the environments whose import failed (rolled back, still pending: `<id>: <error name>`). */
export class EnvServerImportReport
{
    private static readonly KeySeparator = '.'

    public readonly Environments: string[] = []
    public readonly Counts = new Map<string, number>()
    public readonly Skipped: string[] = []
    public readonly Failed: string[] = []
    private static readonly FailSeparator = ': '

    /** Adds `n` rows of `kind` (accounts, grants, dev_graphs, ...) for `environmentId`. */
    public Count(environmentId: string, kind: string, n: number): void
    {
        const key = environmentId + EnvServerImportReport.KeySeparator + kind
        this.Counts.set(key, (this.Counts.get(key) ?? 0) + n)
    }

    /** The environment's import failed and was rolled back (`reason`: the error's name, never its message). */
    public Fail(environmentId: string, reason: string): void
    {
        this.Failed.push(environmentId + EnvServerImportReport.FailSeparator + reason)
    }

    public CountOf(environmentId: string, kind: string): number
    {
        return this.Counts.get(environmentId + EnvServerImportReport.KeySeparator + kind) ?? 0
    }

    public ToJson(): { environments: string[]; counts: Record<string, number>; skipped: string[]; failed: string[] }
    {
        return {
            environments: [...this.Environments].sort(),
            counts: Object.fromEntries([...this.Counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
            skipped: [...this.Skipped],
            failed: [...this.Failed],
        }
    }
}
