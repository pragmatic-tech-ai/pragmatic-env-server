import type { IStorage } from '@pragmatic-tech-ai/todl-runtime'
import { randomUUID } from 'node:crypto'
import { DeliveryChannel, EnvironmentCatalogError, SystemNames } from '@pragmatic-tech-ai/todl/engine'
import { AppWriteStatus, type AppDeployResultDto, type CypherAppDeployParamsDto } from '@pragmatic-tech-ai/pragmatic-protocol'
import { PragmaticAppsRegistry } from './pragmatic-apps-registry.js'
import type { PragmaticAppManifest } from './pragmatic-app-manifest.js'
import { EnvironmentUpgradeFailedError } from '../environment/environment-engine-host.js'
import type { DeliveryChange, IDeliveryGate } from '../environment/environment-deliveries.js'
import { NullLogger, type ILogger } from '@pragmatic-tech-ai/pragmatic-observability'

/** A client-supplied value failed validation; the message is secret-free and safe to return. */
class IngestRejection extends Error
{
    public readonly Status: AppWriteStatus

    public constructor(status: AppWriteStatus, message: string)
    {
        super(message)
        this.Status = status
    }
}

interface PlannedFile
{
    storage: IStorage
    path: string
    bytes: Uint8Array
    /** Already present with identical content: nothing to write. */
    skip?: boolean
}

interface IngestPlan
{
    files: PlannedFile[]
    /** The version's manifest, as the registry stores it (the commit). */
    manifest: PragmaticAppManifest
}

/**
 * Ingests a published remote application onto a runtime environment. The storages and the registry are bound to the
 * per-environment `PragmaticServer`, so ingest is already environment-scoped. Everything is validated before the first
 * byte is written; an already-live `name@version` is refused (versions are immutable), package and UI files are staged
 * under unique temp names and renamed into place, and the registry's `Commit` (one database write adding the version's
 * manifest and moving the live pointer to it, A5) comes LAST, so a version is never served while half-ingested: until
 * the commit the app serves the previous live version.
 *
 * Ruling S4: the packages are stored first (immutable), then the deploy is handed to the environment's delivery gate,
 * which composes every live app plus this one over the stored packages BEFORE anything else is written: a composition
 * error (EnvironmentCatalogError: incompatible versions, conflicting connectors or definitions, duplicate or invalid
 * bindings, ...) answers `invalid` with its message, and neither the version tree nor the pointer is written. Only a
 * set that composes commits the version tree and the pointer (the gate's persist step), after which the gate upgrades
 * the environment engine; an upgrade that fails then answers `failed` with EnvironmentUpgradeFailedError's reason (the
 * app is live; the engine retries on next use). A crash between the UI files and the commit leaves non-servable orphan
 * files (no manifest in the registry: the version was never made live), which a retry overwrites. Redeploying a version
 * that was committed earlier but is not live now (another version went live since) with byte-identical content only
 * moves the live pointer back to it.
 * Concurrent ingests of one app are serialized per app (the lock does NOT serialize shared-package writes across DIFFERENT apps: a pathological
 * cross-app race on the same package id@version is acceptable for SP0). Client paths are never trusted.
 *
 * Layout: UI assets are version-scoped in the applications storage (`<app>/<version>/ui/...`), so a new version never
 * touches an earlier tree; manifests and the live pointer are the app's record in the registry. Request size is bounded
 * by the wire frame limit (acceptable for SP0).
 */
