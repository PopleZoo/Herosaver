import { Matrix4 } from 'three'

export function buildSkinning(scene, idAllocator, mesh, geometryId, boneIdMap, connections) {
  if (!mesh.isSkinnedMesh && (!mesh.skeleton || !mesh.skeleton.bones || mesh.skeleton.bones.length === 0)) {
    return null
  }

  const geometry = mesh.geometry
  if (!geometry || typeof geometry.getAttribute !== 'function') return null

  // Extract skin data from geometry attributes
  const pos = geometry.getAttribute('position')
  const count = pos ? pos.count : 0
  const joints = new Uint16Array(count * 4)
  const weights = new Float32Array(count * 4)

  if (!mesh.skeleton) return null

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
        if (weight > 0 && boneIndex < mesh.skeleton.bones.length) {
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

  // Per-bone affected control points
  const bones = mesh.skeleton.bones
  const boneVertices = bones.map(() => [])

  // We need the control point count from the geometry
  const geo = geometryToFBXInternal(geometry)
  if (!geo) return null

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
    const clusterId = `cluster_${mesh.uuid}_${b}`
    const idx = boneVertices[b].map(p => p[0])
    const wts = boneVertices[b].map(p => p[1])

    const transform = new Matrix4().copy(boneWorld).invert().multiply(meshWorld)
    const transformLink = boneWorld.clone()

    clusters.push({
      id: clusterId,
      bone: bones[b],
      boneId: `bone_${bones[b].uuid}`,
      transform: Array.from(transform.elements),
      transformLink: Array.from(transformLink.elements),
      indexes: idx,
      weights: wts
    })
  }

  // Create skin deformer
  const skinId = `skin_${mesh.uuid}`
  const skinObj = {
    id: skinId,
    name: `${mesh.name}_Skin`,
    deformerType: 'Skin'
  }

  return { skinId, clusters, geometryId }
}

function geometryToFBXInternal(geometry) {
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
      const vi = geometry.index ? geometry.index.array[i] : i
      cornerRemap[i] = vi
      newPos.set(pos.array.subarray(vi * 3, vi * 3 + 3), i * 3)
      if (normal && newNormals) newNormals.set(normal.array.subarray(vi * 3, vi * 3 + 3), i * 3)
      if (uv && newUvs) newUvs.set(uv.array.subarray(vi * 2, vi * 2 + 2), i * 2)
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