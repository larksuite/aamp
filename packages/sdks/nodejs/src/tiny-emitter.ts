type Listener = (...args: unknown[]) => void
type EventListener<Events, K extends keyof Events> =
  Extract<Events[K], (...args: any[]) => void>
type EventArgs<Events, K extends keyof Events> =
  EventListener<Events, K> extends (...args: infer A) => void ? A : never

export class TinyEmitter<Events extends object> {
  private readonly listeners = new Map<keyof Events, Set<Listener>>()
  private readonly onceWrappers = new WeakMap<Listener, Listener>()

  on<K extends keyof Events>(event: K, listener: EventListener<Events, K>): this {
    const bucket = this.listeners.get(event) ?? new Set<Listener>()
    bucket.add(listener as Listener)
    this.listeners.set(event, bucket)
    return this
  }

  once<K extends keyof Events>(event: K, listener: EventListener<Events, K>): this {
    const wrapped: Listener = (...args: unknown[]) => {
      this.off(event, listener)
      ;(listener as Listener)(...args)
    }
    this.onceWrappers.set(listener as Listener, wrapped)
    return this.on(event, wrapped as EventListener<Events, K>)
  }

  off<K extends keyof Events>(event: K, listener: EventListener<Events, K>): this {
    const bucket = this.listeners.get(event)
    if (!bucket) return this

    const original = listener as Listener
    const wrapped = this.onceWrappers.get(original)
    bucket.delete(wrapped ?? original)
    if (wrapped) this.onceWrappers.delete(original)
    if (bucket.size === 0) this.listeners.delete(event)
    return this
  }

  protected emit<K extends keyof Events>(event: K, ...args: EventArgs<Events, K>): boolean {
    const bucket = this.listeners.get(event)
    if (!bucket || bucket.size === 0) return false

    for (const listener of [...bucket]) {
      listener(...args)
    }
    return true
  }
}
