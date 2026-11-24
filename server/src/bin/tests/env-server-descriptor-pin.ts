/** The one home of the released descriptor's content digest, pinned by the descriptor and release tests (a deliberate edit
 *  at every descriptor change; the platform release and the tenant admin console's catalogue carry the same digest). */
export class EnvServerDescriptorPin
{
    public static readonly Digest = 'sha256:ee4a3a3a2e491b6846ec75ab3aa70802258ffd942b11cce65f9c5805e4fe6ef2'
}
