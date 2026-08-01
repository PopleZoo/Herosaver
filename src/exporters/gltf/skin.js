/**
 * Skin/weight extraction for glTF export
 * Handles skinIndex/skinWeight attribute extraction and glTF skin creation
 */

/**
 * Decode HeroForge sawtooth-encoded weights
 * Shader: abs(mod(v + 1.0, 2.0) - 1.0)
 */
function decodeWeight (v) {
  let m = (v + 1.0) % 2.0
  if (m < 0) m += 2.0
  return Math.abs(m - 1.0)
}

/**
 * Extract skin data from a Three.js SkinnedMesh geometry
 * @param {THREE.BufferGeometry} geometry
 * @param {THREE.SkinnedMesh} mesh
 * @returns {Object} Skin data with joints and weights arrays
 */
export function extractSkinData (geometry, mesh) {
  const vertexCount = geometry.attributes.position.count

  const jointIndices = new Uint16Array(vertexCount * 4)
  const weights = new Float32Array(vertexCount * 4)

  for (let i = 0; i < vertexCount; i++) {
    const influences = []

    for (const sname of ['skin0', 'skin1', 'skin2']) {
      const attr = geometry.getAttribute(sname)
      if (!attr) continue

      const pairsPerAttr = attr.itemSize / 2

      for (let p = 0; p < pairsPerAttr; p++) {
        const boneIndex = Math.round(attr.array[i * attr.itemSize + p * 2])
        const weight = decodeWeight(attr.array[i * attr.itemSize + p * 2 + 1])
        if (weight > 0) {
          influences.push({ boneIndex, weight })
        }
      }
    }

    influences.sort((a, b) => b.weight - a.weight)
    const top4 = influences.slice(0, 4)

    let weightSum = 0
    for (const inf of top4) weightSum += inf.weight

    for (let j = 0; j < 4; j++) {
      if (j < top4.length) {
        jointIndices[i * 4 + j] = top4[j].boneIndex
        weights[i * 4 + j] = top4[j].weight / (weightSum || 1)
      } else {
        jointIndices[i * 4 + j] = 0
        weights[i * 4 + j] = 0
      }
    }
  }

  return {
    joints: jointIndices,
    weights: weights,
    jointCount: 4
  }
}

/**
 * Write skin attributes (JOINTS_0, WEIGHTS_0) to buffer
 * @param {BufferWriter} bufferWriter
 * @param {Uint16Array} joints - joint indices (vertexCount * 4)
 * @param {Float32Array} weights - weights (vertexCount * 4)
 * @returns {Object} Buffer view and accessor indices
 */
export function writeSkinAttributes (bufferWriter, joints, weights) {
  // Write JOINTS_0 (UNSIGNED_SHORT, VEC4)
  bufferWriter.writeUint16Array(joints)
  bufferWriter.align(4)
  const jointsBufferViewIndex = bufferWriter.createBufferView(0, joints.length * 2, 34962)

  // Write weights
  bufferWriter.writeFloat32Array(new Float32Array(weights))
  bufferWriter.align(4)
  const weightsBufferViewIndex = bufferWriter.createBufferView(0, weights.length * 4, 34962)

  return {
    jointsBufferViewIndex,
    weightsBufferViewIndex
  }
}

/**
 * Create accessor objects for skin attributes
 * @param {BufferWriter} bufferWriter
 * @param {number} vertexCount
 * @param {number} jointsBufferViewIndex
 * @param {number} weightsBufferViewIndex
 * @returns {Object} { jointsAccessor, weightsAccessor }
 */
export function createSkinAccessors (bufferWriter, vertexCount, jointsBufferViewIndex, weightsBufferViewIndex) {
  const jointsAccessor = {
    bufferView: 0,
    componentType: 5123,
    count: 0,
    type: 'VEC4',
    name: 'JOINTS_0',
    min: [0, 0, 0, 0],
    max: [65535, 65535, 65535, 65535]
  }

  const weightsAccessor = {
    bufferView: 0,
    componentType: 5126,
    count: 0,
    type: 'VEC4',
    name: 'WEIGHTS_0',
    min: [0, 0, 0, 0],
    max: [1, 1, 1, 1]
  }

  return { jointsAccessor, weightsAccessor }
}

export function finalizeSkinAccessors (bufferWriter, vertexCount, jointsBufferViewIndex, weightsBufferViewIndex) {
  const jointsAccessor = {
    bufferView: 0,
    componentType: 5123,
    count: 0,
    type: 'VEC4',
    name: 'JOINTS_0',
    min: [0, 0, 0, 0],
    max: [65535, 65535, 65535, 65535]
  }

  const weightsAccessor = {
    bufferView: 0,
    componentType: 5126,
    count: vertexCount,
    type: 'VEC4',
    name: 'WEIGHTS_0',
    min: [0, 0, 0, 0],
    max: [1, 1, 1, 1]
  }

  return { jointsAccessor, weightsAccessor }
}
