export interface OperationToken {
  readonly id: number;
}

export class OperationScope {
  private active: OperationToken | null = null;
  private nextId = 1;
  private readonly cancellationRequested = new WeakSet<OperationToken>();

  begin(): OperationToken | null {
    if (this.active) return null;
    const token = { id: this.nextId };
    this.nextId = this.nextId === Number.MAX_SAFE_INTEGER ? 1 : this.nextId + 1;
    this.active = token;
    return token;
  }

  current(): OperationToken | null {
    return this.active;
  }

  isCurrent(token: OperationToken): boolean {
    return this.active === token;
  }

  requestCancellation(token: OperationToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.cancellationRequested.add(token);
    return true;
  }

  isCancellationRequested(token: OperationToken): boolean {
    return this.cancellationRequested.has(token);
  }

  finish(token: OperationToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.cancellationRequested.delete(token);
    this.active = null;
    return true;
  }
}
