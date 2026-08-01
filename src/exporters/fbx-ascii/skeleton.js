import { Matrix4, Vector3, Euler, Quaternion } from 'three'
import { createIDAllocator } from './ids.js'
import { createScene, createConnection } from './scene.js'

function decomposeMatrix(mat) {
  const pos = new Vector3()
  const quat = new Quaternion()
  const scale = new Vector3()
  mat.decompose(pos, quat, scale)
  // FBX stores Lcl Rotation as extrinsic XYZ (RotationOrder 0)
  // Three's FBXLoader maps that to intrinsic 'ZYX' order
  const euler = new Euler().setFromQuaternion(quat, 'ZYX')
  return {
    t: [pos.x, pos.y, pos.z],
    r: [euler.x * 180 / Math.PI, euler.y * 180 / Math.PI, euler.z * 180 / Math.PI],
    s: [scale.x, scale.y, scale.z]
  }
}

function invertMatrix(m) {
  const out = m.clone()
  if (typeof out.invert === 'function') out.invert()
  else if (typeof out.getInverse === 'function') out.getInverse(m)
  return out
}

function getBoneDepth(bone, allBones) {
  let d = 0
  let p = bone.parent
  while (p && allBones.includes(p)) {
    d++
    p = p.parent
  }
  return d
}

export function buildSkeleton(scene, idAllocator, roots, skipUuids) {
  const allBones = []
  const boneIdMap = new Map() // three.js bone -> fbxId
  const nodeMap = new Map()   // fbxId -> node object

  // First pass: collect all skinned meshes and their bones
  const skinnedMeshes = []
  const traverse = (obj) => {
    if (!obj || skipUuids.has(obj.uuid)) return
    if (obj.isSkinnedMesh || (obj.skeleton && obj.skeleton.bones && obj.skeleton.bones.length > 0)) {
      skinnedMeshes.push(obj)
      for (const bone of obj.skeleton.bones) {
        if (!allBones.includes(bone)) allBones.push(bone)
      }
    }
    for (const child of obj.children) traverse(child)
  }

  for (const root of roots) {
    root.updateMatrixWorld(true)
    traverse(root)
  }

  // Sort bones by depth (shallowest first)
  allBones.sort((a, b) => getBoneDepth(a, allBones) - getBoneDepth(b, allBones))

  // Create nodes for each bone
  for (const bone of allBones) {
    const id = idAllocator.getId(bone)
    boneIdMap.set(bone, id)

    // Find parent bone ID
    let parentId = null
    if (bone.parent) {
      // Check if parent is also a bone
      if (allBones.includes(bone.parent)) {
        parentId = boneIdMap.get(bone.parent)
      } else {
        // Parent is not a bone - find nearest ancestor that has an ID
        let p = bone.parent
        while (p && !idAllocator.hasId(p.uuid)) {
          p = p.parent
        }
        if (p) parentId = idAllocator.getId(p)
      }
    }

    // If no parent found, try to find owning skinned mesh
    if (parentId === null) {
      const owner = skinnedMeshes.find(s => s.skeleton.bones.includes(bone))
      if (owner) parentId = idAllocator.getId(owner)
    }

    // Decompose local transform
    bone.updateMatrix()
    const world = bone.matrixWorld.clone()
    let local
    if (parentId === null) {
      local = world.clone()
    } else {
      const parentObj = nodeMap.get(parentId)
      if (parentObj) {
        const parentWorld = parentObj.object.matrixWorld
        local = invertMatrix(parentWorld).multiply(world)
      } else {
        local = world.clone()
      }
    }

    const dec = decomposeMatrix(local)

    const node = {
      id,
      name: bone.name || `Bone_${id}`,
      type: 'LimbNode',
      object: bone,
      parentId,
      rotationOrder: 0,
      lclTranslation: dec.t,
      lclRotation: dec.r,
      lclScaling: dec.s
    }

    scene.addNode(node)
    nodeMap.set(id, { object: bone, node })

    if (parentId === null) {
      scene.addConnection(createConnection(id, 0, 'OO'))
    } else {
      scene.addConnection(createConnection(id, parentId, 'OO'))
    }
  }

  return { boneIdMap, allBones, skinnedMeshes, nodeMap }
}

export function collectMeshes(scene, roots, skipUuids, idAllocator) {
  const meshes = []
  const seen = new Set()

  const traverse = (obj) => {
    if (!obj || seen.has(obj.uuid) || skipUuids.has(obj.uuid)) return
    seen.add(obj.uuid)

    if (obj.isMesh || obj.isSkinnedMesh) {
      const id = idAllocator.getId(obj)
      const node = {
        id,
        name: obj.name || obj.type || 'Mesh',
        type: obj.isBone ? 'LimbNode' : 'Mesh',
        object: obj,
        parentId: null, // will be set later
        rotationOrder: 0,
        lclTranslation: [0, 0, 0],
        lclRotation: [0, 0, 0],
        lclScaling: [1, 1, 1]
      }
      meshes.push({ mesh: obj, node })
      scene.addNode(node)
    }

    for (const child of obj.children) traverse(child)
  }

  for (const root of roots) {
    root.updateMatrixWorld(true)
    traverse(root)
  }

  // Now build hierarchy connections
  for (const { mesh, node } of meshes) {
    let parentId = null
    let p = mesh.parent
    while (p) {
      if (idAllocator.hasId(p.uuid)) {
        parentId = idAllocator.getId(p)
        break
      }
      p = p.parent
    }
    if (parentId === null) {
      // Try to find a skeleton bone that owns this mesh
      const skinnedMeshes = meshes.filter(m => m.mesh.isSkinnedMesh)
      const owner = skinnedMeshes.find(s => s.mesh.skeleton && s.mesh.skeleton.bones.includes(mesh))
      if (owner) {
        parentId = idAllocator.getId(owner.mesh)
      }
    }
    node.parentId = parentId

    if (parentId === null) {
      scene.addConnection(createConnection(node.id, 0, 'OO'))
    } else {
      scene.addConnection(createConnection(node.id, parentId, 'OO'))
    }
  }

  return meshes
}

export function buildHierarchy(scene, idAllocator, roots, skipUuids) {
  // First build skeleton
  const { boneIdMap, allBones, skinnedMeshes, nodeMap } = buildSkeleton(scene, idAllocator, roots, skipUuids)

  // Then collect and connect meshes
  const meshes = collectMeshes(scene, roots, skipUuids, idAllocator)

  return { boneIdMap, allBones, skinnedMeshes, nodeMap, meshes }
}