export class AppIngestService
{
    private static readonly ModelFile = 'model.json'
    private static readonly ArrayOpen = '['
    private static readonly ArrayClose = ']'
    private static readonly ObjectOpen = '{'
    private static readonly ObjectClose = '}'
    private static readonly JsonComma = ','
    private static readonly JsonColon = ':'
    private static readonly UiDir = 'ui'
    private static readonly ReservedVersions: ReadonlySet<string> = new Set(['live', 'ui', 'application.json'])
    private static readonly ReservedVersionMessage = 'this application version name is reserved'
    private static readonly Separator = '/'
    private static readonly TempPrefix = '.ingest-'
    private static readonly TempSuffix = '.tmp'
    private static readonly KeySeparator = '@'
    /** The platform package every environment composes in (EnvironmentCatalogComposer); a closure needs not supply it. */
    private static readonly SystemPackageKey = SystemNames.Model + AppIngestService.KeySeparator + SystemNames.Version
    private static readonly Base64Encoding = 'base64'
    // A linear char-class scan plus a group-size check: canonical base64 only, with padding solely at the end. The
    // earlier grouped-quantifier form ((?:...){4})* overflowed the regex stack (RangeError) on multi-megabyte assets.
    private static readonly Base64Pattern = /^[A-Za-z0-9+/]*={0,2}$/
    private static readonly Base64GroupSize = 4
    private static readonly UnsafeSegmentPattern = /[\\:\0]/
    private static readonly MalformedMessage = 'deploy request is malformed'
    private static readonly NameMismatchMessage = 'manifest name/version does not match the deploy request'
    private static readonly UnsafeNameMessage = 'application name or version is not a safe path segment'
    private static readonly UnsafePackageMessage = 'a package id or version is not a safe path segment'
    private static readonly UnsafePathMessage = 'a UI bundle path is not a safe relative path'
    private static readonly BadModelMessage = 'a package model is not a valid package document'
    private static readonly BadBase64Message = 'a UI bundle file is not valid base64'
    private static readonly DuplicatePackageMessage = 'a package id and version is supplied more than once'
    private static readonly DuplicatePathMessage = 'a UI bundle path is supplied more than once'
    private static readonly ClosureMessage = 'package closure is incomplete; missing: '
    private static readonly EntryMessage = 'the UI entry file is not part of the UI bundle'
    private static readonly AssetMessage = 'a manifest UI asset is not part of the UI bundle'
    private static readonly WriteFailedMessage = 'the application could not be written'
    private static readonly ListSeparator = ', '
    private static readonly VersionExistsMessage = 'this application version is already deployed; versions are immutable'
    private static readonly PackageDiffersMessage = 'a package version is already deployed with different content; versions are immutable'
    private static readonly WriteFailedLine = 'app ingest write failed'
    private static readonly ErrorClassField = 'errorClass'
    private static readonly ErrorCodeField = 'errorCode'
    private static readonly UnknownClass = 'unknown'

    private readonly locks = new Map<string, Promise<unknown>>()

    public constructor(private readonly packages: IStorage, private readonly applications: IStorage, private readonly registry: PragmaticAppsRegistry, private readonly gate: IDeliveryGate, private readonly logger: ILogger = new NullLogger())
    {
    }

    public async Ingest(params: CypherAppDeployParamsDto): Promise<AppDeployResultDto>
    {
        const appName = typeof params?.appName === 'string' ? params.appName : ''
        const appVersion = typeof params?.appVersion === 'string' ? params.appVersion : ''
        let plan: IngestPlan
        try
        {
            plan = this.Validate(params)
        }
        catch (error)
        {
            return this.Failure(error, appName, appVersion)
        }
        return this.Serialized(appName, async () =>
        {
            try
            {
                const resume = await this.AssertImmutable(plan, params)
                // S4 step 1: the packages are stored (immutably) first, so the gate composes over them; on a resume
                // only the ones still missing are written.
                await this.Commit(plan.files.filter(file => file.storage === this.packages && file.skip !== true))
                // S4 steps 2-4: the gate validates the prospective deliveries, runs the persist step, applies the
                // security diff, then upgrades; the deploy answers the security changes it applied (S4 Task 13).
                const delivered = await this.gate.Deliver(AppIngestService.ChangeOf(params), async () =>
                {
                    if (!resume)
                    {
                        await this.Commit(plan.files.filter(file => file.storage === this.applications))
                    }
                    // The commit: the UI tree is in place, so add the manifest and move the live pointer in one write.
                    await this.registry.Commit(plan.manifest)
                })
                const applied: AppDeployResultDto = { status: AppWriteStatus.Applied, appName, appVersion }
                return delivered.SecurityChanges === undefined ? applied : { ...applied, securityChanges: delivered.SecurityChanges }
            }
            catch (error)
            {
                return this.Failure(error, appName, appVersion)
            }
        })
    }

    /** The Deploy delivery this ingest makes: the app's manifest packages under the app name. */
    private static ChangeOf(params: CypherAppDeployParamsDto): DeliveryChange
    {
        return {
            Channel: DeliveryChannel.Deploy,
            Name: params.appName,
            Packages: params.manifest.packages.map(ref => ({ model: ref.id, version: ref.version })),
            Version: params.appVersion,
        }
    }

