import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server, type Socket } from 'node:net'
import type { ISqlSession, SqlRow } from '@pragmatic-tech-ai/todl'
import { SqlTestSessions } from '@pragmatic-tech-ai/pragmatic-realm-adapters/testing'
import { EnvServerDatabase, EnvServerDatabaseUnreadyError } from '../env-server-database.js'
import { EnvServerDatabaseMissingError } from '../env-server-database-missing-error.js'
import { EnvServerRegistry } from '../env-server-registry.js'

/** Counts the statements a session runs. */
class CountingSession implements ISqlSession
{
    public Statements = 0

    public constructor(private readonly inner: ISqlSession)
    {
    }

    public Query(sql: string, params: readonly unknown[]): Promise<readonly SqlRow[]>
    {
        this.Statements++
        return this.inner.Query(sql, params)
    }

    public Execute(sql: string, params: readonly unknown[]): Promise<number>
    {
        this.Statements++
        return this.inner.Execute(sql, params)
    }

    public Transaction<T>(work: (tx: ISqlSession) => Promise<T>): Promise<T>
    {
        this.Statements++
        return this.inner.Transaction!(work)
    }
}

/** A TCP listener that accepts connections and never answers (a database whose connect hangs). */
class SilentListener
{
    private readonly sockets: Socket[] = []

    private constructor(private readonly server: Server, public readonly Port: number)
    {
    }

    public static async Start(): Promise<SilentListener>
    {
        const server = createServer()
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
        const listener = new SilentListener(server, (server.address() as { port: number }).port)
        server.on('connection', socket => listener.sockets.push(socket))
        return listener
    }

    public async Close(): Promise<void>
    {
        for (const socket of this.sockets)
        {
            socket.destroy()
        }
        await new Promise<void>(resolve => this.server.close(() => resolve()))
    }
}

class DatabaseFixture
{
    public static readonly Secret = 'postgres://env:never-shown@127.0.0.1:1/env_server'
    public static readonly LineEnd = String.fromCharCode(10)

    public static UrlFile(content: string): string
    {
        const path = join(mkdtempSync(join(tmpdir(), 'env-db-')), 'database-url')
        writeFileSync(path, content)
        return path
    }
}

SqlTestSessions.Describe('EnvServerDatabase', (makeSession, label) =>
{
    describe(label, () =>
    {
        it('opens over pg-mem and runs no migration until a store opens', async () =>
        {
            const session = new CountingSession(await makeSession())
            const database = EnvServerDatabase.Over(session)
            assert.equal(session.Statements, 0)
            const records = await database.Records<{ id: string; n: number }>(EnvServerRegistry.DevGraphs)
            assert.ok(session.Statements > 0)
            await records.Put({ id: 'a', n: 1 })
            assert.equal((await (await database.Records<{ id: string; n: number }>(EnvServerRegistry.DevGraphs)).Get('a'))?.n, 1)
            assert.equal(await database.Records(EnvServerRegistry.DevGraphs), records, 'one store per registry')
        })

        it('seals an environment secret under its own scope', async () =>
        {
            const database = EnvServerDatabase.Over(await makeSession())
            const key = Buffer.alloc(32, 5)
            await (await database.Secrets('env-a', key)).Put('ref', 'sekret')
            assert.equal(await (await database.Secrets('env-a', key)).Get('ref'), 'sekret')
            assert.equal(await (await database.Secrets('env-b', key)).Get('ref'), null)
        })
    })
})

describe('EnvServerDatabase.Open', () =>
{
    it('refuses a start without PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE naming the variable', async () =>
    {
        await assert.rejects(EnvServerDatabase.Open({}), (error: Error) => error instanceof EnvServerDatabaseMissingError && /PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE/.test(error.message))
        await assert.rejects(EnvServerDatabase.Open({ PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE: '  ' }), EnvServerDatabaseMissingError)
    })

    it('refuses an unreadable URL file naming the file, never the URL', async () =>
    {
        const missing = join(mkdtempSync(join(tmpdir(), 'env-db-')), 'absent')
        await assert.rejects(EnvServerDatabase.Open({ PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE: missing }), (error: Error) => error.message.includes(missing))
        const notUrl = DatabaseFixture.UrlFile('mysql://' + DatabaseFixture.Secret.slice('postgres://'.length))
        await assert.rejects(EnvServerDatabase.Open({ PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE: notUrl }), (error: Error) => error.message.includes(notUrl) && !error.message.includes('never-shown'))
    })

    it('waits for the database and gives up after the timeout', async () =>
    {
        const file = DatabaseFixture.UrlFile(DatabaseFixture.Secret + '\n')
        const started = Date.now()
        await assert.rejects(EnvServerDatabase.Open({ PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE: file }, 2_500), (error: Error) => !error.message.includes('never-shown'))
        const waited = Date.now() - started
        assert.ok(waited >= 1_000, `waited ${waited} ms`)
        assert.ok(waited < 10_000, `waited ${waited} ms`)
    })

    it('a database whose connect never answers gives up at the deadline, not at the TCP timeout', async () =>
    {
        const listener = await SilentListener.Start()
        try
        {
            const file = DatabaseFixture.UrlFile('postgres://env:never-shown@127.0.0.1:' + listener.Port + '/env_server' + DatabaseFixture.LineEnd)
            const started = Date.now()
            await assert.rejects(EnvServerDatabase.Open({ PRAGMATIC_ENV_SERVER_DATABASE_URL_FILE: file }, 1_500), (error: Error) => error instanceof EnvServerDatabaseUnreadyError && !error.message.includes('never-shown'))
            const waited = Date.now() - started
            assert.ok(waited < 1_500 + 1_000 + 1_000, `waited ${waited} ms`)
        }
        finally
        {
            await listener.Close()
        }
    })
})
