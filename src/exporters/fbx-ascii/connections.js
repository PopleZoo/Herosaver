export function generateConnections(scene, hierarchyData, materialData, skinData, morphData) {
  const connections = []

  // Model hierarchy connections (parent-child)
  for (const node of scene.nodes) {
    if (node.parentId !== null) {
      connections.push({
        childId: node.id,
        parentId: node.parentId,
        type: 'OO'
      })
    }
  }

  // Geometry to Model connections
  for (const node of scene.nodes) {
    if (node.geometryId) {
      connections.push({
        childId: node.geometryId,
        parentId: node.id,
        type: 'OO'
      })
    }
  }

  // Material to Model connections
  for (const [modelId, mat] of Object.entries(materialData.materialIdByModel || {})) {
    connections.push({
      childId: mat.materialId,
      parentId: parseInt(modelId),
      type: 'OO'
    })

    if (mat.textureId) {
      connections.push({
        childId: mat.textureId,
        parentId: mat.materialId,
        type: 'OP',
        property: 'DiffuseColor'
      })
    }
    if (mat.videoId && mat.textureId) {
      connections.push({
        childId: mat.videoId,
        parentId: mat.textureId,
        type: 'OO'
      })
    }
  }

  // Skin to Geometry connections
  // (handled in skin.js during skin deformer creation)

  // Cluster to Skin connections
  // (handled in geometry.js during cluster creation)

  // Cluster to Bone connections
  // (handled in geometry.js during cluster creation)

  // Pose connections
  // (handled in geometry.js during bind pose creation)

  return connections
}