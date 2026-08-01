/**
 * Buffer management for glTF export
 * Handles binary data accumulation and buffer view / accessor creation
 */

// Component type constants
export const BYTE = 5120
export const UNSIGNED_BYTE = 5121
export const SHORT = 5122
export const UNSIGNED_SHORT = 5123
export const UNSIGNED_INT = 5125
export const FLOAT = 5126

const ARRAY_BUFFER = 34962

export class BufferWriter {
  constructor () {
    this.currentBuffer = new Uint8Array(1024 * 1024) // 1MB initial
    this.currentOffset = 0
    this.bufferViews = []
    this.accessors = []
  }

  ensureCapacity (additionalBytes) {
    if (this.currentOffset + additionalBytes > this.currentBuffer.length) {
      let newSize = this.currentBuffer.length * 2
      while (newSize < this.currentOffset + additionalBytes) newSize *= 2
      const newBuffer = new Uint8Array(newSize)
      newBuffer.set(this.currentBuffer)
      this.currentBuffer = newBuffer
    }
  }

  align (alignment = 4) {
    const remainder = this.currentOffset % alignment
    if (remainder !== 0) {
      const padding = alignment - remainder
      this.ensureCapacity(padding)
      this.currentOffset += padding
    }
  }

  writeFloat32Array (array) {
    this.align(4)
    const floatArray = array instanceof Float32Array ? array : new Float32Array(array)
    const byteLength = floatArray.length * 4
    this.ensureCapacity(byteLength)
    const view = new DataView(this.currentBuffer.buffer, this.currentOffset, byteLength)
    for (let i = 0; i < floatArray.length; i++) {
      view.setFloat32(i * 4, floatArray[i], true)
    }
    const offset = this.currentOffset
    this.currentOffset += byteLength
    return offset
  }

  writeUint16Array (array) {
    this.align(2)
    const uintArray = array instanceof Uint16Array ? array : new Uint16Array(array)
    const byteLength = uintArray.length * 2
    this.ensureCapacity(byteLength)
    const view = new DataView(this.currentBuffer.buffer, this.currentOffset, byteLength)
    for (let i = 0; i < uintArray.length; i++) {
      view.setUint16(i * 2, uintArray[i], true)
    }
    const offset = this.currentOffset
    this.currentOffset += byteLength
    return offset
  }

  writeUint8Array (array) {
    const uintArray = array instanceof Uint8Array ? array : new Uint8Array(array)
    const byteLength = uintArray.length
    this.ensureCapacity(byteLength)
    this.currentBuffer.set(uintArray, this.currentOffset)
    const offset = this.currentOffset
    this.currentOffset += byteLength
    return offset
  }

  /**
   * Write attribute data and create its bufferView + accessor.
   * @param {Float32Array|Uint16Array|Uint8Array} array
   * @param {number} componentType - one of the BYTE/SHORT/FLOAT constants
   * @param {string} accessorType - 'SCALAR' | 'VEC2' | 'VEC3' | 'VEC4' | 'MAT4'
   * @param {number} target - ARRAY_BUFFER, ELEMENT_ARRAY_BUFFER, or 0 for no target
   * @returns {{bufferView:number, byteOffset:number, count:number, min:Array, max:Array}}
   */
  writeAccessor (array, componentType, accessorType, target = ARRAY_BUFFER) {
    this.align(4)
    const byteOffset = this.currentOffset

    if (componentType === FLOAT) {
      const floatArray = array instanceof Float32Array ? array : new Float32Array(array)
      this.writeFloat32Array(floatArray)
    } else if (componentType === UNSIGNED_SHORT) {
      const uintArray = array instanceof Uint16Array ? array : new Uint16Array(array)
      this.writeUint16Array(uintArray)
    } else {
      const uintArray = array instanceof Uint8Array ? array : new Uint8Array(array)
      this.writeUint8Array(uintArray)
    }

    const byteLength = this.currentOffset - byteOffset

    const bufferView = this.bufferViews.length
    const bufferViewDef = {
      buffer: 0,
      byteOffset,
      byteLength
    }
    if (target) bufferViewDef.target = target
    this.bufferViews.push(bufferViewDef)

    const count = accessorType === 'MAT4' ? array.length / 16 : array.length / typeSize(accessorType)
    const accessor = {
      bufferView,
      byteOffset: 0,
      componentType,
      count,
      type: accessorType
    }

    let min = null
    let max = null
    if (target === ARRAY_BUFFER && componentType === FLOAT) {
      const minMax = computeMinMax(array, accessorType)
      if (minMax) {
        accessor.min = minMax.min
        accessor.max = minMax.max
        min = minMax.min
        max = minMax.max
      }
    }

    this.accessors.push(accessor)
    return { bufferView, byteOffset, count, min, max }
  }

  /**
   * Finalize the single binary buffer (trimmed to actual size).
   * @returns {Uint8Array}
   */
  finalizeBuffer () {
    const finalBuffer = this.currentBuffer.slice(0, this.currentOffset)
    this.currentBuffer = finalBuffer
    return finalBuffer
  }

  /**
   * Get the finalized buffer data.
   */
  getBuffer () {
    if (!this.buffersFinalized) {
      this.finalizeBuffer()
      this.buffersFinalized = true
    }
    return this.currentBuffer
  }
}

function typeSize (accessorType) {
  switch (accessorType) {
    case 'SCALAR': return 1
    case 'VEC2': return 2
    case 'VEC3': return 3
    case 'VEC4': return 4
    case 'MAT2': return 4
    case 'MAT3': return 9
    case 'MAT4': return 16
    default: return 1
  }
}

function computeMinMax (array, accessorType) {
  const size = typeSize(accessorType)
  if (size === 0 || size === 16) return null
  if (array.length === 0) return null
  const min = new Array(size).fill(Infinity)
  const max = new Array(size).fill(-Infinity)
  const count = array.length / size
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < size; c++) {
      const v = array[i * size + c]
      if (v < min[c]) min[c] = v
      if (v > max[c]) max[c] = v
    }
  }
  return { min, max }
}
