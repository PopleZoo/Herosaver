/**
 * ASCII FBX 7.4 exporter for HeroSaver.
 *
 * Produces a self-contained ASCII .fbx (atlas textures embedded as base64 in
 * Video/Content) from the same inputs as the glTF exporter, so both formats
 * carry the rig:
 *   - the ORIGINAL scene graph is traversed (bones survive as Model/LimbNode
 *     nodes; local transforms become Lcl Translation/Rotation/Scaling),
 *   - invisible subtrees and the display-case shells are skipped (like OBJ/STL),
 *   - detached bones (kitbashing) are re-synthesized under their nearest bone
 *     ancestor or the mesh, mirroring the glTF exporter,
 *   - one Skin Deformer + one Cluster SubDeformer per bone plus a BindPose are
 *     emitted with the exact Transform/TransformLink semantics Blender writes
 *     and reads: Transform = boneWorld^-1 * meshWorld, TransformLink = boneWorld
 *     (column-major 16-value arrays, i.e. three's Matrix4.elements order),
 *   - per-mesh UVs are remapped into their atlas rectangle with the live
 *     shader's uvPosScl uniform, in the OBJ convention (v = 0 at the bottom).
 */

import { Vector3, Euler, Quaternion } from 'three'

const FBX_VERSION = 7400

// Compact, deterministic number formatting.
const fmt = v => String(parseFloat(v.toPrecision(10)))

// Sanitize a name for use inside an FBX string (keep alnum / - _).
const fbxName = s => String(s == null ? '' : s).replace(/[^a-zA-Z0-9._-]/g, '_') || 'Model'

// Version-safe matrix inverse (HeroForge's three.js predates Matrix4#invert).
function invertMatrix (m) {
  const out = m.clone()
  if (typeof out.invert === 'function') out.invert()
  else if (typeof out.getInverse === 'function') out.getInverse(m)
  return out
}

// Decode HeroForge sawtooth-encoded blend weight: abs(mod(v + 1.0, 2.0) - 1.0)
function decodeWeight (v) {
  let m = (v + 1.0) % 2.0
  if (m < 0) m += 2.0
  return Math.abs(m - 1.0)
}

// Collect the top-4 bone influences per vertex from skin0/skin1/skin2.
// Returns { joints, weights } with one 4-tuple per position vertex.
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
 * Snapshot a geometry into FBX-consistent arrays:
 *   positions   - control points (n * 3)
 *   polygonIndex- one triangle strip with the last index of each polygon negated
 *   normals/uvs - per-control-point arrays (when counts line up)
 *   indexArr    - per-polygon-corner index (geometry.index, or sequential)
 * When per-corner data (seamed UVs etc.) forces expansion, `expanded` is true
 * and `cornerRemap[i]` maps corner i back to its source position vertex (used to
 * remap skin attributes too).
 */
