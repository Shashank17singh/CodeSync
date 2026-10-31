export class TokenBucket {
  private tokens: number
  private updatedAt: number

  constructor(
    private readonly refillPerSecond: number,
    private readonly capacity: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = capacity
    this.updatedAt = now()
  }

  take(amount = 1): boolean {
    const current = this.now()
    const elapsedSeconds = (current - this.updatedAt) / 1000
    this.tokens = Math.min(this.capacity, this.tokens + elapsedSeconds * this.refillPerSecond)
    this.updatedAt = current
    if (this.tokens < amount) return false
    this.tokens -= amount
    return true
  }
}
