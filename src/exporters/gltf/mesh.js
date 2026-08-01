/**
 * Mesh extraction for glTF export
 * Extracts geometry data from Three.js meshes
 */

/**
 * Write Float32Array to buffer and return offset
 */
function writeFloat32Array (bufferWriter, array) {
  const floatArray = array instanceof Float32Array ? array : new Float32Array(array)
  return bufferWriter.writeFloat32Array(floatArray)
}

/**
 * Write Uint16Array to buffer
 */
function writeUint16Array (bufferWriter, array) {
  const uintArray = array instanceof Uint16Array ? array : new Uint16Array(array)
  return bufferWriter.writeUint16Array(uintArray)
}

export function createMeshPrimitive (mesh, bufferWriter) {
  const geometry = mesh.geometry
  const positionAttr = geometry.getAttribute('position')
  const normalAttr = geometry.getAttribute('normal')
  const uvAttr = geometry.getAttribute('uv')
  const indexAttr = geometry.index

  const primitive = {
    attributes: {},
    mode: 4, // TRIANGLES
    targets: [] // morph targets
  }

  // POSITION
  writeFloat32Array(bufferWriter, positionAttr.array)
  primitive.attributes.POSITION = 0

  // NORMAL
  if (normalAttr) {
    writeFloat32Array(bufferWriter, normalAttr.array)
    primitive.attributes.NORMAL = 0
  }

  // TEXCOORD_0
  if (uvAttr) {
    writeFloat32Array(bufferWriter, uvAttr.array)
    primitive.attributes.TEXCOORD_0 = 0
  }

  // Indices
  if (indexAttr) {
    writeUint16Array(bufferWriter, indexAttr.array)
  }

  return { primitive }
}

export function extractMeshData (mesh, bufferWriter) {
  const geometry = mesh.geometry

  const primitive = {
    attributes: {},
    mode: 4,
    targets: []
  }

  // POSITION
  writeFloat32Array(bufferWriter, geometry.attributes.position.array)
  primitive.attributes.POSITION = 0

  // NORMAL
  if (geometry.attributes.normal) {
    writeFloat32Array(bufferWriter, geometry.attributes.normal.array)
    primitive.attributes.NORMAL = 0
  }

  // TEXCOORD_0
  if (geometry.attributes.uv) {
    writeFloat32Array(bufferWriter, geometry.attributes.uv.array)
    primitive.attributes.TEXCOORD_0 = 0
  }

  // Indices
  if (geometry.index) {
    writeUint16Array(bufferWriter, geometry.index.array)
  }

  return { primitive }
}

// BufferWriter is exported from buffers.js
