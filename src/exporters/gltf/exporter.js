/**
 * Main glTF 2.0 Exporter for HeroSaver
 * Coordinates all export modules and produces glTF 2.0 output.
 *
 * Unlike the OBJ/STL export (which bakes every vertex to world space through
 * process()), glTF export traverses the ORIGINAL scene graph so the rig survives:
 * bones become glTF nodes, the skeleton's boneInverses become inverse bind
 * matrices, and skin0/skin1/skin2 sawtooth weights are decoded into JOINTS_0 /
 * WEIGHTS_0. Coordinate system is Y-up right-handed (glTF = three.js), so no
 * axis rotation or scale is applied.
 */

import { BufferWriter, FLOAT, UNSIGNED_SHORT, UNSIGNED_INT } from './buffers'

const ARRAY_BUFFER = 34962
const ELEMENT_ARRAY_BUFFER = 34963

/**
 * Decode HeroForge sawtooth-encoded blend weight: abs(mod(v + 1.0, 2.0) - 1.0)
 */
function decodeWeight (v) {
  let m = (v + 1.0) % 2.0
  if (m < 0) m += 2.0
  return Math.abs(m - 1.0)
}

/**
 * Collect the top-4 bone influences per vertex from skin0/skin1/skin2.
 * @returns {{joints: Uint16Array, weights: Float32Array}}
 */
function extractSkin (geometry, skeleton) {
  const pos = geometry.getAttribute('position')
  const count = pos ? pos.count : 0
  const joints = new Uint16Array(count * 4)
  const weights = new Float32Array(count * 4)

  if (!skeleton) return { joints, weights }

  const names = (geometry.skinNames || ['skin0']).slice(0, 3)

  for (let i = 0; i < count; i++) {
    const influences = []

    for (const sname of names) {
      const attr = geometry.getAttribute(sname)
      if (!attr) continue

      const pairsPerAttr = attr.itemSize / 2
      const base = i * attr.itemSize
      for (let p = 0; p < pairsPerAttr; p++) {
        const boneIndex = Math.round(attr.array[base + p * 2])
        const weight = decodeWeight(attr.array[base + p * 2 + 1])
        if (weight > 0 && boneIndex < skeleton.bones.length) {
          influences.push({ boneIndex, weight })
        }
      }
    }

    influences.sort((a, b) => b.weight - a.weight)
    const top4 = influences.slice(0, 4)
    let sum = 0
    for (const inf of top4) sum += inf.weight

    for (let j = 0; j < 4; j++) {
      if (j < top4.length) {
        joints[i * 4 + j] = top4[j].boneIndex
        weights[i * 4 + j] = sum > 0 ? top4[j].weight / sum : 0
      } else {
        joints[i * 4 + j] = 0
        weights[i * 4 + j] = 0
      }
    }
  }

  return { joints, weights }
}

/**
 * glTF requires morph deltas (base + delta * weight). three.js stores absolute
 * positions when morphTargetsRelative is false.
 */
function toRelativeMorph (morphAttr, baseAttr) {
  const out = morphAttr.clone()
  const count = out.count
  for (let j = 0; j < count; j++) {
    out.setXYZ(j,
      out.getX(j) - baseAttr.getX(j),
      out.getY(j) - baseAttr.getY(j),
      out.getZ(j) - baseAttr.getZ(j)
    )
  }
  return out
}

/**
 * Ensure geometry.morphAttributes.position is populated (some HeroForge meshes
 * store morph targets as plain morphTargetN attributes).
 */
function ensureMorphAttributes (geometry) {
  if (geometry.morphAttributes && geometry.morphAttributes.position) return
  const list = []
  let i = 0
  while (true) {
    const attr = geometry.getAttribute('morphTarget' + i)
    if (!attr) break
    list.push(attr)
    i++
  }
  if (list.length) {
    geometry.morphAttributes = geometry.morphAttributes || {}
    geometry.morphAttributes.position = list
  }
}

