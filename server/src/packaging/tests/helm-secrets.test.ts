import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

class Chart
{
    private static readonly Root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', 'helm', 'pragmatic-env-server')

    public static Text(relative: string): string
    {
        return readFileSync(join(Chart.Root, relative), 'utf8')
    }
}

test('secret renders the provisioned blob via stringData toJson, never b64enc', () =>
{
    const secret = Chart.Text(join('templates', 'secret.yaml'))
    assert.match(secret, /\.Values\.secrets\.provisioned/)
    assert.match(secret, /toJson/)
    assert.doesNotMatch(secret, /b64enc/)
})

test('deployment mounts the provisioned secret and sets PRAGMATIC_PROVISIONED_SECRETS_FILE', () =>
{
    const deployment = Chart.Text(join('templates', 'deployment.yaml'))
    assert.match(deployment, /PRAGMATIC_PROVISIONED_SECRETS_FILE/)
    assert.match(deployment, /\/run\/secrets\/provisioned\/secrets\.json/)
    assert.match(deployment, /provisionedExistingSecret/)
})

test('deployment rolls the pod on provisioned-secret rotation via a checksum annotation', () =>
{
    const deployment = Chart.Text(join('templates', 'deployment.yaml'))
    assert.match(deployment, /checksum\/secret/)
})

test('values expose a provisioned secrets block and drop the reserved stubs', () =>
{
    const values = Chart.Text('values.yaml')
    assert.match(values, /provisioned:\s*\{\}/)
    assert.match(values, /provisionedExistingSecret:/)
    assert.match(values, /provisionedSecretKey:/)
    assert.doesNotMatch(values, /adminPasswords:/)
})

test('the ConfigMap never carries a provisioned secret value', () =>
{
    const configmap = Chart.Text(join('templates', 'configmap.yaml'))
    assert.doesNotMatch(configmap, /secrets\.provisioned/)
})

test('NOTES mention provisioned per-environment secrets', () =>
{
    const notes = Chart.Text(join('templates', 'NOTES.txt'))
    assert.match(notes, /provisioned/i)
})

test('the provisioned volume/env are gated and the existingSecret overrides the chart Secret name', () =>
{
    const deployment = Chart.Text(join('templates', 'deployment.yaml'))
    assert.match(deployment, /\{\{- if or \.Values\.secrets\.provisioned \.Values\.secrets\.provisionedExistingSecret \}\}/)
    assert.match(deployment, /secretName: \{\{ \.Values\.secrets\.provisionedExistingSecret \| default/)
})

test('the chart requires database.urlSecret (the render fails naming it when empty) and both workloads mount the database URL file', () =>
{
    for (const workload of ['deployment.yaml', 'worker-statefulset.yaml'])
    {
        const text = Chart.Text(join('templates', workload))
        assert.match(text, /required "database\.urlSecret is required/, workload)
        assert.match(text, /PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE\n\s+value: \/run\/secrets\/pragmatic-env-server\/database-url/, workload)
        assert.match(text, /mountPath: \/run\/secrets\/pragmatic-env-server\n\s+readOnly: true/, workload)
    }
    assert.match(Chart.Text('values.yaml'), /database:\n\s+urlSecret: \S+\n\s+urlKey: database-url/)
})

test('the env server database Secret, its mount and its URL file setting render only with deploymentMode local (a cloud mode stores in its provider database)', () =>
{
    for (const template of ['deployment.yaml', 'worker-statefulset.yaml'])
    {
        const text = Chart.Text(join('templates', template))
        const gated = /\{\{- if eq \.Values\.deploymentMode "local" \}\}\n\s*- name: PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE\n[^\n]*\n\s*\{\{- end \}\}/
        assert.match(text, gated, template + ': URL file setting')
        assert.match(text, /\{\{- if eq \.Values\.deploymentMode "local" \}\}\n\s*- name: database-url\n\s*mountPath: \/run\/secrets\/pragmatic-env-server\n\s*readOnly: true\n\s*\{\{- end \}\}/, template + ': mount')
        assert.match(text, /\{\{- if eq \.Values\.deploymentMode "local" \}\}\n(\s*#[^\n]*\n)*\s*- name: database-url\n\s*secret:\n[\s\S]*?path: database-url\n\s*\{\{- end \}\}/, template + ': volume')
        assert.equal((text.match(/database-url/g) ?? []).length, (text.match(/deploymentMode "local" \}\}[\s\S]*?\{\{- end \}\}/g) ?? []).join('').match(/database-url/g)?.length, template + ': every database-url use is gated')
    }
})
