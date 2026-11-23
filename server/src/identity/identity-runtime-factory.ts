import { FetchHttpClient } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import type { PlatformServices } from '../platform/platform-services.js'
import { EnvironmentFlowStateStore } from './environment-flow-state-store.js'
import type { IdentityRuntime } from './identity-runtime.js'

/** Builds the identity plumbing every environment of a server or worker process shares: one HTTP client and the
 *  database's pending OIDC sign-ins (shared by every worker of the deployment), viewed per environment. */
export class IdentityRuntimeFactory
{
    public static async Build(platform: PlatformServices): Promise<IdentityRuntime>
    {
        const flows = await platform.Database.FlowStates()
        return {
            HttpClient: new FetchHttpClient(),
            FlowStateFor: environmentId => new EnvironmentFlowStateStore(flows, environmentId),
        }
    }
}
