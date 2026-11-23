import { randomBytes } from 'node:crypto'
import { DelegationDepth, IdentityConfig, Realm, RealmKind } from '@pragmatic-tech-ai/pragmatic-identity'
import type { IdentityStoreSet, Role } from '@pragmatic-tech-ai/pragmatic-identity'
import { InMemoryOidcFlowStateStore, OidcSettingKeys } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc'
import { FakeOidcHttpClient, FakeOidcIdp } from '@pragmatic-tech-ai/pragmatic-identity-source-oidc/testing'
import { CustomPlatformFixture } from '../../platform/tests/custom-platform-fixture.js'
import { IdentityPackResolver } from '../identity-pack-resolver.js'

export class ResolverFixture
{
    public static readonly EntraTenantId = 'test-tid'
    public static readonly GoogleIssuer = 'https://accounts.google.com'
    public static readonly ClientId = 'client-1'
    public static readonly RedirectUri = 'https://app.test/cb'
    public static readonly Subject = 'u1'
    public static readonly Email = 'a@x.io'
    public static readonly Group = 'group-ed'
    public static readonly AuthCode = 'auth-code'
    public static readonly BearerType = 'Bearer'
    private static readonly EnvironmentId = 'ps7'
    private static readonly RealmIdPrefix = 't-'
    private static readonly DiscoveryPath = '/.well-known/openid-configuration'

    /** Fresh identity stores over their own in-memory database. */
    /** A fresh store set for one environment (its sessions and grants are scoped to it). */
    public async Stores(environmentId: string = ResolverFixture.EnvironmentId): Promise<IdentityStoreSet>
    {
        return CustomPlatformFixture.Mem().CreateIdentityStores(environmentId, randomBytes(32))
    }

    /** Nothing to release: every store set lives in its own in-memory database. */
    public Dispose(): void
    {
    }

    public EntraSettings(): Map<string, string>
    {
        return new Map([
            [OidcSettingKeys.AadTenantId, ResolverFixture.EntraTenantId],
            [OidcSettingKeys.ClientId, ResolverFixture.ClientId],
            [OidcSettingKeys.RedirectUri, ResolverFixture.RedirectUri],
        ])
    }

    public GoogleSettings(): Map<string, string>
    {
        return new Map([
            [OidcSettingKeys.Issuer, ResolverFixture.GoogleIssuer],
            [OidcSettingKeys.DiscoveryUrl, ResolverFixture.GoogleIssuer + ResolverFixture.DiscoveryPath],
            [OidcSettingKeys.ClientId, ResolverFixture.ClientId],
            [OidcSettingKeys.RedirectUri, ResolverFixture.RedirectUri],
        ])
    }

    public GenericSettings(issuer: string): Map<string, string>
    {
        return new Map([
            [OidcSettingKeys.Issuer, issuer],
            [OidcSettingKeys.DiscoveryUrl, issuer + ResolverFixture.DiscoveryPath],
            [OidcSettingKeys.ClientId, ResolverFixture.ClientId],
            [OidcSettingKeys.RedirectUri, ResolverFixture.RedirectUri],
        ])
    }

    /** Resolve a pack for one realm, run begin, mint a matching id_token, and arm the token endpoint. */
    public async Flow(packId: string, issuer: string, settings: Map<string, string>, depth: DelegationDepth, groupRoleMap: ReadonlyMap<string, Role>, groupsClaim: string)
    {
        const idp = await FakeOidcIdp.Create(issuer)
        const http = new FakeOidcHttpClient(idp)
        const flowStates = new InMemoryOidcFlowStateStore()
        const realm = new Realm(ResolverFixture.RealmIdPrefix + packId, RealmKind.Saas, packId)
        const stores = await this.Stores(realm.Id)
        const config = new IdentityConfig(packId, depth, settings, groupRoleMap, new Map())
        const resolver = new IdentityPackResolver(http, flowStates)
        const resolved = resolver.Resolve(realm, config, stores)
        const begun = await resolved.Oidc!.BeginAuthorization(realm)
        const nonce = flowStates.Peek(begun.State)!.Nonce
        const idToken = await idp.MintIdToken({
            sub: ResolverFixture.Subject,
            aud: ResolverFixture.ClientId,
            nonce,
            email: ResolverFixture.Email,
            [groupsClaim]: [ResolverFixture.Group],
        })
        http.NextTokenResponse = { id_token: idToken, token_type: ResolverFixture.BearerType }
        return { resolved, realm, State: begun.State, idToken, http, flowStates }
    }
}
