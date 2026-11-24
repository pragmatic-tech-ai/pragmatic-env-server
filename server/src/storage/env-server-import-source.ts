import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'

/**
 * The pre-A5 data the import reads, through the storage the server kept it in: the base folder on the custom platform's
 * file storage, the object store of a cloud platform (whose identity folders held the sealed secrets and whose graph and
 * application folders held the registries). Read only: nothing here writes to the storage.
 */
export class EnvServerImportSource
{
    private static readonly Separator = '/'
    private static readonly Root = ''

    public constructor(private readonly storage: IStorage)
    {
    }

    public static Join(...segments: string[]): string
    {
        return segments.filter(segment => segment !== EnvServerImportSource.Root).join(EnvServerImportSource.Separator)
    }

    public Exists(path: string): Promise<boolean>
    {
        return this.storage.Exists(path)
    }

    public ReadText(path: string): Promise<string>
    {
        return this.storage.ReadText(path)
    }

    /** The parsed JSON file, or `absent` when there is none. */
    public async ReadJson<T>(path: string, absent: T): Promise<T>
    {
        return await this.storage.Exists(path) ? JSON.parse(await this.storage.ReadText(path)) as T : absent
    }

    /** The folder's subfolder names, sorted; none when the folder does not exist. */
    public async Folders(path: string): Promise<string[]>
    {
        return (await this.Entries(path)).filter(entry => entry.IsDirectory).map(entry => entry.Name).sort()
    }

    /** The folder's file names, sorted; none when the folder does not exist. */
    public async Files(path: string): Promise<string[]>
    {
        return (await this.Entries(path)).filter(entry => !entry.IsDirectory).map(entry => entry.Name).sort()
    }

    /** Copies the folder's files (not its subfolders) into a local folder. */
    public async CopyFilesInto(path: string, target: string): Promise<void>
    {
        mkdirSync(target, { recursive: true })
        for (const name of await this.Files(path))
        {
            writeFileSync(join(target, name), await this.storage.ReadBytes(EnvServerImportSource.Join(path, name)))
        }
    }

    private async Entries(path: string): Promise<readonly { Name: string; IsDirectory: boolean }[]>
    {
        try
        {
            return await this.storage.List(path)
        }
        catch (error)
        {
            // A folder that does not exist lists as empty (an object store lists a missing prefix as empty anyway), the
            // base folder included (a fresh deployment has none yet).
            if (!await this.ExistsQuietly(path))
            {
                return []
            }
            throw error
        }
    }

    private async ExistsQuietly(path: string): Promise<boolean>
    {
        try
        {
            return await this.storage.Exists(path)
        }
        catch
        {
            return false
        }
    }
}
