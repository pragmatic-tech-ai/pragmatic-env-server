import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { AppServingEndpoint, type IAppServerResolver, type IAppStorageSource } from '../app-serving-endpoint.js'

/** One reply of the endpoint under test. */
export interface ServedReply
{
    status: number
    body: string
}

/** Resolves only the harness environment to its source; any other environment is unknown. */
class SingleEnvironmentResolver implements IAppServerResolver
{
    private static readonly UnknownMessage = 'unknown environment: '

    public constructor(private readonly environment: string, private readonly source: IAppStorageSource)
    {
    }

    public ServerFor(environmentId: string): Promise<IAppStorageSource>
    {
        return environmentId === this.environment ? Promise.resolve(this.source) : Promise.reject(new Error(SingleEnvironmentResolver.UnknownMessage + environmentId))
    }
}

/** An AppServingEndpoint (no session check) over one environment's applications and storage, on an ephemeral port. */
export class AppServingHarness
{
    private static readonly Host = '127.0.0.1'
    private static readonly GetMethod = 'GET'
    private static readonly Utf8 = 'utf8'

    private constructor(private readonly server: Server)
    {
    }

    public static async Start(environment: string, source: IAppStorageSource): Promise<AppServingHarness>
    {
        const endpoint = new AppServingEndpoint(new SingleEnvironmentResolver(environment, source))
        const server = createServer((req, res) => void endpoint.Handle(req, res))
        await new Promise<void>(resolve => server.listen(0, AppServingHarness.Host, () => resolve()))
        return new AppServingHarness(server)
    }

    public Get(path: string): Promise<ServedReply>
    {
        const port = (this.server.address() as AddressInfo).port
        return new Promise<ServedReply>((resolve, reject) =>
        {
            const req = request({ host: AppServingHarness.Host, port, path, method: AppServingHarness.GetMethod }, res =>
            {
                const chunks: Buffer[] = []
                res.on('data', (chunk: Buffer) => chunks.push(chunk))
                res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString(AppServingHarness.Utf8) }))
            })
            req.on('error', reject)
            req.end()
        })
    }

    public Dispose(): Promise<void>
    {
        return new Promise<void>(resolve => this.server.close(() => resolve()))
    }
}
