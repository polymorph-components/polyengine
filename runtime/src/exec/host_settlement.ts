// Private facade/boundary hand-off. Observing host completion and ending its
// borrow scope must not convert values that the boundary may discard.
export type HostSettlement = { value: unknown } | { error: unknown };

export class DeferredHostResult {
  constructor(
    readonly promise: Promise<HostSettlement>,
    readonly convert: (settlement: HostSettlement) => unknown,
    readonly endScope: () => void,
  ) {}
}
