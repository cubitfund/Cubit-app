/** Monotonic request identities: an older completion never acquires a newer request's freshness. */
export class RequestSequence {
  private sequence = 0;
  begin() { return ++this.sequence; }
  current(id: number) { return id === this.sequence; }
  invalidate() { this.sequence++; }
}
