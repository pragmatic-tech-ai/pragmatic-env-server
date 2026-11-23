/** What one import of pre-A5 file data wrote: the environments it finished, rows per environment and kind, and what it
 *  left out on purpose. */
export class EnvServerImportReport
{
    private static readonly KeySeparator = '.'

    public readonly Environments: string[] = []
    public readonly Counts = new Map<string, number>()
    public readonly Skipped: string[] = []

    /** Adds `n` rows of `kind` (accounts, grants, dev_graphs, ...) for `environmentId`. */
    public Count(environmentId: string, kind: string, n: number): void
    {
        const key = environmentId + EnvServerImportReport.KeySeparator + kind
        this.Counts.set(key, (this.Counts.get(key) ?? 0) + n)
    }

    public CountOf(environmentId: string, kind: string): number
    {
        return this.Counts.get(environmentId + EnvServerImportReport.KeySeparator + kind) ?? 0
    }

    public ToJson(): { environments: string[]; counts: Record<string, number>; skipped: string[] }
    {
        return {
            environments: [...this.Environments].sort(),
            counts: Object.fromEntries([...this.Counts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
            skipped: [...this.Skipped],
        }
    }
}
