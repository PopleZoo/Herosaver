import { createIDAllocator } from './ids.js'
import { createConnection } from './scene.js'

export function buildMorphTargets(scene, idAllocator, meshDataList) {
  const morphData = []

  for (const { mesh, node } of meshDataList) {
    if (!mesh.morphTargetInfluences || mesh.morphTargetInfluences.length === 0) continue
    if (!mesh.morphTargetDictionary) continue

    const blendShapeId = idAllocator.getIdForKey(`blendshape_${mesh.uuid}`)
    const blendShapeName = `${mesh.name}_BlendShape`

    // Create BlendShape deformer
    const blendShape = {
      id: blendShapeId,
      name: blendShapeName,
      deformerType: 'BlendShape',
      channels: []
    }

    // Create BlendShapeChannels
    let channelIndex = 0
    for (const [name, index] of Object.entries(mesh.morphTargetDictionary)) {
      const channelId = idAllocator.getIdForKey(`blendshape_channel_${mesh.uuid}_${index}`)
      const channelName = name

      const channel = {
        id: channelId,
        name: channelName,
        deformerType: 'BlendShapeChannel',
        deformPercent: mesh.morphTargetInfluences[index] * 100,
        fullWeights: { [index]: 1.0 },
        // Shape geometry would be exported here
      }

      blendShape.channels.push(channel)
      scene.addConnection({ childId: channelId, parentId: blendShapeId, type: 'OO' })
    }

    // Connect blendshape to geometry
    const geoNodeId = node.geometryId
    if (geoNodeId) {
      scene.addConnection({ childId: blendShapeId, parentId: geoNodeId, type: 'OO' })
    }

    morphData.push(blendShape)
    scene.addDeformer(blendShape)
  }

  return morphData
}