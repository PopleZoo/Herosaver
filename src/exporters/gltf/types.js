/**
 * Internal representation of the glTF export data
 * This is the intermediate representation before writing to glTF format
 */

export class GltfExportModel {
  constructor () {
    this.scenes = []
    this.nodes = []
    this.meshes = []
    this.materials = []
    this.textures = []
    this.images = []
    this.skins = []
    this.animations = []
    this.accessors = []
    this.bufferViews = []
    this.buffers = []
    this.samplers = []
    this.cameras = []
    this.extensionsUsed = []
    this.extensionsRequired = []
  }
}

export class GltfMesh {
  constructor (name) {
    this.name = name
    this.primitives = []
    this.weights = [] // morph target weights
  }
}

export class GltfPrimitive {
  constructor () {
    this.attributes = {} // POSITION, NORMAL, TEXCOORD_0, JOINTS_0, WEIGHTS_0, etc.
    this.indices = null
    this.material = null
    this.targets = [] // morph targets
    this.mode = 4 // TRIANGLES
  }
}

export class GltfMaterial {
  constructor (name) {
    this.name = name
    this.pbrMetallicRoughness = {
      baseColorFactor: [1, 1, 1, 1],
      baseColorTexture: null,
      metallicRoughnessTexture: null,
      metallicFactor: 1,
      roughnessFactor: 1
    }
    this.normalTexture = null
    this.occlusionTexture = null
    this.emissiveTexture = null
    this.emissiveFactor = [0, 0, 0]
    this.alphaMode = 'OPAQUE'
    this.alphaCutoff = 0.5
    this.doubleSided = false
  }
}

export class GltfTexture {
  constructor (sampler, source) {
    this.sampler = sampler
    this.source = source
  }
}

export class GltfImage {
  constructor (uri, mimeType, bufferView = null) {
    this.uri = uri
    this.mimeType = mimeType
    this.bufferView = bufferView
    this.name = null
  }
}

export class GltfSampler {
  constructor () {
    this.magFilter = 9729 // LINEAR
    this.minFilter = 9987 // LINEAR_MIPMAP_LINEAR
    this.wrapS = 10497 // REPEAT
    this.wrapT = 10497 // REPEAT
  }
}

export class GltfSkin {
  constructor (name) {
    this.name = name
    this.joints = [] // node indices
    this.inverseBindMatrices = null // accessor index
    this.skeleton = null // root node index
  }
}

export class GltfNode {
  constructor (name) {
    this.name = name
    this.children = []
    this.mesh = null
    this.skin = null
    this.matrix = null // 16 elements
    this.translation = [0, 0, 0]
    this.rotation = [0, 0, 0, 1] // quaternion
    this.scale = [1, 1, 1]
    this.weights = [] // morph target weights
    this.camera = null
    this.skin = null
    this.mesh = null
  }
}

export class GltfAccessor {
  constructor (bufferView, componentType, count, type, min = null, max = null) {
    this.bufferView = bufferView
    this.componentType = componentType // 5120=BYTE, 5121=UNSIGNED_BYTE, 5122=SHORT, 5123=UNSIGNED_SHORT, 5125=UNSIGNED_INT, 5126=FLOAT
    this.count = count
    this.type = type // SCALAR, VEC2, VEC3, VEC4, MAT2, MAT3, MAT4
    this.min = min
    this.max = max
    this.name = null
  }
}

export class GltfBufferView {
  constructor (buffer, byteOffset, byteLength, target = null) {
    this.buffer = buffer
    this.byteOffset = byteOffset
    this.byteLength = byteLength
    this.target = target // 34962 = ARRAY_BUFFER, 34963 = ELEMENT_ARRAY_BUFFER
  }
}

export class GltfBuffer {
  constructor (byteLength, uri = null) {
    this.byteLength = byteLength
    this.uri = uri // data URI for embedded
  }
}
