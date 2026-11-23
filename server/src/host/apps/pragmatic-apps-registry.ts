import type { EnvironmentRecords } from '../../storage/environment-records.js'
import { PragmaticAppManifestParser, type PragmaticAppManifest } from './pragmatic-app-manifest.js'
import { PragmaticApplication } from './pragmatic-application.js'

export interface PragmaticAppSummary
{
    name: string
    version: string
}

/** One application's record in the env server database (registry `env_applications`, A5): the manifest of every
 *  ingested version and the live pointer (null: no version is live). */
export type ApplicationRecord = { id: string; live: string | null; versions: Record<string, PragmaticAppManifest> }

/**
 * An environment's applications: manifests and live pointers from its records in the env server database, the UI blobs
 * from its applications storage (`<name>/<version>/ui/...`). `Commit` is the deploy's one write: it adds the version's
 * manifest and moves the live pointer to it together, so a crash before it leaves the previous live version serving and
 * no manifest of the new one. A stored manifest is re-validated on every read (fail closed).
 */
export class PragmaticAppsRegistry
{
    private static readonly SeparatorPattern = /[\\/:]/
    private static readonly ControlCharPattern = /[\u0000-\u001f\u007f]/
    private static readonly DotsOnlyPattern = /^\.+$/
    private static readonly EdgeDotOrSpacePattern = /^\.|[. ]$/
    private static readonly ReservedDevicePattern = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
    private static readonly ExtensionSeparator = '.'
    private static readonly InvalidNameError = 'invalid application name: '
    private static readonly NotFoundError = 'application not found: '

    public constructor(private readonly records: EnvironmentRecords<ApplicationRecord>)
    {
    }

    /** The live applications' names and versions, by name. */
    public async List(): Promise<readonly PragmaticAppSummary[]>
    {
        return (await this.LiveApplications()).map(app => ({ name: app.Manifest.name, version: app.Manifest.version }))
    }

    /**
     * The applications whose live pointer names a version that has a valid manifest, by name: the apps an environment
     * delivers (ruling S3). An app with no live version, or a pointer naming a missing or invalid manifest, is not live.
     */
    public async LiveApplications(): Promise<readonly PragmaticApplication[]>
    {
        const result: PragmaticApplication[] = []
        for (const record of await this.records.List())
        {
            const app = PragmaticAppsRegistry.LiveOf(record)
            if (app !== undefined)
            {
                result.push(app)
            }
        }
        return result
    }

    /**
     * The application `name` when its live pointer names a version that has a manifest (what `application/open` binds,
     * ruling S7); undefined for an invalid name and an unknown or not-live app.
     */
    public async LiveApplicationFor(name: string): Promise<PragmaticApplication | undefined>
    {
        if (!PragmaticAppsRegistry.IsValidName(name))
        {
            return undefined
        }
        const record = await this.records.Get(name)
        return record === undefined ? undefined : PragmaticAppsRegistry.LiveOf(record)
    }

    /** The live application `name`; throws for an invalid name and an unknown or not-live app. */
    public async ApplicationFor(name: string): Promise<PragmaticApplication>
    {
        PragmaticAppsRegistry.AssertValidName(name)
        const app = await this.LiveApplicationFor(name)
        if (app === undefined)
        {
            throw new Error(PragmaticAppsRegistry.NotFoundError + name)
        }
        return app
    }

    /** The version the live pointer of `name` names, or undefined. */
    public async LiveVersion(name: string): Promise<string | undefined>
    {
        return (await this.records.Get(name))?.live ?? undefined
    }

    /** The stored manifest of `name@version`, or undefined when that version was never committed. */
    public async ManifestOf(name: string, version: string): Promise<PragmaticAppManifest | undefined>
    {
        const record = await this.records.Get(name)
        return record !== undefined && Object.hasOwn(record.versions ?? {}, version) ? record.versions[version] : undefined
    }

    /** The commit of a deploy: adds `manifest` as its version and moves the live pointer to it, in one write. */
    public async Commit(manifest: PragmaticAppManifest): Promise<void>
    {
        await this.records.Update(manifest.name, current => ({
            id: manifest.name,
            live: manifest.version,
            versions: { ...(current?.versions ?? {}), [manifest.version]: manifest },
        }))
    }

    /**
     * Rejects names that are empty, dots-only (`.`, `..`, `...`), dot-leading (`.git`), end in a dot or space, are Windows
     * reserved device names (`CON`, `NUL`, `COM1`, ... with or without an extension), contain a path separator, or contain a control / non-printable character (below U+0020, DEL).
     * Shared with the app ingest (package ids, versions, every UI path segment).
     */
    public static AssertValidName(name: string): void
    {
        if (!PragmaticAppsRegistry.IsValidName(name))
        {
            throw new Error(PragmaticAppsRegistry.InvalidNameError + name)
        }
    }

    private static IsValidName(name: string): boolean
    {
        return !(name === '' || PragmaticAppsRegistry.DotsOnlyPattern.test(name) || PragmaticAppsRegistry.EdgeDotOrSpacePattern.test(name)
            || PragmaticAppsRegistry.ReservedDevicePattern.test(name.split(PragmaticAppsRegistry.ExtensionSeparator)[0]!) || PragmaticAppsRegistry.SeparatorPattern.test(name)
            || PragmaticAppsRegistry.ControlCharPattern.test(name))
    }

    /** The record's live application, re-validated; undefined when no valid version is live. */
    private static LiveOf(record: ApplicationRecord): PragmaticApplication | undefined
    {
        const version = record.live
        if (typeof version !== 'string' || !PragmaticAppsRegistry.IsValidName(version) || !Object.hasOwn(record.versions ?? {}, version))
        {
            return undefined
        }
        try
        {
            const manifest = PragmaticAppManifestParser.Parse(JSON.stringify(record.versions[version]))
            // Serving builds the UI path from the manifest: it must be the record's own app and live version.
            return manifest.name === record.id && manifest.version === version ? new PragmaticApplication(manifest) : undefined
        }
        catch
        {
            // A corrupt stored manifest must not abort listing: the app is not live.
            return undefined
        }
    }
}
