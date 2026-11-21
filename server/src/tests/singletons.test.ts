import assert from 'node:assert/strict'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'

/**
 * The packages that must be installed exactly once: TODL, todl-runtime, Mural and pragmatic-graph classes are checked
 * with `instanceof` across packages, so a second copy anywhere in the install (a nested node_modules) breaks them.
 */
class InstalledCopies
{
    public static readonly Singletons: readonly string[] = [
        '@pragmatic-tech-ai/todl',
        '@pragmatic-tech-ai/todl-runtime',
        '@pragmatic-tech-ai/mural',
        '@pragmatic-tech-ai/pragmatic-graph',
    ]
    public static readonly RepoRoot = join(import.meta.dirname, '..', '..', '..')
    private static readonly NodeModules = 'node_modules'
    private static readonly PackageJson = 'package.json'
    private static readonly ScopePrefix = '@'
    private static readonly HiddenPrefix = '.'
    private static readonly Utf8 = 'utf8'
    private static readonly ServerDir = 'server'
    private static readonly PackagesDir = 'packages'

    /**
     * Every installed package under the repository's node_modules folders (the root's and each workspace's), by package
     * name. Links (the workspaces' own entries in the root node_modules) are skipped: their folders are walked as roots.
     */
    public static ByName(): Map<string, string[]>
    {
        const found = new Map<string, string[]>()
        for (const modules of InstalledCopies.ModuleRoots())
        {
            InstalledCopies.Walk(modules, found)
        }
        return found
    }

    private static ModuleRoots(): string[]
    {
        const C = InstalledCopies
        const roots = [join(C.RepoRoot, C.NodeModules), join(C.RepoRoot, C.ServerDir, C.NodeModules)]
        const packages = join(C.RepoRoot, C.PackagesDir)
        for (const name of existsSync(packages) ? readdirSync(packages) : [])
        {
            roots.push(join(packages, name, C.NodeModules))
        }
        return roots.filter(dir => existsSync(dir))
    }

    private static Walk(dir: string, found: Map<string, string[]>): void
    {
        const C = InstalledCopies
        for (const entry of readdirSync(dir))
        {
            if (entry.startsWith(C.HiddenPrefix))
            {
                continue
            }
            const path = join(dir, entry)
            if (entry.startsWith(C.ScopePrefix))
            {
                for (const scoped of readdirSync(path))
                {
                    C.Visit(join(path, scoped), found)
                }
                continue
            }
            C.Visit(path, found)
        }
    }

    private static Visit(packageDir: string, found: Map<string, string[]>): void
    {
        const C = InstalledCopies
        const manifest = join(packageDir, C.PackageJson)
        if (lstatSync(packageDir).isSymbolicLink() || !existsSync(manifest))
        {
            return
        }
        const name = (JSON.parse(readFileSync(manifest, C.Utf8)) as { name?: string }).name
        if (name !== undefined)
        {
            found.set(name, [...(found.get(name) ?? []), packageDir])
        }
        const nested = join(packageDir, C.NodeModules)
        if (existsSync(nested))
        {
            C.Walk(nested, found)
        }
    }
}

describe('installed singletons', () =>
{
    const copies = InstalledCopies.ByName()
    for (const name of InstalledCopies.Singletons)
    {
        it(`one installed copy of ${name}`, () =>
        {
            assert.deepEqual(copies.get(name)?.length, 1, `${name}: ${JSON.stringify(copies.get(name) ?? [])}`)
        })
    }
})
