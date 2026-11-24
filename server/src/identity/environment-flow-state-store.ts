import { OidcFlowState, type IOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { SqlOidcFlowStateStore } from '@pragmatic-tech-ai/pragmatic-realm-adapters'
import { EnvironmentIdInvalidError } from '../storage/environment-records.js'

/**
 * One environment's view of the env server's pending OIDC sign-ins (A5): every environment and every worker of the
 * deployment share one SqlOidcFlowStateStore in the database, and this view keys its states `<environmentId>/<state>`,
 * so a state put for environment A is never taken by B (environment ids hold no `/`), while a sign-in begun on one
 * worker completes on another. Take is single use (the inner store's DELETE ... RETURNING).
 */
export class EnvironmentFlowStateStore implements IOidcFlowStateStore
{
    private static readonly Separator = '/'

    private readonly prefix: string

    public constructor(private readonly inner: SqlOidcFlowStateStore, environmentId: string)
    {
        EnvironmentIdInvalidError.Assert(environmentId)
        this.prefix = environmentId + EnvironmentFlowStateStore.Separator
    }

    public Put(state: OidcFlowState): Promise<void>
    {
        return this.inner.Put(new OidcFlowState(this.prefix + state.State, state.Nonce, state.CodeVerifier, state.RedirectUri, state.ExpiresAt, state.ReturnPath))
    }

    public async Take(state: string): Promise<OidcFlowState | null>
    {
        const taken = await this.inner.Take(this.prefix + state)
        return taken === null ? null : new OidcFlowState(state, taken.Nonce, taken.CodeVerifier, taken.RedirectUri, taken.ExpiresAt, taken.ReturnPath)
    }
}
