import type { Grant, IRoleGrantStore, Realm, ResourceRef } from '@pragmatic-tech-ai/pragmatic-identity'

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

    public Save(grant: Grant): Promise<void>
    {
        return this.inner.Save(grant)
    }

    public Revoke(grant: Grant): Promise<void>
    {
        return this.inner.Revoke(grant)
    }

    public async GrantsOn(resource: ResourceRef): Promise<readonly Grant[]>
    {
        return resource.RealmId === this.environmentId ? this.inner.GrantsOn(resource) : []
    }
}
