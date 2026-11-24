import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { EnvServerComponent } from '../bin/env-server-component.js'
import { Components } from '../release-components.js'

/** The pragmatic-server golden this repository's descriptor must keep (admin/control-plane/descriptors/digests.json there). */
class DescriptorGolden
{
    public static readonly Digest = 'sha256:d2c7d32fea0fb390b680a08984f2fe7354c041fc70470d55d6984ac259151e8d'
    public static readonly Manifest = join(import.meta.dirname, '..', '..', 'package.json')
    public static readonly Utf8 = 'utf8'

    public static ManifestVersion(): string
    {
        return (JSON.parse(readFileSync(DescriptorGolden.Manifest, DescriptorGolden.Utf8)) as { version: string }).version
    }
}

describe('the release descriptor', () =>
{
    it('has the pragmatic-server golden digest', () =>
    {
        assert.equal(Components.Of(ReleaseApp.EnvServer).ContentDigest(), DescriptorGolden.Digest)
    })

    it('is the one component this repository releases', () =>
    {
        assert.deepEqual(Components.All().map(([app]) => app), [ReleaseApp.EnvServer])
    })

    it('carries the version of server/package.json (the release tag checks that manifest)', () =>
    {
        assert.equal(EnvServerComponent.Version, DescriptorGolden.ManifestVersion())
        assert.equal(Components.Of(ReleaseApp.EnvServer).Version, DescriptorGolden.ManifestVersion())
    })
})
