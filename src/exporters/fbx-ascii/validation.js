export function validateScene(scene) {
  const errors = []
  const warnings = []

  // Check for duplicate IDs
  const idMap = new Map()
  const checkId = (obj, type) => {
    if (idMap.has(obj.id)) {
      errors.push(`Duplicate ID ${obj.id}: ${type} "${obj.name}" conflicts with ${idMap.get(obj.id).type} "${idMap.get(obj.id).name}"`)
    } else {
      idMap.set(obj.id, { type, name: obj.name })
    }
  }

  for (const node of scene.nodes) checkId(node, 'Model')
  for (const geom of scene.geometries) checkId(geom, 'Geometry')
  for (const mat of scene.materials) checkId(mat, 'Material')
  for (const tex of scene.textures) checkId(tex, 'Texture')
  for (const vid of scene.videos) checkId(vid, 'Video')
  for (const def of scene.deformers) checkId(def, 'Deformer')
  for (const pose of scene.poses) checkId(pose, 'Pose')

  // Check geometry references
  const geomIds = new Set(scene.geometries.map(g => g.id))
  for (const node of scene.nodes) {
    if (node.geometryId && !geomIds.has(node.geometryId)) {
      errors.push(`Model "${node.name}" references non-existent Geometry ID ${node.geometryId}`)
    }
  }

  // Check deformers
  for (const def of scene.deformers) {
    if (def.deformerType === 'Cluster') {
      if (!def.indexes || !def.weights) {
        warnings.push(`Cluster "${def.name}" missing indexes or weights`)
      }
      if (def.indexes && def.weights && def.indexes.length !== def.weights.length) {
        errors.push(`Cluster "${def.name}" has mismatched indexes (${def.indexes.length}) and weights (${def.weights.length})`)
      }
    }
  }

  // Check pose nodes reference valid models
  for (const pose of scene.poses) {
    for (const node of pose.nodes) {
      if (!scene.nodes.some(n => n.id === node.id)) {
        warnings.push(`Pose "${pose.name}" references non-existent Model ID ${node.id}`)
      }
    }
  }

  // Check connections reference valid objects
  const allIds = new Set([
    ...scene.nodes.map(n => n.id),
    ...scene.geometries.map(g => g.id),
    ...scene.materials.map(m => m.id),
    ...scene.textures.map(t => t.id),
    ...scene.videos.map(v => v.id),
    ...scene.deformers.map(d => d.id),
    ...scene.poses.map(p => p.id),
    0 // Root node
  ])

  for (const conn of scene.connections) {
    if (!allIds.has(conn.childId)) {
      errors.push(`Connection references non-existent child ID ${conn.childId}`)
    }
    if (!allIds.has(conn.parentId)) {
      errors.push(`Connection references non-existent parent ID ${conn.parentId}`)
    }
  }

  return { errors, warnings, valid: errors.length === 0 }
}

export function logValidation(result) {
  if (result.errors.length > 0) {
    console.error('[FBX Validation] Errors:')
    for (const e of result.errors) console.error('  -', e)
  }
  if (result.warnings.length > 0) {
    console.warn('[FBX Validation] Warnings:')
    for (const w of result.warnings) console.warn('  -', w)
  }
  if (result.valid) {
    console.log('[FBX Validation] All checks passed')
  }
}