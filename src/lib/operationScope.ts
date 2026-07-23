export type OperationToken = symbol;

export class OperationScope {
  private active: OperationToken | null = null;

  begin(): OperationToken | null {
    if (this.active) return null;
    const token = Symbol("operation");
    this.active = token;
    return token;
  }

  current(): OperationToken | null {
    return this.active;
  }

  isCurrent(token: OperationToken): boolean {
    return this.active === token;
  }

  finish(token: OperationToken): boolean {
    if (!this.isCurrent(token)) return false;
    this.active = null;
    return true;
  }
}
