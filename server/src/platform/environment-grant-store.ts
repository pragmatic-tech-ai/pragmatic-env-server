import type { Grant, IRoleGrantStore, Realm, ResourceRef } from '@pragmatic-tech-ai/pragmatic-identity'

/** A grant on another environment's resource was saved or revoked through this environment's view (the table is shared:
 *  it would act in the other environment). */
export class GrantOutsideEnvironmentError extends Error
{
    private static readonly ErrorName = 'GrantOutsideEnvironmentError'
    private static readonly Text = 'a grant must be on a resource of this environment'

    public constructor()
    {
        super(GrantOutsideEnvironmentError.Text)
        this.name = GrantOutsideEnvironmentError.ErrorName
    }
}

/**
 * One environment's view of the deployment's shared role grant table: only grants on this environment's resources (the
 * SQL store keys grants by subject across every realm; before A5 each environment's grants were its own file).
 */
export class EnvironmentGrantStore implements IRoleGrantStore
{
    public constructor(private readonly inner: IRoleGrantStore, private readonly environmentId: string)
    {
    }

    public async GrantsFor(subject: string, realm: Realm): Promise<readonly Grant[]>
    {
        return (await this.inner.GrantsFor(subject, realm)).filter(grant => grant.Resource.RealmId === this.environmentId)
    }

    public async Save(grant: Grant): Promise<void>
    {
        this.AssertOwn(grant)
        await this.inner.Save(grant)
    }

    public async Revoke(grant: Grant): Promise<void>
    {
        this.AssertOwn(grant)
        await this.inner.Revoke(grant)
    }

    public async GrantsOn(resource: ResourceRef): Promise<readonly Grant[]>
    {
        return resource.RealmId === this.environmentId ? this.inner.GrantsOn(resource) : []
    }

    private AssertOwn(grant: Grant): void
    {
        if (grant.Resource.RealmId !== this.environmentId)
        {
            throw new GrantOutsideEnvironmentError()
        }
    }
}