/**
 * Main glTF export function
 * @param {Object} options - Export options
 * @param {Array} options.roots - original export roots (getExportRoots())
 * @param {number} options.subdivisions - unused for rigged export
 * @param {boolean} options.mirroredPose - unused
 * @param {boolean} options.embedBuffers - embed buffer as data URI
 * @param {Map} options.textureDataUris - texture uuid -> data URI (color atlases)
 * @param {Set} options.skipUuids - mesh uuids to skip (display case / dome)
 * @returns {Object} { gltf, buffers }
 */
export async function exportGltf (options = {}) {
  const roots = options.roots || []
  const skipUuids = options.skipUuids || new Set()
  const textureDataUris = options.textureDataUris || new Map()

  if (roots.length === 0) return { gltf: null, buffers: [] }

  roots.forEach(root => root.updateMatrixWorld(true))

  const bufferWriter = new BufferWriter()

  const gltf = {
    asset: {
      version: '2.0',
      generator: 'Herosaver',
      copyright: 'Exported from HeroForge'
    },
    scene: 0,
    scenes: [{ name: 'Scene', nodes: [] }],
    nodes: [],
    meshes: [],
    materials: [],
    textures: [],
    images: [],
    samplers: [{
      magFilter: 9729,
      minFilter: 9987,
      wrapS: 10497,
      wrapT: 10497
    }],
    accessors: [],
    bufferViews: [],
    buffers: [],
    skins: []
  }

  // texture data URI -> image index
  const imageIndexByUri = new Map()
  // material uuid -> glTF material index
  const materialIndexByUuid = new Map()
  // object uuid -> node index
  const nodeIndexByUuid = new Map()
  // gltf node index -> object
  const nodeObjectByIndex = []
  // accessor key -> accessor index (dedupe repeated geometry)
  const accessorCache = new Map()
  // mesh cache key -> mesh index (dedupe shared geometry + material)
  const meshCache = new Map()

  const getImageIndex = uri => {
    if (imageIndexByUri.has(uri)) return imageIndexByUri.get(uri)
    const index = gltf.images.length
    gltf.images.push({ uri, name: 'atlas_' + index })
    gltf.textures.push({ sampler: 0, source: index })
    imageIndexByUri.set(uri, index)
    return index
  }

  const getMaterialIndex = mesh => {
    const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    if (!m || !m.uuid) return 0
    if (materialIndexByUuid.has(m.uuid)) return materialIndexByUuid.get(m.uuid)

    const gltfMaterial = {
      name: m.name || 'material_' + gltf.materials.length,
      pbrMetallicRoughness: {
        baseColorFactor: [1, 1, 1, 1],
        metallicFactor: 0,
        roughnessFactor: 1
      },
      doubleSided: false
    }

    // HeroForge samples a shared color atlas through the colorAtlasMap uniform,
    // with per-mesh rects given by uvPosScl (offset.xy, scale.zw). The UVs are
    // remapped into atlas space at write time, so the atlas can be the base
    // color texture.
    const atlasTex = m.uniforms && m.uniforms.colorAtlasMap && m.uniforms.colorAtlasMap.value
    const uri = atlasTex && textureDataUris.get(atlasTex.uuid)
    if (uri) {
      gltfMaterial.pbrMetallicRoughness.baseColorTexture = {
        index: getImageIndex(uri),
        texCoord: 0
      }
    }

    const index = gltf.materials.length
    gltf.materials.push(gltfMaterial)
    materialIndexByUuid.set(m.uuid, index)
    return index
  }

  // Write one accessor per attribute into the buffer.
  const writeAttribute = (key, array, itemSize, componentType = FLOAT, target = ARRAY_BUFFER) => {
    if (accessorCache.has(key)) return accessorCache.get(key)

    let type = 'SCALAR'
    if (itemSize === 2) type = 'VEC2'
    else if (itemSize === 3) type = 'VEC3'
    else if (itemSize === 4) type = 'VEC4'
    else if (itemSize === 16) type = 'MAT4'

    const res = bufferWriter.writeAccessor(array, componentType, type, target)

    const accessor = {
      bufferView: res.bufferView,
      componentType,
      count: res.count,
      type
    }
    if (res.min !== undefined && res.min !== null) {
      accessor.min = Array.from(res.min)
      accessor.max = Array.from(res.max)
    }

    const accessorIndex = gltf.accessors.length
    gltf.accessors.push(accessor)
    accessorCache.set(key, accessorIndex)
    return accessorIndex
  }

  const geometryKey = geometry => (geometry.uuid || (geometry.attributes.position && geometry.attributes.position.uuid) || 'g')

  // ── Mesh writing ─────────────────────────────────────────────────────────
  const processMesh = mesh => {
    const geometry = mesh.geometry
    if (!geometry || typeof geometry.getAttribute !== 'function') return null
    const pos = geometry.getAttribute('position')
    if (!pos) return null

    const primitive = { attributes: {}, mode: 4 }

    // uvPosScl remap into atlas space (offset.xy, scale.zw) - identical to saveObj.
    const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const uvps = m && m.uniforms && m.uniforms.uvPosScl && m.uniforms.uvPosScl.value

    const gkey = geometryKey(geometry)

    // POSITION
    const posKey = 'pos_' + gkey
    primitive.attributes.POSITION = writeAttribute(posKey, pos.array, 3, FLOAT)

    // NORMAL
    const normal = geometry.getAttribute('normal')
    if (normal) {
      primitive.attributes.NORMAL = writeAttribute('nor_' + gkey, normal.array, 3, FLOAT)
    }

    // TEXCOORD_0 (remapped into the atlas rectangle)
    const uv = geometry.getAttribute('uv')
    if (uv) {
      let uvArray = uv.array
      if (uvps) {
        uvArray = new Float32Array(uv.array.length)
        for (let i = 0; i < uv.count; i++) {
          uvArray[i * 2] = uv.getX(i) * uvps.z + uvps.x
          uvArray[i * 2 + 1] = uv.getY(i) * uvps.w + uvps.y
        }
      }
      const uvKey = 'uv_' + gkey + '_' + (uvps ? [uvps.x, uvps.y, uvps.z, uvps.w].map(n => +n.toFixed(6)).join(',') : 'raw')
      primitive.attributes.TEXCOORD_0 = writeAttribute(uvKey, uvArray, 2, FLOAT)
    }

    // Indices
    if (geometry.index) {
      const indexAttr = geometry.index
      let maxIndex = 0
      for (let i = 0; i < indexAttr.array.length; i++) {
        if (indexAttr.array[i] > maxIndex) maxIndex = indexAttr.array[i]
      }
      const needs32 = maxIndex >= 65536
      const idxKey = 'idx_' + gkey + (needs32 ? '_32' : '_16')
      let idxArray = indexAttr.array
      let componentType = UNSIGNED_SHORT
      if (needs32 && !(idxArray instanceof Uint32Array)) {
        idxArray = new Uint32Array(idxArray)
        componentType = UNSIGNED_INT
      }
      primitive.indices = writeAttribute(idxKey, idxArray, 1, componentType, ELEMENT_ARRAY_BUFFER)
    }

    // Skin (JOINTS_0 / WEIGHTS_0) for skinned meshes
    const isSkinned = mesh.isSkinnedMesh ||
      (mesh.skeleton && mesh.skeleton.bones && mesh.skeleton.bones.length > 0)
    const skinKey = isSkinned && mesh.skeleton
      ? mesh.skeleton.bones.map(b => b.uuid).join(',')
      : 'none'
    if (isSkinned && mesh.skeleton) {
      const { joints, weights } = extractSkin(geometry, mesh.skeleton)
      primitive.attributes.JOINTS_0 = writeAttribute('jnt_' + skinKey + '_' + gkey, joints, 4, UNSIGNED_SHORT)
      primitive.attributes.WEIGHTS_0 = writeAttribute('wgt_' + skinKey + '_' + gkey, weights, 4, FLOAT)
    }

    // Morph targets
    let targetWeights = null
    let targetNames = null
    if (mesh.morphTargetInfluences !== undefined && mesh.morphTargetInfluences.length > 0) {
      ensureMorphAttributes(geometry)
      const morphList = geometry.morphAttributes.position || []
      const baseAttr = geometry.attributes.position
      const targets = []
      targetWeights = mesh.morphTargetInfluences

      if (mesh.morphTargetDictionary) {
        const reverse = {}
        for (const key in mesh.morphTargetDictionary) {
          reverse[mesh.morphTargetDictionary[key]] = key
        }
        targetNames = mesh.morphTargetInfluences.map((_, i) => reverse[i])
      }

      for (let i = 0; i < morphList.length; i++) {
        let relative = morphList[i]
        if (!geometry.morphTargetsRelative) {
          relative = toRelativeMorph(relative, baseAttr)
        }
        const morphKey = 'morph' + i + '_' + gkey
        targets.push({ POSITION: writeAttribute(morphKey, relative.array, 3, FLOAT) })
      }

      if (targets.length) primitive.targets = targets
    }

    const materialIndex = getMaterialIndex(mesh)

    // Dedupe identical meshes (shared geometry + material) to one glTF mesh.
    const meshCacheKey = 'mesh_' + gkey + '_' + materialIndex + '_' + skinKey + '_' + (primitive.targets ? primitive.targets.length : 0)
    if (meshCache.has(meshCacheKey)) return meshCache.get(meshCacheKey)

    const gltfMesh = {
      name: mesh.name || 'mesh_' + gltf.meshes.length,
      primitives: [{ ...primitive, material: materialIndex }]
    }

    if (targetWeights) gltfMesh.weights = targetWeights
    if (targetNames && targetNames.length) {
      gltfMesh.extras = { targetNames }
    }

    const meshIndex = gltf.meshes.length
    gltf.meshes.push(gltfMesh)
    meshCache.set(meshCacheKey, meshIndex)
    return meshIndex
  }

  // ── Node hierarchy ────────────────────────────────────────────────────────
  // Walk the original scene graph. Each object becomes a glTF node with its
  // LOCAL matrix (relative to parent) so glTF composes the same world matrices.
  // Skinned mesh children include their bones, giving the joint node hierarchy.
  const seen = new Set()

  const processNode = (object, parentObject) => {
    if (!object || seen.has(object.uuid)) return null
    seen.add(object.uuid)

    // Skip display-case / dome shells (never exported in OBJ/STL either).
    if (skipUuids.has(object.uuid)) return null

    object.updateMatrix()

    const gltfNode = {}
    if (object.name) gltfNode.name = object.name

    // Local matrix: parentObject is the object whose node is the parent. The
    // local transform is parentWorld^-1 * objectWorld, so glTF composes the
    // exact world matrices HeroForge has computed (handles any scene depth,
    // including bones whose parents are skinned meshes or other bones).
    if (parentObject === null) {
      gltfNode.matrix = object.matrixWorld.elements.slice()
    } else {
      const local = parentObject.matrixWorld.clone().invert().multiply(object.matrixWorld)
      gltfNode.matrix = local.elements.slice()
    }

    // Attach mesh
    if (object.isMesh || object.isSkinnedMesh || (object.geometry && object.geometry.isBufferGeometry)) {
      const meshIndex = processMesh(object)
      if (meshIndex !== null) gltfNode.mesh = meshIndex
    }

    const children = []
    for (const child of object.children) {
      const childNode = processNode(child, object)
      if (childNode !== null) children.push(childNode)
    }
    if (children.length) gltfNode.children = children

    const nodeIndex = gltf.nodes.length
    gltf.nodes.push(gltfNode)
    nodeIndexByUuid.set(object.uuid, nodeIndex)
    nodeObjectByIndex[nodeIndex] = object
    return nodeIndex
  }

  const sceneNodes = []
  for (const root of roots) {
    if (seen.has(root.uuid)) continue
    const idx = processNode(root, null)
    if (idx !== null) sceneNodes.push(idx)
  }
  gltf.scenes[0].nodes = sceneNodes

  // ── Skins ─────────────────────────────────────────────────────────────────
  // After nodes exist, attach a skin to every skinned mesh node. Bones that are
  // NOT in the scene graph (some HeroForge compositions keep bones detached from
  // the mesh's children) get synthesized nodes parented under the mesh node, so
  // the joint hierarchy is always complete.
  //
  // One skin per UNIQUE skeleton: kitbashed / multi-part characters often have
  // several skinned meshes sharing a single THREE.Skeleton (or clones with the
  // same bone set). Emitting a separate glTF skin for each would produce
  // duplicate armatures in Blender and the "skeletons won't merge" warning, so
  // meshes that share a skeleton are pointed at the same skin index.
  const skinIndexBySkeleton = new Map()

  // Key a skeleton by the identity of the bones it wraps. Kitbashing often
  // clones the THREE.Skeleton wrapper (different skeleton.uuid) around the same
  // bone objects, so a uuid-only map would still emit duplicate armatures.
  const skeletonKey = skeleton => {
    const sig = skeleton.bones.map(b => b.uuid).join(',')
    if (skeleton._herosaverSkinKey === undefined) skeleton._herosaverSkinKey = sig
    return skeleton._herosaverSkinKey
  }

  for (let nodeIndex = 0; nodeIndex < nodeObjectByIndex.length; nodeIndex++) {
    const object = nodeObjectByIndex[nodeIndex]
    if (!object || !object.skeleton || !object.skeleton.bones || !object.skeleton.bones.length) continue

    const skeleton = object.skeleton
    const key = skeletonKey(skeleton)
    let skinIndex = skinIndexBySkeleton.get(key)
    if (skinIndex !== undefined) {
      // Shared skeleton - reuse the existing skin so Blender merges the armature.
      gltf.nodes[nodeIndex].skin = skinIndex
      continue
    }

    const joints = []
    const inverseBind = new Float32Array(skeleton.bones.length * 16)
    let missingBone = false
    for (let i = 0; i < skeleton.bones.length; i++) {
      const bone = skeleton.bones[i]
      let boneNodeIndex = nodeIndexByUuid.get(bone.uuid)
      if (boneNodeIndex === undefined) {
        // Bone not visited during scene traversal - synthesize a node whose
        // matrix places it correctly relative to the mesh node (so composed
        // world matrix = bone.matrixWorld).
        const local = object.matrixWorld.clone().invert().multiply(bone.matrixWorld)
        const gltfNode = {}
        if (bone.name) gltfNode.name = bone.name
        gltfNode.matrix = local.elements.slice()
        boneNodeIndex = gltf.nodes.length
        gltf.nodes.push(gltfNode)
        nodeIndexByUuid.set(bone.uuid, boneNodeIndex)
        nodeObjectByIndex[boneNodeIndex] = bone
        missingBone = true
      }
      joints.push(boneNodeIndex)
      skeleton.boneInverses[i].elements.forEach((v, j) => { inverseBind[i * 16 + j] = v })
    }

    if (!joints.length) continue

    // Parent the synthesized root bone under the mesh node so glTF composes the
    // correct world matrix (synthesized bones are relative to the mesh).
    if (missingBone) {
      const rootBone = skeleton.bones[0]
      const rootBoneNodeIndex = nodeIndexByUuid.get(rootBone.uuid)
      if (!gltf.nodes[nodeIndex].children) gltf.nodes[nodeIndex].children = []
      if (!gltf.nodes[nodeIndex].children.includes(rootBoneNodeIndex)) {
        gltf.nodes[nodeIndex].children.push(rootBoneNodeIndex)
      }
    }

    const ibmAccessor = writeAttribute('ibm_' + skeleton.uuid, inverseBind, 16, FLOAT)

    skinIndex = gltf.skins.length
    gltf.skins.push({
      name: skeleton.name || 'skin_' + skinIndex,
      joints,
      inverseBindMatrices: ibmAccessor,
      skeleton: joints[0]
    })
    skinIndexBySkeleton.set(skeleton.uuid, skinIndex)

    gltf.nodes[nodeIndex].skin = skinIndex
  }

  // ── Finalize ──────────────────────────────────────────────────────────────
  const buffer = bufferWriter.finalizeBuffer()
  gltf.bufferViews = bufferWriter.bufferViews
  gltf.buffers = [{ byteLength: buffer.byteLength }]

  return { gltf, buffers: [buffer] }
}
