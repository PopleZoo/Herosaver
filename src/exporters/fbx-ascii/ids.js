export class IDAllocator {
  constructor(start = 1000) {
    this.next = start
    this.map = new Map()
  }

  getId(obj) {
    const key = obj && obj.uuid ? obj.uuid : obj
    if (!this.map.has(key)) {
      this.map.set(key, this.next++)
    }
    return this.map.get(key)
  }

  getIdForKey(key) {
    if (!this.map.has(key)) {
      this.map.set(key, this.next++)
    }
    return this.map.get(key)
  }

  hasId(key) {
    return this.map.has(key)
  }
}

export function createIDAllocator(start = 1000) {
  return new IDAllocator(start)
}