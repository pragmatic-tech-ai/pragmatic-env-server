/** The one home of the released descriptor's content digest, pinned by the descriptor and release tests (a deliberate edit
 *  at every descriptor change; the platform release and the tenant admin console's catalogue carry the same digest). */
export class EnvServerDescriptorPin
{
    public static readonly Digest = 'sha256:5e35f9ea043a94415bae2e91821db3f099162c9a005de1c3e367ac8f24b883d4'
}