function geometryToFbx (geometry) {
  const pos = geometry.getAttribute('position')
  if (!pos) return null

  const normal = geometry.getAttribute('normal')
  const uv = geometry.getAttribute('uv')
  const n = pos.count
  let compatible = true
  if (normal && normal.count !== n) compatible = false
  if (uv && uv.count !== n) compatible = false

  let positions = pos.array
  let normals = normal ? normal.array : null
  let uvs = uv ? uv.array : null
  let polygonIndex
  let indexArr = null
  let expanded = false
  let cornerRemap = null

  if (geometry.index) {
    const idx = geometry.index.array
    polygonIndex = new Int32Array(idx.length)
    for (let i = 0; i < idx.length; i += 3) {
      polygonIndex[i] = idx[i]
      polygonIndex[i + 1] = idx[i + 1]
      polygonIndex[i + 2] = -(idx[i + 2] + 1)
    }
    if (compatible) indexArr = idx
  } else {
    polygonIndex = new Int32Array(n)
    for (let i = 0; i < n; i += 3) {
      polygonIndex[i] = i
      polygonIndex[i + 1] = i + 1
      polygonIndex[i + 2] = -(i + 3)
    }
  }

  if (!compatible) {
    // Per-corner data: expand everything so each polygon corner has its own
    // control point, and write everything "Direct" (no index arrays).
    const corners = polygonIndex.length
    const newPos = new Float32Array(corners * 3)
    const newNormals = normal ? new Float32Array(corners * 3) : null
    const newUvs = uv ? new Float32Array(corners * 2) : null
    cornerRemap = new Int32Array(corners)
    for (let i = 0; i < corners; i++) {
      const vi = geometry.index
        ? geometry.index.array[i]
        : i
      cornerRemap[i] = vi
      newPos.set(pos.array.subarray(vi * 3, vi * 3 + 3), i * 3)
      if (normal && newNormals) {
        newNormals.set(normal.array.subarray(vi * 3, vi * 3 + 3), i * 3)
      }
      if (uv && newUvs) {
        newUvs.set(uv.array.subarray(vi * 2, vi * 2 + 2), i * 2)
      }
    }
    positions = newPos
    normals = newNormals
    uvs = newUvs
    polygonIndex = new Int32Array(corners)
    for (let i = 0; i < corners; i += 3) {
      polygonIndex[i] = i
      polygonIndex[i + 1] = i + 1
      polygonIndex[i + 2] = -(i + 3)
    }
    indexArr = null
    expanded = true
  }

  return {
    positions,
    normals,
    uvs,
    polygonIndex,
    indexArr,
    expanded,
    cornerRemap,
    controlPointCount: positions.length / 3
  }
}

/**
 * Main FBX export function.
 * @param {Object} options - same shape as exportGltf()
 * @param {Array} options.roots - original export roots (getExportRoots())
 * @param {Set} options.skipUuids - mesh uuids to skip (display case / dome)
 * @param {Map} options.textureAtlas - texture uuid -> { file, dataUri, width, height }
 * @returns {Object} { fbx } - the ASCII FBX text, or { fbx: null } if empty
 */
