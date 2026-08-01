export function buildMaterials(scene, idAllocator, meshDataList, textureAtlas) {
  const materialByKey = new Map()
  const materialIdByModel = new Map()
  const addedMaterials = new Set()

  const getMaterialForMesh = (mesh) => {
    const m = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
    const atlasTex = m && m.uniforms && m.uniforms.colorAtlasMap && m.uniforms.colorAtlasMap.value
    const entry = atlasTex && textureAtlas.get(atlasTex.uuid)
    const key = entry ? atlasTex.uuid : 'none'

    let mat = materialByKey.get(key)
    if (!mat) {
      mat = {
        materialId: idAllocator.getIdForKey(`material_${key}`),
        textureId: entry ? idAllocator.getIdForKey(`texture_${entry.file}`) : null,
        videoId: entry ? idAllocator.getIdForKey(`video_${entry.file}`) : null,
        entry,
        name: entry ? sanitizeFBXName(entry.file.replace(/\.png$/i, '')) : 'Material'
      }
      materialByKey.set(key, mat)
    }
    return mat
  }

  // Build materials for all meshes
  for (const { mesh, node } of meshDataList) {
    const mat = getMaterialForMesh(mesh)
    materialIdByModel.set(node.id, mat)

    // Create material object only once per unique material
    if (!addedMaterials.has(mat.materialId)) {
      const materialObj = {
        id: mat.materialId,
        name: mat.name,
        type: 'Phong',
        diffuseColor: [1, 1, 1]
      }
      scene.addMaterial(materialObj)
      addedMaterials.add(mat.materialId)
    }

    // Connect material to model
    scene.addConnection({ childId: mat.materialId, parentId: node.id, type: 'OO' })

    if (mat.textureId && mat.entry && !addedMaterials.has(mat.textureId)) {
      // Create texture object
      const file = mat.entry.file
      const name = mat.name

      const texObj = {
        id: mat.textureId,
        name,
        type: 'TextureVideoClip',
        textureName: `Texture::${name}`,
        media: `Video::${name}_Video`,
        fileName: file,
        relativeFilename: file,
        wrapModeU: 1,
        wrapModeV: 1,
        useMaterial: true
      }
      scene.addTexture(texObj)

      // Create video object
      const videoObj = {
        id: mat.videoId,
        name: `${name}_Video`,
        type: 'Clip',
        fileName: file,
        relativeFilename: file,
        content: mat.entry.dataUri ? mat.entry.dataUri.slice(mat.entry.dataUri.indexOf(',') + 1) : ''
      }
      scene.addVideo(videoObj)

      // Connections
      scene.addConnection({ childId: mat.textureId, parentId: mat.materialId, type: 'OP', property: 'DiffuseColor' })
      scene.addConnection({ childId: mat.videoId, parentId: mat.textureId, type: 'OO' })
      addedMaterials.add(mat.textureId)
      addedMaterials.add(mat.videoId)
    }
  }

  return { materialByKey, materialIdByModel }
}

function sanitizeFBXName(s) {
  return String(s == null ? '' : s).replace(/[^a-zA-Z0-9._-]/g, '_') || 'Model'
}