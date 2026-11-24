/** The one home of the released descriptor's content digest, pinned by the descriptor and release tests (a deliberate edit
 *  at every descriptor change; the platform release and the tenant admin console's catalogue carry the same digest). */
export class EnvServerDescriptorPin
{
    public static readonly Digest = 'sha256:5ae7c6eff73a06cfb85fbc8d83b5cd9e2d6aaeaf11c40a0ac246f440ff9a965a'
}
