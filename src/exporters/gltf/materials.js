/**
 * Material export for glTF
 * Converts Three.js materials to glTF PBR materials
 */

/**
 * Convert Three.js material to glTF PBR material
 * @param {THREE.Material} material - Three.js material
 * @param {BufferWriter} bufferWriter
 * @param {Array} images - Image array to push to
 * @param {Array} textures - Texture array to push to
 * @param {Array} samplers - Sampler array to push to
 * @returns {Object} glTF material
 */
export function convertMaterial (material, bufferWriter, images, textures, samplers) {
  const gltfMaterial = {
    name: material.name || 'material',
    pbrMetallicRoughness: {
      baseColorFactor: [1, 1, 1, 1],
      baseColorTexture: null,
      metallicRoughnessTexture: null,
      metallicFactor: 1,
      roughnessFactor: 1
    },
    normalTexture: null,
    occlusionTexture: null,
    emissiveTexture: null,
    emissiveFactor: [0, 0, 0],
    alphaMode: 'OPAQUE',
    alphaCutoff: 0.5,
    doubleSided: material.side === 2
  }

  // Base color
  if (material.color) {
    gltfMaterial.pbrMetallicRoughness.baseColorFactor = [
      material.color.r,
      material.color.g,
      material.color.b,
      material.opacity !== undefined ? material.opacity : 1
    ]
  }

  // Base color texture (map)
  if (material.map) {
    const textureInfo = addTexture(material.map, bufferWriter, images, textures, samplers)
    if (textureInfo) {
      gltfMaterial.pbrMetallicRoughness.baseColorTexture = {
        index: textureInfo.textureIndex,
        texCoord: 0
      }
    }
  }

  // Normal map
  if (material.normalMap) {
    const textureInfo = addTexture(material.normalMap, bufferWriter, images, textures, samplers)
    if (textureInfo) {
      gltfMaterial.normalTexture = {
        index: textureInfo.textureIndex,
        texCoord: 0,
        scale: material.normalScale ? material.normalScale.x : 1
      }
    }
  }

  // Roughness/Metalness
  if (material.roughnessMap || material.metalnessMap) {
    // For now, just use the first one found
    const map = material.roughnessMap || material.metalnessMap
    const textureInfo = addTexture(map, bufferWriter, images, textures, samplers)
    if (textureInfo) {
      gltfMaterial.pbrMetallicRoughness.metallicRoughnessTexture = {
        index: textureInfo.textureIndex,
        texCoord: 0
      }
    }
    if (material.roughness !== undefined) {
      gltfMaterial.pbrMetallicRoughness.roughnessFactor = material.roughness
    }
    if (material.metalness !== undefined) {
      gltfMaterial.pbrMetallicRoughness.metallicFactor = material.metalness
    }
  }

  // Emissive
  if (material.emissive && material.emissiveIntensity > 0) {
    gltfMaterial.emissiveFactor = [
      material.emissive.r * material.emissiveIntensity,
      material.emissive.g * material.emissiveIntensity,
      material.emissive.b * material.emissiveIntensity
    ]
    if (material.emissiveMap) {
      const textureInfo = addTexture(material.emissiveMap, bufferWriter, images, textures, samplers)
      if (textureInfo) {
        gltfMaterial.emissiveTexture = {
          index: textureInfo.textureIndex,
          texCoord: 0
        }
      }
    }
  }

  // Alpha mode
  if (material.transparent || material.opacity < 1) {
    gltfMaterial.alphaMode = 'BLEND'
  } else if (material.alphaTest > 0) {
    gltfMaterial.alphaMode = 'MASK'
    gltfMaterial.alphaCutoff = material.alphaTest
  }

  return gltfMaterial
}

/**
 * Add texture to glTF arrays
 */
function addTexture (threeTexture, bufferWriter, images, textures, samplers) {
  if (!threeTexture || !threeTexture.image) return null

  // Create image
  const image = threeTexture.image
  let uri = null
  let mimeType = 'image/png'

  if (image.src && image.src.startsWith('data:')) {
    uri = image.src
  } else if (image.src) {
    uri = image.src
  } else if (image.toDataURL) {
    uri = image.toDataURL('image/png')
    mimeType = 'image/png'
  } else {
    // Try to get data URL from canvas
    try {
      const canvas = document.createElement('canvas')
      canvas.width = image.width
      canvas.height = image.height
      const ctx = canvas.getContext('2d')
      ctx.drawImage(image, 0, 0)
      uri = canvas.toDataURL('image/png')
      mimeType = 'image/png'
    } catch (e) {
      console.warn('Could not extract texture data:', e)
      return null
    }
  }

  if (!uri) return null

  // Check if already added
  const existingIndex = images.findIndex(img => img.uri === uri)
  if (existingIndex >= 0) {
    return { imageIndex: existingIndex, textureIndex: existingIndex }
  }

  images.push({
    uri: uri,
    mimeType: mimeType,
    name: 'texture_' + images.length
  })

  return {
    textureIndex: images.length - 1
  }
}

export function createMaterialTextureInfo (textureIndex, texCoord = 0) {
  return {
    index: textureIndex,
    texCoord: texCoord || 0
  }
}

export function createNormalTextureInfo (textureIndex, scale = 1, texCoord = 0) {
  return {
    index: textureIndex,
    texCoord: texCoord || 0,
    scale: scale || 1
  }
}

export function createOcclusionTextureInfo (textureIndex, strength = 1, texCoord = 0) {
  return {
    index: textureIndex,
    texCoord: texCoord || 0,
    strength: strength || 1
  }
}

export function createEmissiveTextureInfo (textureIndex, texCoord = 0) {
  return {
    index: textureIndex,
    texCoord: texCoord || 0
  }
}

export function createPbrMetallicRoughness (baseColorFactor, baseColorTexture, metallicRoughnessTexture, metallicFactor, roughnessFactor) {
  return {
    baseColorFactor: baseColorFactor || [1, 1, 1, 1],
    baseColorTexture: baseColorTexture || null,
    metallicRoughnessTexture: metallicRoughnessTexture || null,
    metallicFactor: metallicFactor !== undefined ? metallicFactor : 1,
    roughnessFactor: roughnessFactor !== undefined ? roughnessFactor : 1
  }
}
