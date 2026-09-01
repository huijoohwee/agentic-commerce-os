import type { MergeReason } from './types.ts'

export class Halt extends Error {
  readonly reason: MergeReason
  readonly detail: string

  constructor(reason: MergeReason, detail: string) {
    super(detail)
    this.reason = reason
    this.detail = detail
  }
}
