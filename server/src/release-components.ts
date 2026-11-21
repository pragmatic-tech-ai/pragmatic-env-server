import { ContainerComponentSource, ReleaseApp } from '@pragmatic-tech-ai/pragmatic-release-toolkit'
import { EnvServerComponent } from './bin/env-server-component.js'

/** This repository's one component, as `pragmatic-component-descriptors --components server/dist/release-components.js` reads it. */
export const Components = new ContainerComponentSource(ReleaseApp.EnvServer, () => EnvServerComponent.Descriptor())
