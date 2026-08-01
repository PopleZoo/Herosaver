/**
 * Skeleton extraction for glTF export
 * Extracts bone hierarchy, transforms, and inverse bind matrices
 */

/**
 * Extract skeleton data from a Three.js SkinnedMesh group
 * @param {THREE.Group} group - The processed group from process()
 * @returns {Object} Skeleton data with bones, inverse bind matrices, etc.
 */
export function extractSkeleton (group) {
  const skeletons = new Map()

  group.traverse(obj => {
    if (!obj.isSkinnedMesh || !obj.skeleton) return
    const skeleton = obj.skeleton
    if (skeletons.has(skeleton.uuid)) return

    const bones = []
    const boneIndexMap = new Map()

    skeleton.bones.forEach((bone, index) => {
      boneIndexMap.set(bone.uuid, index)
      bones.push({
        name: bone.name,
        parent: bone.parent ? bone.parent.name : null,
        index: index,
        matrixWorld: bone.matrixWorld.clone(),
        position: bone.position.clone(),
        rotation: bone.rotation.clone(),
        scale: bone.scale.clone()
      })
    })

    const parentIndices = bones.map(bone => {
      if (!bone.parent) return -1
      for (let i = 0; i < bones.length; i++) {
        if (bones[i].name === bone.parent) return i
      }
      return -1
    })

    const inverseBindMatrices = []
    if (skeleton.boneInverses) {
      skeleton.boneInverses.forEach(inv => {
        inverseBindMatrices.push(Array.from(inv.elements))
      })
    }

    skeletons.set(skeleton.uuid, {
      bones: bones,
      parentIndices: parentIndices,
      inverseBindMatrices: inverseBindMatrices,
      uuid: skeleton.uuid
    })
  })

  return Array.from(skeletons.values())[0] || null
}

/**
 * Extract bone names in order (matching skinIndex order)
 */
export function getBoneNames (skeleton) {
  return skeleton.bones.map(b => b.name)
}

/**
 * Get bone world matrices
 */
export function getBoneWorldMatrices (skeleton) {
  return skeleton.bones.map(b => b.matrixWorld.clone())
}

/**
 * Get inverse bind matrices as flat array for glTF
 */
export function getInverseBindMatricesFlat (skeleton) {
  const flat = []
  skeleton.inverseBindMatrices.forEach(m => {
    flat.push(...m)
  })
  return flat
}
