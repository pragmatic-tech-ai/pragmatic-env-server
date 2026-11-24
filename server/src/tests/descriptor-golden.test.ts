import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { EnvServerComponent } from '../bin/env-server-component.js'
import { Components } from '../release-components.js'
import { EnvServerDescriptorPin } from '../bin/tests/env-server-descriptor-pin.js'

/** The release descriptor: the digest it must keep (EnvServerDescriptorPin) and the version of the manifest the release tag checks. */
class DescriptorGolden
{
    public static readonly Manifest = join(import.meta.dirname, '..', '..', 'package.json')
    public static readonly Utf8 = 'utf8'

    public static ManifestVersion(): string
    {
        return (JSON.parse(readFileSync(DescriptorGolden.Manifest, DescriptorGolden.Utf8)) as { version: string }).version
    }
}

describe('the release descriptor', () =>
{
    it('has the pinned descriptor digest', () =>
    {
        assert.equal(Components.Of(ReleaseApp.EnvServer).ContentDigest(), EnvServerDescriptorPin.Digest)
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