    private Failure(error: unknown, appName: string, appVersion: string): AppDeployResultDto
    {
        if (error instanceof EnvironmentCatalogError)
        {
            // S4 step 2: the prospective deliveries do not compose; nothing beyond the immutable packages was written.
            return { status: AppWriteStatus.Invalid, reason: error.message, appName, appVersion }
        }
        if (error instanceof EnvironmentUpgradeFailedError)
        {
            // S4 step 4: the app is live, the engine upgrade failed (the host reported it and retries on next use).
            return { status: AppWriteStatus.Failed, reason: EnvironmentUpgradeFailedError.Reason, appName, appVersion }
        }
        const rejected = error instanceof IngestRejection
        if (!rejected)
        {
            // Class/code only: never the message (may embed paths) or any payload bytes.
            this.logger.Error(AppIngestService.WriteFailedLine, AppIngestService.ErrorFields(error))
        }
        return {
            status: rejected ? error.Status : AppWriteStatus.Failed,
            reason: rejected ? error.message : AppIngestService.WriteFailedMessage,
            appName,
            appVersion,
        }
    }

    private static ErrorFields(error: unknown): Record<string, unknown>
    {
        const code = (error as { code?: unknown } | null)?.code
        return {
            [AppIngestService.ErrorClassField]: error instanceof Error ? error.constructor.name : AppIngestService.UnknownClass,
            [AppIngestService.ErrorCodeField]: typeof code === 'string' || typeof code === 'number' ? code : undefined,
        }
    }

    /** Runs `section` after any in-flight ingest of the same app finishes (per-app in-memory lock). */
    private async Serialized<T>(appName: string, section: () => Promise<T>): Promise<T>
    {
        const previous = this.locks.get(appName) ?? Promise.resolve()
        const run = previous.then(section, section)
        const tail = run.catch(() => undefined)
        this.locks.set(appName, tail)
        try
        {
            return await run
        }
        finally
        {
            if (this.locks.get(appName) === tail)
            {
                this.locks.delete(appName)
            }
        }
    }

    /**
     * Versions are immutable: refuse an already-live name@version and a package version whose content differs; marks
     * already-stored packages skip. True when this is a resume (the version was committed before, another one is live).
     */
    private async AssertImmutable(plan: IngestPlan, params: CypherAppDeployParamsDto): Promise<boolean>
    {
        let resume = false
        const stored = await this.registry.ManifestOf(params.appName, params.appVersion)
        if (stored !== undefined)
        {
            if (await this.registry.LiveVersion(params.appName) === params.appVersion)
            {
                throw new IngestRejection(AppWriteStatus.Conflict, AppIngestService.VersionExistsMessage)
            }
            // Immutability: a resume is only an idempotent redeploy of byte-identical content, never a silent replacement.
            if (!await this.MatchesStored(plan, stored))
            {
                throw new IngestRejection(AppWriteStatus.Conflict, AppIngestService.VersionExistsMessage)
            }
            resume = true
        }
        // Stored packages are marked skip (a resume included: MatchesStored tolerates a package not yet written, which
        // the package commit then writes, so the gate can compose over it).
        for (const file of plan.files)
        {
            if (file.storage === this.packages && await this.packages.Exists(file.path))
            {
                const current = await this.packages.ReadBytes(file.path)
                if (Buffer.compare(Buffer.from(current), Buffer.from(file.bytes)) !== 0)
                {
                    throw new IngestRejection(AppWriteStatus.Conflict, AppIngestService.PackageDiffersMessage)
                }
                file.skip = true
            }
        }
        return resume
    }

    /** True when the stored manifest equals the planned one, every UI file is byte-identical to what is stored, and no
     *  already-stored package file differs. */
    private async MatchesStored(plan: IngestPlan, stored: PragmaticAppManifest): Promise<boolean>
    {
        if (AppIngestService.Canonical(stored) !== AppIngestService.Canonical(plan.manifest))
        {
            return false
        }
        for (const file of plan.files.filter(f => f.storage === this.applications))
        {
            if (!await this.applications.Exists(file.path)
                || Buffer.compare(Buffer.from(await this.applications.ReadBytes(file.path)), Buffer.from(file.bytes)) !== 0)
            {
                return false
            }
        }
        // A package not yet written is a legitimate interrupted resume; one that is stored must be byte-identical.
        for (const file of plan.files.filter(f => f.storage === this.packages))
        {
            if (await this.packages.Exists(file.path)
                && Buffer.compare(Buffer.from(await this.packages.ReadBytes(file.path)), Buffer.from(file.bytes)) !== 0)
            {
                return false
            }
        }
        return true
    }

