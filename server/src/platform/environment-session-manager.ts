import type { ISessionManager, Principal, Realm, Session } from '@pragmatic-tech-ai/pragmatic-identity'

/**
 * One environment's view of the deployment's shared session table: a session issued in another environment does not
 * validate here (the SQL store looks a token up by its hash across every realm, and principal ids repeat across
 * environments), so a bearer token from environment A never authenticates in B.
 */
export class EnvironmentSessionManager implements ISessionManager
{
    public constructor(private readonly inner: ISessionManager, private readonly environmentId: string)
    {
    }

    public Issue(principal: Principal): Promise<Session>
    {
        return this.inner.Issue(principal)
    }

    public async Validate(token: string): Promise<Session | null>
    {
        const session = await this.inner.Validate(token)
        return session !== null && session.RealmId === this.environmentId ? session : null
    }

    public Revoke(sessionId: string): Promise<void>
    {
        return this.inner.Revoke(sessionId)
    }

    public RevokeAllFor(realm: Realm, principalId: string): Promise<void>
    {
        return this.inner.RevokeAllFor(realm, principalId)
    }
}
