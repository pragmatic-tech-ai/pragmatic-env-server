import type { EnvironmentRecords } from '../../storage/environment-records.js'
import { NullLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'
import type { ApplicationFiles } from './application-files.js'
import { PragmaticAppManifestParser, type PragmaticAppManifest } from './pragmatic-app-manifest.js'
import { PragmaticApplication } from './pragmatic-application.js'

/** A deploy of name@version lost to another writer: the version is committed (or claimed) with other content, or is
 *  already live. Versions are immutable. */
export class AppVersionConflictError extends Error
{
    /** The reason a refused deploy answers (the ingest's in-memory checks answer the same). */
    public static readonly Message = 'this application version is already deployed; versions are immutable'
    private static readonly ErrorName = 'AppVersionConflictError'

    public constructor()
    {
        super(AppVersionConflictError.Message)
        this.name = AppVersionConflictError.ErrorName
    }
}

/** An ingest's claim on a version it is about to write the UI files of: the digest of its manifest and files, and when
 *  it was made (a claim older than PragmaticAppsRegistry.ClaimTtlMs is a crashed attempt's and may be replaced). */
export type ApplicationClaim = { digest: string; at: string }

export interface PragmaticAppSummary
{
    name: string
    version: string
}

/** One application's record in the env server database (registry `env_applications`, A5): the manifest of every
 *  ingested version and the live pointer (null: no version is live); `unpacked`, the version the handoff files'
 *  `live` pointer named when the server last took them in or mirrored them (ApplicationFiles); `claims`, the versions
 *  an ingest is writing the UI files of (by content digest, removed at its commit). */
export type ApplicationRecord = { id: string; live: string | null; versions: Record<string, PragmaticAppManifest>; unpacked?: string; claims?: Record<string, ApplicationClaim> }

/**
 * An environment's applications: manifests and live pointers from its records in the env server database, the UI blobs
 * from its applications storage (`<name>/<version>/ui/...`). `Commit` is the deploy's one write: it adds the version's
 * manifest and moves the live pointer to it together, so a crash before it leaves the previous live version serving and
 * no manifest of the new one. A stored manifest is re-validated on every read (fail closed).
 *
 * Versions are immutable across workers too: an ingest first claims the version with the digest of its content
 * (`Claim`, before it writes any UI file), and the commit re-checks inside the optimistic update, so of two writers of
 * one name@version exactly one commits and the other gets AppVersionConflictError, never a mix of their files. A failed
 * attempt releases its claim; a crashed one's expires after ClaimTtlMs.
 *
 * `TakeUnpacked` refuses a version the database committed with other content (immutable): an unpacker roll back to an
 * older version rewrites its manifest with the current packages, so such a roll back is refused and logged (redeploy
 * it as a new version).
 *
 * With the applications' handoff files (ApplicationFiles: the in-cluster UI unpacker's contract), `TakeUnpacked` takes a
 * version the unpacker made live into the database at start, and every commit mirrors the live manifest back.
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
    private static readonly ArrayOpen = '['
    private static readonly ArrayClose = ']'
    private static readonly ObjectOpen = '{'
    private static readonly ObjectClose = '}'
    private static readonly JsonComma = ','
    private static readonly JsonColon = ':'
    /** How long a claim holds against another digest: longer than any ingest's UI write, so only a crashed attempt's
     *  claim (its worker died before the commit or the release) is ever replaced. */
    public static readonly ClaimTtlMs = 15 * 60_000
    private static readonly MirrorFailedLine = 'the live application manifest could not be mirrored to the unpacker handoff files: '
    private static readonly UnknownErrorName = 'UnknownError'

    public constructor(private readonly records: EnvironmentRecords<ApplicationRecord>, private readonly files?: ApplicationFiles, private readonly logger: ILogger = new NullLogger())
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

    /**
     * Claims name@version for an ingest about to write its UI files: refused (AppVersionConflictError) when the version is
     * committed already or claimed with other content (`digest`); a claim with the same digest (a resumed attempt) holds.
     */
    public async Claim(manifest: PragmaticAppManifest, digest: string): Promise<void>
    {
        await this.records.Update(manifest.name, current =>
        {
            const claim = current?.claims?.[manifest.version]
            if ((current !== undefined && Object.hasOwn(current.versions ?? {}, manifest.version)) || (claim !== undefined && claim.digest !== digest && !PragmaticAppsRegistry.Expired(claim)))
            {
                throw new AppVersionConflictError()
            }
            const record = current ?? { id: manifest.name, live: null, versions: {} }
            return { ...record, claims: { ...(record.claims ?? {}), [manifest.version]: { digest, at: new Date().toISOString() } } }
        })
    }

    /** Drops the ingest's claim on name@version (its attempt failed before the commit); another digest's claim is kept. */
    public async ReleaseClaim(manifest: PragmaticAppManifest, digest: string): Promise<void>
    {
        await this.records.Update(manifest.name, current =>
        {
            if (current === undefined || current.claims?.[manifest.version]?.digest !== digest)
            {
                return current
            }
            const claims = { ...current.claims }
            delete claims[manifest.version]
            return PragmaticAppsRegistry.WithoutEmptyClaims({ ...current, claims })
        })
    }

    /**
     * The commit of a deploy: adds `manifest` as its version and moves the live pointer to it, in one write, re-checking
     * immutability inside it (another writer may have committed since the caller looked): a version already live, one
     * committed with other content, or one claimed under another digest is refused (AppVersionConflictError). A version
     * committed with the same content and not live (a resume, or a redeploy of an older version) moves the pointer back.
     * Then the live manifest is mirrored to the handoff files.
     */
    public async Commit(manifest: PragmaticAppManifest, digest?: string): Promise<void>
    {
        const R = PragmaticAppsRegistry
        await this.records.Update(manifest.name, current =>
        {
            const versions = current?.versions ?? {}
            if (Object.hasOwn(versions, manifest.version) && (current?.live === manifest.version || R.Canonical(versions[manifest.version]) !== R.Canonical(manifest)))
            {
                throw new AppVersionConflictError()
            }
            const claim = current?.claims?.[manifest.version]
            if (claim !== undefined && claim.digest !== digest && !PragmaticAppsRegistry.Expired(claim))
            {
                throw new AppVersionConflictError()
            }
            const claims = { ...(current?.claims ?? {}) }
            delete claims[manifest.version]
            return R.WithoutEmptyClaims({ ...(current ?? {}), id: manifest.name, live: manifest.version, versions: { ...versions, [manifest.version]: manifest }, claims })
        })
        await this.MirrorLive(manifest.name)
    }

    /**
     * At start: every application whose handoff files name a live version the database has not taken yet (`unpacked`
     * differs) gets that version committed and made live (the in-cluster unpacker rolled a new UI release). A file
     * pointer the database took already never moves it back, so a later deploy through the server wins until the
     * unpacker writes a new version. A version committed with other content is refused (immutable), reported and left.
     * Answers the names taken and the names refused.
     */
    public async TakeUnpacked(): Promise<{ Taken: string[]; Refused: string[] }>
    {
        const R = PragmaticAppsRegistry
        const result = { Taken: [] as string[], Refused: [] as string[] }
        if (this.files === undefined)
        {
            return result
        }
        for (const name of await this.files.Names())
        {
            const live = R.IsValidName(name) ? await this.files.Live(name) : undefined
            const current = live === undefined ? undefined : await this.records.Get(name)
            if (live === undefined || current?.unpacked === live.version)
            {
                continue
            }
            let taken = false
            try
            {
                await this.records.Update(name, record =>
                {
                    const versions = record?.versions ?? {}
                    if (Object.hasOwn(versions, live.version) && R.Canonical(versions[live.version]) !== R.Canonical(live.manifest))
                    {
                        throw new AppVersionConflictError()
                    }
                    taken = record?.live !== live.version
                    return { ...(record ?? {}), id: name, live: live.version, versions: { ...versions, [live.version]: live.manifest }, unpacked: live.version }
                })
            }
            catch (error)
            {
                if (!(error instanceof AppVersionConflictError))
                {
                    throw error
                }
                result.Refused.push(name)
                continue
            }
            if (taken)
            {
                result.Taken.push(name)
            }
        }
        return result
    }

    /** JSON with object keys sorted (the database's jsonb does not keep key order): two manifests are the same content
     *  when their canonical forms are equal. */
    public static Canonical(value: unknown): string
    {
        const R = PragmaticAppsRegistry
        if (Array.isArray(value))
        {
            return R.ArrayOpen + value.map(item => R.Canonical(item)).join(R.JsonComma) + R.ArrayClose
        }
        if (value !== null && typeof value === 'object')
        {
            const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            return R.ObjectOpen + entries.map(([key, item]) => JSON.stringify(key) + R.JsonColon + R.Canonical(item)).join(R.JsonComma) + R.ObjectClose
        }
        return JSON.stringify(value)
    }

    /** Writes the current live manifest of `name` to the handoff files and records that they name it. */
    private async MirrorLive(name: string): Promise<void>
    {
        if (this.files === undefined)
        {
            return
        }
        const app = await this.LiveApplicationFor(name)
        if (app === undefined)
        {
            return
        }
        const manifest = app.Manifest
        try
        {
            await this.files.Write(manifest)
        }
        catch (error)
        {
            // The commit stands (the database is the record): the handoff files lag until the next commit mirrors, and
            // the unpacked marker stays, so the next start does not take the stale files back.
            this.logger.Warn(PragmaticAppsRegistry.MirrorFailedLine + (error instanceof Error ? error.name : PragmaticAppsRegistry.UnknownErrorName))
            return
        }
        // Only while it is still the live version: a concurrent commit of another version mirrors (and records) its own.
        await this.records.Update(name, current => (current === undefined || current.live !== manifest.version ? current : { ...current, unpacked: manifest.version }))
    }

    /** A claim older than ClaimTtlMs (or with an unreadable time): its attempt crashed. */
    private static Expired(claim: ApplicationClaim): boolean
    {
        const at = Date.parse(claim.at)
        return !(at > Date.now() - PragmaticAppsRegistry.ClaimTtlMs)
    }

    private static WithoutEmptyClaims(record: ApplicationRecord): ApplicationRecord
    {
        if (record.claims !== undefined && Object.keys(record.claims).length === 0)
        {
            const { claims: _claims, ...rest } = record
            return rest
        }
        return record
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
