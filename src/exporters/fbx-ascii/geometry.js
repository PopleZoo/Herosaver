import { Matrix4, Vector3 } from 'three'
import { createIDAllocator } from './ids.js'
import { createScene, createConnection } from './scene.js'

const fmt = v => String(parseFloat(v.toPrecision(10)))

function sanitizeFBXName(s) {
  return String(s == null ? '' : s).replace(/[^a-zA-Z0-9._-]/g, '_') || 'Model'
}

function invertMatrix(m) {
  const out = m.clone()
  if (typeof out.invert === 'function') out.invert()
  else if (typeof out.getInverse === 'function') out.getInverse(m)
  return out
}

function geometryToFBX(geometry) {
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
    positions: Array.from(positions, fmt),
    normals: normals ? Array.from(normals, fmt) : null,
    uvs: uvs ? Array.from(uvs, fmt) : null,
    polygonIndex: Array.from(polygonIndex),
    indexArr: indexArr ? Array.from(indexArr) : null,
    expanded,
    cornerRemap,
    controlPointCount: positions.length / 3
  }
}

function extractSkin(geometry, skeleton) {
  const pos = geometry.getAttribute('position')
  const count = pos ? pos.count : 0
  const joints = new Uint16Array(count * 4)
  const weights = new Float32Array(count * 4)

  if (!skeleton) return { joints, weights }

  const names = (geometry.skinNames || ['skin0']).slice(0, 3)

  function decodeWeight(v) {
    let m = (v + 1.0) % 2.0
    if (m < 0) m += 2.0
    return Math.abs(m - 1.0)
  }

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

export function buildGeometry(scene, idAllocator, meshData, boneIdMap, textureAtlas, connections) {
  const { mesh, node } = meshData
  const geometry = mesh.geometry
  if (!geometry || typeof geometry.getAttribute !== 'function') return null

  const geo = geometryToFBX(geometry)
  if (!geo) return null

  const geometryId = idAllocator.getIdForKey(`geometry_${mesh.uuid}`)
  node.geometryId = geometryId

  // Get material for this mesh
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  const atlasTex = mat && mat.uniforms && mat.uniforms.colorAtlasMap && mat.uniforms.colorAtlasMap.value
  const entry = atlasTex && textureAtlas.get(atlasTex.uuid)

  // UV remapping
  const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
  const uvps = m && m.uniforms && m.uniforms.uvPosScl && m.uniforms.uvPosScl.value
  let uvsOut = geo.uvs
  if (geo.uvs && uvps) {
    uvsOut = []
    for (let i = 0; i < geo.uvs.length / 2; i++) {
      uvsOut.push(geo.uvs[i * 2] * uvps.z + uvps.x)
      uvsOut.push(geo.uvs[i * 2 + 1] * uvps.w + uvps.y)
    }
  }

  // Determine reference type
  const refType = geo.indexArr ? 'IndexToDirect' : 'Direct'

  // Create geometry object for scene
  const geom = {
    id: geometryId,
    name: `${sanitizeFBXName(mesh.name)}_geo`,
    vertices: geo.positions,
    polygonIndices: geo.polygonIndex,
    uvs: uvsOut || [],
    normals: geo.normals || [],
    materialIndices: geo.indexArr ? Array.from({ length: geo.polygonIndex.length / 3 }, (_, i) => i) : []
  }
  scene.addGeometry(geom)

  // Connect geometry to model
  const meshNodeId = idAllocator.getId(mesh)
  connections.push({ childId: geometryId, parentId: meshNodeId, type: 'OO' })

  // Handle skinning if skinned
  const isSkinned = mesh.isSkinnedMesh || (mesh.skeleton && mesh.skeleton.bones && mesh.skeleton.bones.length > 0)
  if (isSkinned && mesh.skeleton) {
    const skin = extractSkin(geometry, mesh.skeleton)
    const skinId = idAllocator.getIdForKey(`skin_${mesh.uuid}`)
    const bones = mesh.skeleton.bones

    // Remap skin if geometry was expanded
    let joints = skin.joints
    let weights = skin.weights
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

    // Build bone vertices mapping
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

    const meshWorld = mesh.matrixWorld
    const clusters = []

    for (let b = 0; b < bones.length; b++) {
      const boneWorld = bones[b].matrixWorld
      const clusterId = idAllocator.getIdForKey(`cluster_${mesh.uuid}_${b}`)
      const idx = boneVertices[b].map(p => p[0])
      const wts = boneVertices[b].map(p => p[1])

      clusters.push({
        id: clusterId,
        bone: bones[b],
        boneId: idAllocator.getId(bones[b]),
        transform: invertMatrix(boneWorld).multiply(meshWorld),
        transformLink: boneWorld,
        indexes: idx,
        weights: wts
      })
    }

    // Skin deformer
    const skinObj = {
      id: skinId,
      name: `${sanitizeFBXName(mesh.name)}_Skin`,
      deformerType: 'Skin'
    }
    scene.deformers.push(skinObj)
    connections.push({ childId: skinId, parentId: geometryId, type: 'OO' })

    // Clusters
    for (const cluster of clusters) {
      const clusterObj = {
        id: cluster.id,
        name: `${sanitizeFBXName(mesh.name)}_cluster_${sanitizeFBXName(cluster.bone.name)}`,
        deformerType: 'Cluster',
        indexes: cluster.indexes,
        weights: cluster.weights,
        transform: Array.from(cluster.transform.elements, fmt),
        transformLink: Array.from(cluster.transformLink.elements, fmt)
      }
      scene.deformers.push(clusterObj)
      connections.push({ childId: cluster.id, parentId: skinId, type: 'OO' })
      connections.push({ childId: cluster.boneId, parentId: cluster.id, type: 'OO' })
    }

    // BindPose
    const poseId = idAllocator.getIdForKey(`pose_${mesh.uuid}`)
    const poseIds = [idAllocator.getId(mesh)]
    for (const cluster of clusters) {
      if (!poseIds.includes(cluster.boneId)) poseIds.push(cluster.boneId)
    }

    const poseNodes = []
    for (const nodeId of poseIds) {
      const obj = nodeId === idAllocator.getId(mesh) ? mesh : undefined
      if (obj) {
        poseNodes.push({
          id: nodeId,
          matrix: Array.from(obj.matrixWorld.elements, fmt)
        })
      }
    }

    scene.addPose({
      id: poseId,
      name: 'Pose',
      type: 'BindPose',
      nodes: poseNodes
    })
  }

  return { geometryId, geo }
}