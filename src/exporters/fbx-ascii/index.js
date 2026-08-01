import { Matrix4, Vector3, Euler, Quaternion } from 'three'
import { createIDAllocator } from './ids.js'
import { createScene, createConnection, createGlobalSettings, createDocument } from './scene.js'
import { buildHierarchy } from './skeleton.js'
import { buildGeometry } from './geometry.js'
import { buildMaterials } from './materials.js'
import { buildMorphTargets } from './morphs.js'
import { generateConnections } from './connections.js'
import { validateScene, logValidation } from './validation.js'
import { FBXWriter } from './writer.js'

function sanitizeFBXName(s) {
  return String(s == null ? '' : s).replace(/[^a-zA-Z0-9._-]/g, '_') || 'Model'
}

function fmt(v) {
  return String(parseFloat(v.toPrecision(10)))
}

function invertMatrix(m) {
  const out = m.clone()
  if (typeof out.invert === 'function') out.invert()
  else if (typeof out.getInverse === 'function') out.getInverse(m)
  return out
}

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

export async function exportFbxASCII(options = {}) {
  const roots = options.roots || []
  const skipUuids = options.skipUuids || new Set()
  const textureAtlas = options.textureAtlas || new Map()

  if (roots.length === 0) return { fbx: null }

  // Update world matrices
  for (const root of roots) {
    root.updateMatrixWorld(true)
  }

  // Create scene and ID allocator
  const idAllocator = createIDAllocator(1000)
  const scene = createScene()

  // Global settings
  scene.globalSettings = createGlobalSettings()

  // Document
  scene.documents = createDocument()

  // Build hierarchy (skeleton + meshes)
  const hierarchyData = buildHierarchy(scene, idAllocator, roots, skipUuids)

  // Build geometry for each mesh
  for (const meshData of hierarchyData.meshes) {
    await buildGeometry(scene, idAllocator, meshData, hierarchyData.boneIdMap, textureAtlas, scene.connections)
  }

  // Build materials
  const materialData = buildMaterials(scene, idAllocator, hierarchyData.meshes, textureAtlas)

  // Build morph targets
  buildMorphTargets(scene, idAllocator, hierarchyData.meshes)

  // Generate additional connections
  const additionalConnections = generateConnections(scene, hierarchyData, materialData, null, null)
  for (const conn of additionalConnections) {
    scene.addConnection(createConnection(conn.childId, conn.parentId, conn.type, conn.property))
  }

  // Validate
  const { validateScene, logValidation } = await import('./validation.js')
  const validation = validateScene(scene)
  logValidation(validation)
  if (!validation.valid) {
    console.warn('[FBX Export] Validation found errors, but continuing export')
  }

  // Write FBX
  const { FBXWriter } = await import('./writer.js')
  const writer = new FBXWriter()
  writer.writeHeader()
  writer.writeFBXHeaderExtension(scene)
  writer.writeGlobalSettings(scene)
  writer.writeDocuments(scene)
  writer.writeReferences(scene)
  writer.writeDefinitions(scene)
  writer.writeObjects(scene)
  writer.writeConnections(scene)
  writer.writeTakes()

  return { fbx: writer.toString() }
}

export default exportFbxASCII