export async function exportFbx (options = {}) {
  const roots = options.roots || []
  const skipUuids = options.skipUuids || new Set()
  const textureAtlas = options.textureAtlas || new Map()

  if (roots.length === 0) return { fbx: null }
  roots.forEach(root => root.updateMatrixWorld(true))

  // ── id / object registry ──────────────────────────────────────────────────
  let idCounter = 1000
  const nextId = () => idCounter++

  // fbxId -> { id, object, name, parentId }
  const nodesById = new Map()
  const idByObjectUuid = new Map()
  const objectByFbxId = new Map()

  const makeNode = (object, parentId) => {
    const id = nextId()
    idByObjectUuid.set(object.uuid, id)
    objectByFbxId.set(id, object)
    nodesById.set(id, { id, object, name: object.name, parentId })
    return id
  }

  // ── scene graph traversal (skip invisible + display-case shells) ──────────
  const seen = new Set()
  const processObject = (object, parentId) => {
    if (!object || seen.has(object.uuid)) return null
    seen.add(object.uuid)
    if (skipUuids.has(object.uuid)) return null
    if (object.visible === false) return null
    const id = makeNode(object, parentId)
    for (const child of object.children) processObject(child, id)
    return id
  }
  for (const root of roots) {
    processObject(root, null)
  }

  // ── skeletons ─────────────────────────────────────────────────────────────
  // Collect every skinned mesh, then ensure every bone has a node (synthesize
  // bones detached from the scene graph, mirroring the glTF exporter).
  const skinned = []
  for (const object of objectByFbxId.values()) {
    if (object.skeleton && object.skeleton.bones && object.skeleton.bones.length) {
      skinned.push(object)
    }
  }

  const allBones = []
  for (const object of skinned) {
    for (const b of object.skeleton.bones) {
      if (!allBones.includes(b)) allBones.push(b)
    }
  }
  // Shallowest bones first so ancestors exist when a parent is synthesized.
  const boneDepth = bone => {
    let d = 0
    let p = bone.parent
    while (p && allBones.includes(p)) { d++; p = p.parent }
    return d
  }
  allBones.sort((a, b) => boneDepth(a) - boneDepth(b))
  for (const bone of allBones) {
    if (idByObjectUuid.has(bone.uuid)) continue
    let parentId = null
    let p = bone.parent
    while (p) {
      const pid = idByObjectUuid.get(p.uuid)
      if (pid !== undefined) { parentId = pid; break }
      p = p.parent
    }
    if (parentId === null) {
      const owner = skinned.find(s => s.skeleton.bones.includes(bone))
      if (owner) parentId = idByObjectUuid.get(owner.uuid)
    }
    makeNode(bone, parentId)
  }

  // ── materials (one per atlas texture, lazy) ───────────────────────────────
  const materialByKey = new Map() // texture uuid (or 'none') -> material info
  const materialIdByModel = new Map() // fbxId -> material info
  const getMaterialForMesh = mesh => {
    const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const atlasTex = m && m.uniforms && m.uniforms.colorAtlasMap && m.uniforms.colorAtlasMap.value
    const entry = atlasTex && textureAtlas.get(atlasTex.uuid)
    const key = entry ? atlasTex.uuid : 'none'

    let mat = materialByKey.get(key)
    if (!mat) {
      mat = {
        materialId: nextId(),
        textureId: entry ? nextId() : null,
        videoId: entry ? nextId() : null,
        entry,
        name: entry ? entry.file.replace(/\.png$/i, '') : 'Material'
      }
      materialByKey.set(key, mat)
    }
    return mat
  }

  // ── emit buffer & helpers ─────────────────────────────────────────────────
  const out = []
  const push = s => out.push(s)
  const indent = l => '\t'.repeat(l)
  const connections = []
  const connect = (childId, parentId, type, property) => {
    connections.push([childId, parentId, type, property])
  }
  const matrixArr = m => Array.from(m.elements, fmt)

  const modelType = object => {
    if (object.isBone) return 'LimbNode'
    if (object.isMesh || object.isSkinnedMesh || (object.geometry && object.geometry.isBufferGeometry)) return 'Mesh'
    return 'Null'
  }

  const decompose = mat => {
    const pos = new Vector3()
    const quat = new Quaternion()
    const scale = new Vector3()
    mat.decompose(pos, quat, scale)
    // FBX stores Lcl Rotation as *extrinsic* XYZ euler angles (the SDK default,
    // RotationOrder 0). three's FBXLoader maps that value to the *intrinsic*
    // 'ZYX' order, so the angles must be decomposed in the same order for the
    // reconstructed world matrix to match the source matrix.
    const euler = new Euler().setFromQuaternion(quat, 'ZYX')
    return {
      t: [pos.x, pos.y, pos.z],
      r: [euler.x * 180 / Math.PI, euler.y * 180 / Math.PI, euler.z * 180 / Math.PI],
      s: [scale.x, scale.y, scale.z]
    }
  }

  // ── geometry + skin objects ───────────────────────────────────────────────
  for (const [id, object] of objectByFbxId) {
    if (modelType(object) !== 'Mesh') continue
    const geometry = object.geometry
    if (!geometry || typeof geometry.getAttribute !== 'function') continue
    const geo = geometryToFbx(geometry)
    if (!geo) continue

    const geometryId = nextId()
    const mat = getMaterialForMesh(object)
    materialIdByModel.set(id, mat)
    const isSkinned = object.skeleton && object.skeleton.bones && object.skeleton.bones.length

    const skin = isSkinned ? extractSkin(geometry, object.skeleton) : null

    // Geometry
    push(indent(1) + `Geometry: ${geometryId}, "${fbxName(object.name)}_geo", "Mesh" {`)
    push(indent(2) + 'GeometryVersion: 124')
    push(indent(2) + `Vertices: *${geo.positions.length} {`)
    push(indent(3) + 'a: ' + Array.from(geo.positions, fmt).join(','))
    push(indent(2) + '}')
    push(indent(2) + `PolygonVertexIndex: *${geo.polygonIndex.length} {`)
    push(indent(3) + 'a: ' + Array.from(geo.polygonIndex).join(','))
    push(indent(2) + '}')

    // UVs (OBJ convention, v = 0 at the bottom - do NOT flip)
    const m = Array.isArray(object.material) ? object.material[0] : object.material
    const uvps = m && m.uniforms && m.uniforms.uvPosScl && m.uniforms.uvPosScl.value
    // When per-corner data forces expansion there is no index array, so the
    // layer must use "Direct" reference (an IndexToDirect layer with a
    // missing index array leaves undefined indices and corrupts the data).
    const refType = geo.indexArr ? 'IndexToDirect' : 'Direct'
    let uvsOut = geo.uvs
    if (geo.uvs) {
      if (uvps) {
        uvsOut = new Float32Array(geo.uvs.length)
        for (let i = 0; i < geo.uvs.length / 2; i++) {
          uvsOut[i * 2] = geo.uvs[i * 2] * uvps.z + uvps.x
          uvsOut[i * 2 + 1] = geo.uvs[i * 2 + 1] * uvps.w + uvps.y
        }
      }
      push(indent(2) + 'LayerElementUV: 0 {')
      push(indent(3) + 'Version: 101')
      push(indent(3) + 'Name: "UVMap"')
      push(indent(3) + 'MappingInformationType: "ByPolygonVertex"')
      push(indent(3) + `ReferenceInformationType: "${refType}"`)
      push(indent(3) + `UV: *${uvsOut.length} {`)
      push(indent(4) + 'a: ' + Array.from(uvsOut, fmt).join(','))
      push(indent(3) + '}')
      if (geo.indexArr) {
        push(indent(3) + `UVIndex: *${geo.indexArr.length} {`)
        push(indent(4) + 'a: ' + Array.from(geo.indexArr).join(','))
        push(indent(3) + '}')
      }
      push(indent(2) + '}')
    }

    // Normals (ByPolygonVertex, IndexToDirect/Direct)
    if (geo.normals) {
      push(indent(2) + 'LayerElementNormal: 0 {')
      push(indent(3) + 'Version: 102')
      push(indent(3) + 'Name: ""')
      push(indent(3) + 'MappingInformationType: "ByPolygonVertex"')
      push(indent(3) + `ReferenceInformationType: "${refType}"`)
      push(indent(3) + `Normals: *${geo.normals.length} {`)
      push(indent(4) + 'a: ' + Array.from(geo.normals, fmt).join(','))
      push(indent(3) + '}')
      if (geo.indexArr) {
        push(indent(3) + `NormalsIndex: *${geo.indexArr.length} {`)
        push(indent(4) + 'a: ' + Array.from(geo.indexArr).join(','))
        push(indent(3) + '}')
      }
      push(indent(2) + '}')
    }

    // LayerElementMaterial (all polygons -> material index 0)
    const triangleCount = geo.polygonIndex.length / 3
    push(indent(2) + 'LayerElementMaterial: 0 {')
    push(indent(3) + 'Version: 101')
    push(indent(3) + 'Name: ""')
    push(indent(3) + 'MappingInformationType: "ByPolygon"')
    push(indent(3) + 'ReferenceInformationType: "IndexToDirect"')
    push(indent(3) + `Materials: *${triangleCount} {`)
    push(indent(4) + 'a: ' + new Array(triangleCount).fill(0).join(','))
    push(indent(3) + '}')
    push(indent(2) + '}')

    // Layer (some importers expect the Layer block)
    push(indent(2) + 'Layer: 0 {')
    push(indent(3) + 'Version: 100')
    if (geo.uvs) {
      push(indent(3) + 'LayerElement:  {')
      push(indent(4) + 'Type: "LayerElementUV"')
      push(indent(4) + 'TypedIndex: 0')
      push(indent(3) + '}')
    }
    if (geo.normals) {
      push(indent(3) + 'LayerElement:  {')
      push(indent(4) + 'Type: "LayerElementNormal"')
      push(indent(4) + 'TypedIndex: 0')
      push(indent(3) + '}')
    }
    push(indent(3) + 'LayerElement:  {')
    push(indent(4) + 'Type: "LayerElementMaterial"')
    push(indent(4) + 'TypedIndex: 0')
    push(indent(3) + '}')
    push(indent(2) + '}')
    push(indent(1) + '}')

    connect(geometryId, id, 'OO', null)

    // Skin deformer for skinned meshes
    if (isSkinned && skin) {
      const skinId = nextId()
      const bones = object.skeleton.bones
      let joints = skin.joints
      let weights = skin.weights

      // If geometry was expanded to per-corner control points, remap the skin
      // attributes the same way so cluster indices still match the Vertices.
      if (geo.expanded && geo.cornerRemap) {
        const corners = geo.positions.length / 3
        const newJoints = new Uint16Array(corners * 4)
        const newWeights = new Float32Array(corners * 4)
        for (let i = 0; i < corners; i++) {
          const src = geo.cornerRemap[i] * 4
          newJoints.set(joints.subarray(src, src + 4), i * 4)
          newWeights.set(weights.subarray(src, src + 4), i * 4)
        }
        joints = newJoints
        weights = newWeights
      }

      // Per-bone affected control points.
      const boneVertices = bones.map(() => [])
      for (let v = 0; v < geo.controlPointCount; v++) {
        for (let j = 0; j < 4; j++) {
          const w = weights[v * 4 + j]
          if (w <= 0) continue
          const b = joints[v * 4 + j]
          if (b >= bones.length) continue
          boneVertices[b].push([v, w])
        }
      }

      const meshWorld = object.matrixWorld
      const clusters = []
      for (let b = 0; b < bones.length; b++) {
        const boneWorld = bones[b].matrixWorld
        const clusterId = nextId()
        clusters.push({
          id: clusterId,
          bone: bones[b],
          transform: invertMatrix(boneWorld).multiply(meshWorld),
          transformLink: boneWorld,
          boneVertices: boneVertices[b]
        })
      }

      // Deformer (Skin). The Skin deformer connects to the GEOMETRY (not the
      // model): three's FBXLoader reads skeleton.geometryID from the skin's
      // parent connection and finds the skin via the geometry's children.
      push(indent(1) + `Deformer: ${skinId}, "${fbxName(object.name)}_Skin", "Skin" {`)
      push(indent(2) + 'Version: 101')
      push(indent(2) + 'Link_DeformAcuracy: 50')
      push(indent(2) + 'SkinningType: "Linear"')
      push(indent(1) + '}')
      push('')
      connect(skinId, geometryId, 'OO', null)

      for (const cluster of clusters) {
        const boneId = idByObjectUuid.get(cluster.bone.uuid)
        const idx = cluster.boneVertices.map(p => p[0])
        const wts = cluster.boneVertices.map(p => p[1])
        // Cluster objects are also written as "Deformer" nodes (the object type
        // is Deformer for both Skin and Cluster; the class name in the second
        // attr is the SubDeformer/Cluster discriminator). The loader iterates
        // fbxTree.Objects.Deformer for both, keying on attrType.
        push(indent(1) + `Deformer: ${cluster.id}, "${fbxName(object.name)}_cluster_${fbxName(cluster.bone.name)}", "Cluster" {`)
        push(indent(2) + 'Version: 100')
        push(indent(2) + 'UserData: "", ""')
        // Only emit Indexes/Weights when non-empty: the loader reads
        // boneNode.Indexes.a unconditionally when 'Indexes' is present, so an
        // empty node leaves `.a` undefined and crashes in the weightTable build.
        if (idx.length) {
          push(indent(2) + `Indexes: *${idx.length} {`)
          push(indent(3) + 'a: ' + idx.join(','))
          push(indent(2) + '}')
          push(indent(2) + `Weights: *${wts.length} {`)
          push(indent(3) + 'a: ' + wts.map(fmt).join(','))
          push(indent(2) + '}')
        }
        push(indent(2) + 'Mode: "Normal"')
        push(indent(2) + 'Transform: *16 {')
        push(indent(3) + 'a: ' + matrixArr(cluster.transform).join(','))
        push(indent(2) + '}')
        push(indent(2) + 'TransformLink: *16 {')
        push(indent(3) + 'a: ' + matrixArr(cluster.transformLink).join(','))
        push(indent(2) + '}')
        push(indent(1) + '}')
        push('')

        connect(cluster.id, skinId, 'OO', null)
        connect(boneId, cluster.id, 'OO', null)
      }

      // BindPose: the mesh + every bone, world matrices.
      const poseIds = [id]
      for (const cluster of clusters) {
        const boneId = idByObjectUuid.get(cluster.bone.uuid)
        if (!poseIds.includes(boneId)) poseIds.push(boneId)
      }
      const poseId = nextId()
      push(indent(1) + `Pose: ${poseId}, "Pose", "BindPose" {`)
      push(indent(2) + 'Version: 100')
      push(indent(2) + `NbPoseNodes: ${poseIds.length}`)
      for (const nodeId of poseIds) {
        const nodeObject = objectByFbxId.get(nodeId)
        if (!nodeObject) continue
        push(indent(2) + 'PoseNode: {')
        push(indent(3) + `Node: ${nodeId}`)
        push(indent(3) + 'Matrix: *16 {')
        push(indent(4) + 'a: ' + matrixArr(nodeObject.matrixWorld).join(','))
        push(indent(3) + '}')
        push(indent(2) + '}')
      }
      push(indent(1) + '}')
      push('')
    }

    connect(mat.materialId, id, 'OO', null)
    if (mat.textureId) {
      connect(mat.textureId, mat.materialId, 'OP', 'DiffuseColor')
      connect(mat.videoId, mat.textureId, 'OO', null)
    }
  }

  // ── Model nodes (hierarchy) ───────────────────────────────────────────────
  for (const node of nodesById.values()) {
    const object = node.object
    object.updateMatrix()
    const world = object.matrixWorld
    const local = node.parentId === null
      ? world.clone()
      : invertMatrix(objectByFbxId.get(node.parentId).matrixWorld).multiply(world)
    const dec = decompose(local)

    push(indent(1) + `Model: ${node.id}, "${fbxName(node.name)}", "${modelType(object)}" {`)
    push(indent(2) + 'Version: 232')
    push(indent(2) + 'Culling: "CullingOff"')
    push(indent(2) + 'Properties70: {')
    push(indent(3) + 'P: "RotationOrder", "enum", "", "", 0')
    push(indent(3) + `P: "Lcl Translation", "Lcl_Translation", "", "A", ${dec.t.map(fmt).join(',')}`)
    push(indent(3) + `P: "Lcl Rotation", "Lcl_Rotation", "", "A", ${dec.r.map(fmt).join(',')}`)
    push(indent(3) + `P: "Lcl Scaling", "Lcl_Scaling", "", "A", ${dec.s.map(fmt).join(',')}`)
    push(indent(2) + '}')
    push(indent(1) + '}')
    push('')

    if (node.parentId === null) connect(node.id, 0, 'OO', null)
    else connect(node.id, node.parentId, 'OO', null)
  }

  // ── Material / Texture / Video objects ────────────────────────────────────
  for (const mat of materialByKey.values()) {
    push(indent(1) + `Material: ${mat.materialId}, "${fbxName(mat.name)}", "Phong" {`)
    push(indent(2) + 'Version: 102')
    push(indent(2) + 'ShadingModel: "phong"')
    push(indent(2) + 'MultiLayer: 0')
    push(indent(2) + 'Properties70: {')
    push(indent(3) + 'P: "DiffuseColor", "Color", "", "A", 1,1,1')
    push(indent(2) + '}')
    push(indent(1) + '}')
    push('')

    if (mat.textureId && mat.entry) {
      const file = mat.entry.file
      const name = fbxName(mat.name)
      push(indent(1) + `Texture: ${mat.textureId}, "${name}", "" {`)
      push(indent(2) + 'Type: "TextureVideoClip"')
      push(indent(2) + 'Version: 202')
      push(indent(2) + `TextureName: "Texture::${name}"`)
      push(indent(2) + `Media: "Video::${name}_Video"`)
      push(indent(2) + `FileName: "${file}"`)
      push(indent(2) + `RelativeFilename: "${file}"`)
      push(indent(2) + 'Properties70: {')
      push(indent(3) + 'P: "Type", "KString", "", "", "TextureVideoClip"')
      push(indent(3) + 'P: "UVSet", "KString", "", "", "UVMap"')
      push(indent(3) + 'P: "WrapModeU", "enum", "", "", 1')
      push(indent(3) + 'P: "WrapModeV", "enum", "", "", 1')
      push(indent(3) + 'P: "UseMaterial", "bool", "", "", 1')
      push(indent(2) + '}')
      push(indent(2) + 'TextureAlpha: 1')
      push(indent(1) + '}')
      push('')

      push(indent(1) + `Video: ${mat.videoId}, "${name}_Video", "Clip" {`)
      push(indent(2) + 'Type: "Clip"')
      push(indent(2) + 'Version: 202')
      push(indent(2) + `FileName: "${file}"`)
      push(indent(2) + `RelativeFilename: "${file}"`)
      push(indent(2) + 'Content: "' + dataUriToBase64(mat.entry.dataUri) + '"')
      push(indent(1) + '}')
      push('')
    }
  }

  // ── assemble ASCII ────────────────────────────────────────────────────────
  const re = /^\t(Model|Geometry|Material|Texture|Video|Deformer|Pose): \d+,/
  const counts = {}
  for (const line of out) {
    const m = line.match(re)
    if (!m) continue
    counts[m[1]] = (counts[m[1]] || 0) + 1
  }
  const typeCounts = {
    Model: counts.Model || 0,
    Geometry: counts.Geometry || 0,
    Material: counts.Material || 0,
    Texture: counts.Texture || 0,
    Video: counts.Video || 0,
    Deformer: (counts.Deformer || 0) + (counts.SubDeformer || 0),
    Pose: counts.Pose || 0
  }
  const objectTypes = ['Model', 'Geometry', 'Material', 'Texture', 'Video', 'Deformer', 'Pose']
    .filter(t => typeCounts[t] > 0)
  const totalCount = objectTypes.reduce((n, t) => n + typeCounts[t], 0)

  const s = []
  const I = indent
  s.push('; FBX 7.4.0 project file')
  s.push('; Created by Herosaver (https://github.com/PopleZoo/Herosaver)')
  s.push('; Copyright (C) 1997-2015 Autodesk Inc. and/or its licensors.')
  s.push('; All rights reserved.')
  s.push('; ----------------------------------------------------')
  s.push('')

  s.push('FBXHeaderExtension: {')
  s.push(I(1) + 'FBXHeaderVersion: 1004')
  s.push(I(1) + 'FBXVersion: ' + FBX_VERSION)
  s.push(I(1) + 'EncryptionType: 0')
  s.push(I(1) + 'CreationTimeStamp: {')
  s.push(I(2) + 'Version: 1000')
  s.push(I(2) + 'Year: 1970')
  s.push(I(2) + 'Month: 1')
  s.push(I(2) + 'Day: 1')
  s.push(I(2) + 'Hour: 10')
  s.push(I(2) + 'Minute: 0')
  s.push(I(2) + 'Second: 0')
  s.push(I(2) + 'Millisecond: 0')
  s.push(I(1) + '}')
  s.push(I(1) + 'Creator: "Herosaver"')
  s.push('}')
  s.push('')

  s.push('GlobalSettings: {')
  s.push(I(1) + 'Version: 1000')
  s.push(I(1) + 'Properties70: {')
  const globals = [
    ['UpAxis', 'int', 'Integer', 1],
    ['UpAxisSign', 'int', 'Integer', 1],
    ['FrontAxis', 'int', 'Integer', 2],
    ['FrontAxisSign', 'int', 'Integer', 1],
    ['CoordAxis', 'int', 'Integer', 0],
    ['CoordAxisSign', 'int', 'Integer', 1],
    ['OriginalUpAxis', 'int', 'Integer', 1],
    ['OriginalUpAxisSign', 'int', 'Integer', 1],
    ['UnitScaleFactor', 'double', 'Number', 1.0],
    ['OriginalUnitScaleFactor', 'double', 'Number', 1.0],
    ['TimeSpanStart', 'KTime', 'Time', 0],
    ['TimeSpanStop', 'KTime', 'Time', 0],
    ['TimeMode', 'enum', '', 0],
    ['CustomFrameRate', 'double', 'Number', 30.0001],
    ['RotationOrder', 'enum', '', 0]
  ]
  for (const [name, type, label, value] of globals) {
    s.push(I(2) + `P: "${name}", "${type}", "${label}", "", ${value}`)
  }
  s.push(I(1) + '}')
  s.push('}')
  s.push('')

  s.push('Documents: 1 {')
  s.push(I(1) + 'Count: 1')
  s.push(I(1) + 'Document: 1234567890, "Scene", "Scene" {')
  s.push(I(2) + 'Properties70: {')
  s.push(I(3) + 'P: "SourceObject", "object", "", ""')
  s.push(I(3) + 'P: "ActiveAnimStackName", "KString", "", "", "AnimStack::Take 001"')
  s.push(I(2) + '}')
  s.push(I(2) + 'RootNode: 0')
  s.push(I(1) + '}')
  s.push('}')
  s.push('')

  s.push('References: {')
  s.push('}')
  s.push('')

  s.push('Definitions: 4 {')
  s.push(I(1) + 'Version: 100')
  s.push(I(1) + 'Count: ' + totalCount)
  for (const t of objectTypes) {
    s.push(I(1) + `ObjectType: "${t}", ${typeCounts[t]} {`)
    s.push(I(2) + 'Count: ' + typeCounts[t])
    s.push(I(1) + '}')
  }
  s.push('}')
  s.push('')

  s.push('Objects: {')
  s.push('')
  for (const line of out) s.push(line)
  s.push('}')
  s.push('')

  s.push('Connections: {')
  for (const [child, parent, type, prop] of connections) {
    if (prop) s.push(I(1) + `C: "${type}",${child},${parent},"${prop}"`)
    else s.push(I(1) + `C: "${type}",${child},${parent}`)
  }
  s.push('}')
  s.push('')

  s.push('Takes: {')
  s.push(I(1) + 'Current: "Take 001"')
  s.push(I(1) + 'Take: "Take 001" {')
  s.push(I(2) + 'FileName: "Take 001.tak"')
  s.push(I(2) + 'LocalTime: 0,0')
  s.push(I(2) + 'ReferenceTime: 0,0')
  s.push(I(1) + '}')
  s.push('}')

  return { fbx: s.join('\r\n') + '\r\n' }
}

// The atlas data URI is `data:image/png;base64,<base64>`; the FBX Video/Content
// field only wants the base64 part.
function dataUriToBase64 (dataUri) {
  return dataUri.slice(dataUri.indexOf(',') + 1)
}
