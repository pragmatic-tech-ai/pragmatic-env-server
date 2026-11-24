import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { PragmaticAppManifestParser, type PragmaticAppManifest } from './pragmatic-app-manifest.js'

/** One application's live version as its files name it: the `live` pointer and the manifest of that version. */
export type ApplicationFilesLive = { version: string; manifest: PragmaticAppManifest }

/**
 * The on-disk handoff between the env server and the in-cluster UI unpacker (pragmatic-ui-unpack), in an environment's
 * applications storage: `<name>/<version>/application.json` and `<name>/live`. The unpacker (an init container, before
 * the server starts) writes a new version there and reads the live manifest's packages from there (a UI-only deploy
 * keeps the app's data packages); the server takes what it wrote into its database at start
 * (PragmaticAppsRegistry.TakeUnpacked) and mirrors every version it commits back (so the unpacker reads what is live).
 * The database is the record (A5); these files are only the unpacker's contract. Read failures answer nothing.
 */
export class ApplicationFiles
{
    public static readonly ManifestFile = 'application.json'
    public static readonly LiveFile = 'live'
    private static readonly Separator = '/'
    private static readonly Root = ''
    private static readonly JsonIndent = 2

    public constructor(private readonly storage: IStorage)
    {
    }

    /** The application folders, sorted; none when the storage holds none. */
    public async Names(): Promise<string[]>
    {
        try
        {
            return (await this.storage.List(ApplicationFiles.Root)).filter(entry => entry.IsDirectory).map(entry => entry.Name).sort()
        }
        catch
        {
            return []
        }
    }

    /** The version `<name>/live` names with its valid manifest (its own name and version), or undefined. */
    public async Live(name: string): Promise<ApplicationFilesLive | undefined>
    {
        const F = ApplicationFiles
        try
        {
            const pointer = F.Join(name, F.LiveFile)
            if (!await this.storage.Exists(pointer))
            {
                return undefined
            }
            const version = (await this.storage.ReadText(pointer)).trim()
            if (!PragmaticAppManifestParser.IsSafeSegment(version))
            {
                return undefined
            }
            const path = F.Join(name, version, F.ManifestFile)
            if (!await this.storage.Exists(path))
            {
                return undefined
            }
            const manifest = PragmaticAppManifestParser.Parse(await this.storage.ReadText(path))
            return manifest.name === name && manifest.version === version ? { version, manifest } : undefined
        }
        catch
        {
            return undefined
        }
    }

    /** Writes the version's manifest, then the live pointer (the unpacker's order: the pointer is the commit point). */
    public async Write(manifest: PragmaticAppManifest): Promise<void>
    {
        const F = ApplicationFiles
        await this.storage.WriteText(F.Join(manifest.name, manifest.version, F.ManifestFile), JSON.stringify(manifest, null, F.JsonIndent))
        await this.storage.WriteText(F.Join(manifest.name, F.LiveFile), manifest.version)
    }

    private static Join(...segments: string[]): string
    {
        return segments.join(ApplicationFiles.Separator)
    }
}