    /** JSON with object keys sorted (the database's jsonb does not keep key order). */
    private static Canonical(value: unknown): string
    {
        if (Array.isArray(value))
        {
            return AppIngestService.ArrayOpen + value.map(item => AppIngestService.Canonical(item)).join(AppIngestService.JsonComma) + AppIngestService.ArrayClose
        }
        if (value !== null && typeof value === 'object')
        {
            const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
            return AppIngestService.ObjectOpen + entries.map(([key, item]) => JSON.stringify(key) + AppIngestService.JsonColon + AppIngestService.Canonical(item)).join(AppIngestService.JsonComma) + AppIngestService.ObjectClose
        }
        return JSON.stringify(value)
    }

    private Validate(params: CypherAppDeployParamsDto): IngestPlan
    {
        if (params === null || typeof params !== 'object' || !Array.isArray(params.packages) || !Array.isArray(params.uiBundle)
            || params.manifest === null || typeof params.manifest !== 'object' || !Array.isArray(params.manifest.packages))
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.MalformedMessage)
        }
        const manifest = params.manifest
        AppIngestService.AssertSegment(params.appName, AppIngestService.UnsafeNameMessage)
        AppIngestService.AssertSegment(params.appVersion, AppIngestService.UnsafeNameMessage)
        if (AppIngestService.ReservedVersions.has(params.appVersion))
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.ReservedVersionMessage)
        }
        if (manifest.name !== params.appName || manifest.version !== params.appVersion)
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.NameMismatchMessage)
        }
        const files: PlannedFile[] = []
        const supplied = new Set<string>()
        const required = new Set<string>()
        for (const pkg of params.packages)
        {
            AppIngestService.AssertSegment(pkg?.id, AppIngestService.UnsafePackageMessage)
            AppIngestService.AssertSegment(pkg.version, AppIngestService.UnsafePackageMessage)
            const key = AppIngestService.PackageKey(pkg.id, pkg.version)
            if (supplied.has(key))
            {
                throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.DuplicatePackageMessage)
            }
            supplied.add(key)
            for (const dependency of AppIngestService.DependenciesOf(pkg.modelJson))
            {
                required.add(AppIngestService.PackageKey(dependency.id, dependency.version))
            }
            files.push({ storage: this.packages, path: [pkg.id, pkg.version, AppIngestService.ModelFile].join(AppIngestService.Separator), bytes: new TextEncoder().encode(pkg.modelJson) })
        }
        for (const ref of manifest.packages)
        {
            AppIngestService.AssertSegment(ref?.id, AppIngestService.UnsafePackageMessage)
            AppIngestService.AssertSegment(ref.version, AppIngestService.UnsafePackageMessage)
            required.add(AppIngestService.PackageKey(ref.id, ref.version))
        }
        // the platform's own todl.system package (the ownership aspect a secured package builds on) is never shipped by an app
        const missing = [...required].filter(key => !supplied.has(key) && key !== AppIngestService.SystemPackageKey).sort()
        if (missing.length > 0)
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.ClosureMessage + missing.join(AppIngestService.ListSeparator))
        }
        const uiPaths = new Set<string>()
        for (const asset of params.uiBundle)
        {
            const path = AppIngestService.SafeRelativePath(asset?.path)
            if (typeof asset.contentBase64 !== 'string' || asset.contentBase64 === '' || asset.contentBase64.length % AppIngestService.Base64GroupSize !== 0 || !AppIngestService.Base64Pattern.test(asset.contentBase64))
            {
                throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.BadBase64Message)
            }
            if (uiPaths.has(path))
            {
                throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.DuplicatePathMessage)
            }
            uiPaths.add(path)
            files.push({ storage: this.applications, path: [params.appName, params.appVersion, AppIngestService.UiDir, path].join(AppIngestService.Separator), bytes: Buffer.from(asset.contentBase64, AppIngestService.Base64Encoding) })
        }
        const projection: PragmaticAppManifest = {
            name: manifest.name,
            version: manifest.version,
            packages: manifest.packages.map(ref => ({ id: ref.id, version: ref.version })),
        }
        if (manifest.ui !== undefined && manifest.ui !== null)
        {
            if (!uiPaths.has(AppIngestService.SafeRelativePath(manifest.ui.entry)))
            {
                throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.EntryMessage)
            }
            const assets = (Array.isArray(manifest.ui.assets) ? manifest.ui.assets : []).map(asset => AppIngestService.SafeRelativePath(asset))
            if (assets.some(asset => !uiPaths.has(asset)))
            {
                throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.AssetMessage)
            }
            projection.ui = { entry: manifest.ui.entry, assets }
        }
        return { files, manifest: projection }
    }

    /** Stages `ordered` under temp names, then renames each into place in order; on failure removes only what it created. */
    private async Commit(ordered: readonly PlannedFile[]): Promise<void>
    {
        const suffix = AppIngestService.TempPrefix + randomUUID() + AppIngestService.TempSuffix
        const staged: PlannedFile[] = []
        const renamed: PlannedFile[] = []
        // Only paths this commit newly creates may be removed on failure; a pre-existing file is never deleted.
        const preExisting = new Set<PlannedFile>()
        for (const file of ordered)
        {
            if (await file.storage.Exists(file.path))
            {
                preExisting.add(file)
            }
        }
        try
        {
            for (const file of ordered)
            {
                staged.push(file)
                await file.storage.WriteBytes(file.path + suffix, file.bytes)
            }
            for (const file of ordered)
            {
                await file.storage.Rename(file.path + suffix, file.path)
                staged.splice(staged.indexOf(file), 1)
                renamed.push(file)
            }
        }
        catch (error)
        {
            // Best effort: drop leftover temps and files this commit newly created (never pre-existing ones).
            for (const file of staged)
            {
                await file.storage.Delete(file.path + suffix).catch(() => undefined)
            }
            for (const file of renamed.reverse())
            {
                if (!preExisting.has(file))
                {
                    await file.storage.Delete(file.path).catch(() => undefined)
                }
            }
            throw error
        }
    }

    private static PackageKey(id: string, version: string): string
    {
        return id + AppIngestService.KeySeparator + version
    }

    /** One safe path segment: reuses the registry's name guard and also refuses drive letters, NULs and absolute forms. */
    private static AssertSegment(value: unknown, message: string): asserts value is string
    {
        let safe = typeof value === 'string' && !AppIngestService.UnsafeSegmentPattern.test(value)
        if (safe)
        {
            try
            {
                PragmaticAppsRegistry.AssertValidName(value as string)
            }
            catch
            {
                safe = false
            }
        }
        if (!safe)
        {
            throw new IngestRejection(AppWriteStatus.Invalid, message)
        }
    }

    /** A relative, forward-slash path whose every segment is a safe name; refuses `..`, absolute, drive-letter and backslash forms. */
    private static SafeRelativePath(value: unknown): string
    {
        if (typeof value !== 'string' || value === '' || value.startsWith(AppIngestService.Separator) || AppIngestService.UnsafeSegmentPattern.test(value))
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.UnsafePathMessage)
        }
        for (const segment of value.split(AppIngestService.Separator))
        {
            AppIngestService.AssertSegment(segment, AppIngestService.UnsafePathMessage)
        }
        return value
    }

    private static DependenciesOf(modelJson: unknown): readonly { id: string; version: string }[]
    {
        let document: unknown
        try
        {
            document = typeof modelJson === 'string' ? JSON.parse(modelJson) : undefined
        }
        catch
        {
            document = undefined
        }
        if (document === null || typeof document !== 'object' || Array.isArray(document))
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.BadModelMessage)
        }
        const dependencies = (document as { dependencies?: unknown }).dependencies
        if (dependencies === undefined)
        {
            return []
        }
        if (!Array.isArray(dependencies))
        {
            throw new IngestRejection(AppWriteStatus.Invalid, AppIngestService.BadModelMessage)
        }
        for (const d of dependencies)
        {
            AppIngestService.AssertSegment(d?.id, AppIngestService.UnsafePackageMessage)
            AppIngestService.AssertSegment(d.version, AppIngestService.UnsafePackageMessage)
        }
        return dependencies as { id: string; version: string }[]
    }
}
