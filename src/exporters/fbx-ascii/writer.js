export class FBXWriter {
  constructor() {
    this.lines = []
    this.indentLevel = 0
  }

  push(line) {
    this.lines.push('\t'.repeat(this.indentLevel) + line)
  }

  indent() {
    this.indentLevel++
  }

  dedent() {
    this.indentLevel--
  }

  writeHeader() {
    this.push('; FBX 7.4.0 project file')
    this.push('; Created by HeroSaver (https://github.com/PopleZoo/Herosaver)')
    this.push('; Copyright (C) 1997-2015 Autodesk Inc. and/or its licensors.')
    this.push('; All rights reserved.')
    this.push('; ----------------------------------------------------')
    this.push('')
  }

  writeFBXHeaderExtension(scene) {
    this.push('FBXHeaderExtension: {')
    this.indent()
    this.push('FBXHeaderVersion: 1004')
    this.push(`FBXVersion: 7400`)
    this.push('EncryptionType: 0')
    this.push('CreationTimeStamp: {')
    this.indent()
    this.push('Version: 1000')
    this.push('Year: 1970')
    this.push('Month: 1')
    this.push('Day: 1')
    this.push('Hour: 10')
    this.push('Minute: 0')
    this.push('Second: 0')
    this.push('Millisecond: 0')
    this.dedent()
    this.push('}')
    this.push('Creator: "HeroSaver"')
    this.dedent()
    this.push('}')
    this.push('')
  }

  writeGlobalSettings(scene) {
    this.push('GlobalSettings: {')
    this.indent()
    this.push('Version: 1000')
    this.push('Properties70: {')
    this.indent()

    const globals = scene.globalSettings.properties
    for (const [name, value] of Object.entries(globals)) {
      let type, label
      if (name === 'UpAxis' || name === 'UpAxisSign' || name === 'FrontAxis' || name === 'FrontAxisSign' ||
          name === 'CoordAxis' || name === 'CoordAxisSign' || name === 'OriginalUpAxis' || name === 'OriginalUpAxisSign' ||
          name === 'TimeMode' || name === 'RotationOrder') {
        type = 'int'
        label = 'Integer'
      } else if (name === 'TimeSpanStart' || name === 'TimeSpanStop') {
        type = 'KTime'
        label = 'Time'
      } else if (name === 'CustomFrameRate') {
        type = 'double'
        label = 'Number'
      } else {
        type = 'double'
        label = 'Number'
      }
      this.push(`P: "${name}", "${type}", "${label}", "", ${value}`)
    }

    this.dedent()
    this.push('}')
    this.dedent()
    this.push('}')
    this.push('')
  }

  writeDocuments(scene) {
    this.push('Documents: 1 {')
    this.indent()
    this.push('Count: 1')
    const doc = scene.documents
    this.push(`Document: ${doc.id}, "${doc.name}", "${doc.type}" {`)
    this.indent()
    this.push('Properties70: {')
    this.indent()
    this.push(`P: "SourceObject", "object", "", "${doc.sourceObject}"`)
    this.push(`P: "ActiveAnimStackName", "KString", "", "", "${doc.activeAnimStackName}"`)
    this.dedent()
    this.push('}')
    this.push(`RootNode: ${doc.rootNode}`)
    this.dedent()
    this.push('}')
    this.dedent()
    this.push('}')
    this.push('')
  }

  writeReferences(scene) {
    this.push('References: {')
    this.push('}')
    this.push('')
  }

  writeDefinitions(scene) {
    this.push('Definitions: 4 {')
    this.indent()
    this.push('Version: 100')

    const objectTypes = []
    if (scene.nodes.length > 0) objectTypes.push('Model')
    if (scene.geometries.length > 0) objectTypes.push('Geometry')
    if (scene.materials.length > 0) objectTypes.push('Material')
    if (scene.textures.length > 0) objectTypes.push('Texture')
    if (scene.videos.length > 0) objectTypes.push('Video')
    if (scene.deformers.length > 0) objectTypes.push('Deformer')
    if (scene.poses.length > 0) objectTypes.push('Pose')

    const totalCount = scene.nodes.length +
      scene.geometries.length +
      scene.materials.length +
      scene.textures.length +
      scene.videos.length +
      scene.deformers.length +
      scene.poses.length

    this.push(`Count: ${totalCount}`)

    for (const type of objectTypes) {
      let count = 0
      switch (type) {
        case 'Model': count = scene.nodes.length; break
        case 'Geometry': count = scene.geometries.length; break
        case 'Material': count = scene.materials.length; break
        case 'Texture': count = scene.textures.length; break
        case 'Video': count = scene.videos.length; break
        case 'Deformer': count = scene.deformers.length; break
        case 'Pose': count = scene.poses.length; break
      }
      this.push(`ObjectType: "${type}", ${count} {`)
      this.indent()
      this.push(`Count: ${count}`)
      this.dedent()
      this.push('}')
    }

    this.dedent()
    this.push('}')
    this.push('')
  }

  writeObjects(scene) {
    this.push('Objects: {')
    this.push('')

    // Write Models
    for (const node of scene.nodes) {
      this.writeModel(node)
    }

    // Write Geometries
    for (const geom of scene.geometries) {
      this.writeGeometry(geom)
    }

    // Write Materials
    for (const mat of scene.materials) {
      this.writeMaterial(mat)
    }

    // Write Textures
    for (const tex of scene.textures) {
      this.writeTexture(tex)
    }

    // Write Videos
    for (const vid of scene.videos) {
      this.writeVideo(vid)
    }

    // Write Deformers
    for (const def of scene.deformers) {
      this.writeDeformer(def)
    }

    // Write Poses
    for (const pose of scene.poses) {
      this.writePose(pose)
    }

    this.push('}')
    this.push('')
  }

  writeModel(node) {
    this.push(`Model: ${node.id}, "${node.name}", "${node.type}" {`)
    this.indent()
    this.push('Version: 232')
    this.push('Culling: "CullingOff"')
    this.push('Properties70: {')
    this.indent()

    // RotationOrder
    this.push(`P: "RotationOrder", "enum", "", "", ${node.rotationOrder || 0}`)

    // Lcl Translation
    if (node.lclTranslation) {
      this.push(`P: "Lcl Translation", "Lcl_Translation", "", "A", ${node.lclTranslation.join(',')}`)
    }
    // Lcl Rotation
    if (node.lclRotation) {
      this.push(`P: "Lcl Rotation", "Lcl_Rotation", "", "A", ${node.lclRotation.join(',')}`)
    }
    // Lcl Scaling
    if (node.lclScaling) {
      this.push(`P: "Lcl Scaling", "Lcl_Scaling", "", "A", ${node.lclScaling.join(',')}`)
    }

    // GeometricTransform
    if (node.geometricTranslation) {
      this.push(`P: "GeometricTranslation", "Lcl_Translation", "", "A", ${node.geometricTranslation.join(',')}`)
    }
    if (node.geometricRotation) {
      this.push(`P: "GeometricRotation", "Lcl_Rotation", "", "A", ${node.geometricRotation.join(',')}`)
    }
    if (node.geometricScaling) {
      this.push(`P: "GeometricScaling", "Lcl_Scaling", "", "A", ${node.geometricScaling.join(',')}`)
    }

    this.dedent()
    this.push('}')
    this.dedent()
    this.push('}')
    this.push('')
  }

  writeGeometry(geom) {
    this.push(`Geometry: ${geom.id}, "${geom.name}", "Mesh" {`)
    this.indent()
    this.push('GeometryVersion: 124')

    // Vertices
    this.push(`Vertices: *${geom.vertices.length} {`)
    this.indent()
    this.push(`a: ${geom.vertices.join(',')}`)
    this.dedent()
    this.push('}')

    // PolygonVertexIndex
    this.push(`PolygonVertexIndex: *${geom.polygonIndices.length} {`)
    this.indent()
    this.push(`a: ${geom.polygonIndices.join(',')}`)
    this.dedent()
    this.push('}')

    // LayerElementUV
    if (geom.uvs && geom.uvs.length > 0) {
      this.push('LayerElementUV: 0 {')
      this.indent()
      this.push('Version: 101')
      this.push('Name: "UVMap"')
      this.push('MappingInformationType: "ByPolygonVertex"')
      this.push('ReferenceInformationType: "Direct"')
      this.push(`UV: *${geom.uvs.length} {`)
      this.indent()
      this.push(`a: ${geom.uvs.join(',')}`)
      this.dedent()
      this.push('}')
      this.dedent()
      this.push('}')
    }

    // LayerElementNormal
    if (geom.normals && geom.normals.length > 0) {
      this.push('LayerElementNormal: 0 {')
      this.indent()
      this.push('Version: 102')
      this.push('Name: ""')
      this.push('MappingInformationType: "ByPolygonVertex"')
      this.push('ReferenceInformationType: "Direct"')
      this.push(`Normals: *${geom.normals.length} {`)
      this.indent()
      this.push(`a: ${geom.normals.join(',')}`)
      this.dedent()
      this.push('}')
      this.dedent()
      this.push('}')
    }

    // LayerElementMaterial
    if (geom.materialIndices && geom.materialIndices.length > 0) {
      this.push('LayerElementMaterial: 0 {')
      this.indent()
      this.push('Version: 101')
      this.push('Name: ""')
      this.push('MappingInformationType: "ByPolygon"')
      this.push('ReferenceInformationType: "IndexToDirect"')
      this.push(`Materials: *${geom.materialIndices.length} {`)
      this.indent()
      this.push(`a: ${geom.materialIndices.join(',')}`)
      this.dedent()
      this.push('}')
      this.dedent()
      this.push('}')
    }

    // Layer
    this.push('Layer: 0 {')
    this.indent()
    this.push('Version: 100')

    if (geom.uvs && geom.uvs.length > 0) {
      this.push('LayerElement: {')
      this.indent()
      this.push('Type: "LayerElementUV"')
      this.push('TypedIndex: 0')
      this.dedent()
      this.push('}')
    }

    if (geom.normals && geom.normals.length > 0) {
      this.push('LayerElement: {')
      this.indent()
      this.push('Type: "LayerElementNormal"')
      this.push('TypedIndex: 0')
      this.dedent()
      this.push('}')
    }

    if (geom.materialIndices && geom.materialIndices.length > 0) {
      this.push('LayerElement: {')
      this.indent()
      this.push('Type: "LayerElementMaterial"')
      this.push('TypedIndex: 0')
      this.dedent()
      this.push('}')
    }

    this.dedent()
    this.push('}')

    this.dedent()
    this.push('}')
    this.push('')
  }

  writeMaterial(mat) {
    this.push(`Material: ${mat.id}, "${mat.name}", "Phong" {`)
    this.indent()
    this.push('Version: 102')
    this.push('ShadingModel: "phong"')
    this.push('MultiLayer: 0')
    this.push('Properties70: {')
    this.indent()
    this.push(`P: "DiffuseColor", "Color", "", "A", 1,1,1`)
    this.dedent()
    this.push('}')
    this.dedent()
    this.push('}')
    this.push('')
  }

  writeTexture(tex) {
    this.push(`Texture: ${tex.id}, "${tex.name}", "" {`)
    this.indent()
    this.push('Type: "TextureVideoClip"')
    this.push('Version: 202')
    this.push(`TextureName: "Texture::${tex.name}"`)
    this.push(`Media: "Video::${tex.name}_Video"`)
    this.push(`FileName: "${tex.fileName}"`)
    this.push(`RelativeFilename: "${tex.fileName}"`)
    this.push('Properties70: {')
    this.indent()
    this.push('P: "Type", "KString", "", "", "TextureVideoClip"')
    this.push('P: "UVSet", "KString", "", "", "UVMap"')
    this.push('P: "WrapModeU", "enum", "", "", 1')
    this.push('P: "WrapModeV", "enum", "", "", 1')
    this.push('P: "UseMaterial", "bool", "", "", 1')
    this.dedent()
    this.push('}')
    this.push('TextureAlpha: 1')
    this.dedent()
    this.push('}')
    this.push('')
  }

  writeVideo(vid) {
    this.push(`Video: ${vid.id}, "${vid.name}_Video", "Clip" {`)
    this.indent()
    this.push('Type: "Clip"')
    this.push('Version: 202')
    this.push(`FileName: "${vid.fileName}"`)
    this.push(`RelativeFilename: "${vid.fileName}"`)
    if (vid.content) {
      this.push(`Content: "${vid.content}"`)
    }
    this.dedent()
    this.push('}')
    this.push('')
  }

  writeDeformer(def) {
    if (def.deformerType === 'Skin') {
      this.push(`Deformer: ${def.id}, "${def.name}", "Skin" {`)
      this.indent()
      this.push('Version: 101')
      this.push('Link_DeformAcuracy: 50')
      this.push('SkinningType: "Linear"')
      this.dedent()
      this.push('}')
      this.push('')
    } else if (def.deformerType === 'Cluster') {
      this.push(`Deformer: ${def.id}, "${def.name}", "Cluster" {`)
      this.indent()
      this.push('Version: 100')
      this.push('UserData: "", ""')

      if (def.indexes && def.indexes.length > 0) {
        this.push(`Indexes: *${def.indexes.length} {`)
        this.indent()
        this.push(`a: ${def.indexes.join(',')}`)
        this.dedent()
        this.push('}')
        this.push(`Weights: *${def.weights.length} {`)
        this.indent()
        this.push(`a: ${def.weights.join(',')}`)
        this.dedent()
        this.push('}')
      }

      this.push('Mode: "Normal"')

      if (def.transform) {
        this.push(`Transform: *16 {`)
        this.indent()
        this.push(`a: ${def.transform.join(',')}`)
        this.dedent()
        this.push('}')
      }

      if (def.transformLink) {
        this.push(`TransformLink: *16 {`)
        this.indent()
        this.push(`a: ${def.transformLink.join(',')}`)
        this.dedent()
        this.push('}')
      }

      this.dedent()
      this.push('}')
      this.push('')
    }
  }

  writePose(pose) {
    this.push(`Pose: ${pose.id}, "Pose", "BindPose" {`)
    this.indent()
    this.push('Version: 100')
    this.push(`NbPoseNodes: ${pose.nodes.length}`)

    for (const node of pose.nodes) {
      this.push('PoseNode: {')
      this.indent()
      this.push(`Node: ${node.id}`)
      if (node.matrix) {
        this.push('Matrix: *16 {')
        this.indent()
        this.push(`a: ${node.matrix.join(',')}`)
        this.dedent()
        this.push('}')
      }
      this.dedent()
      this.push('}')
    }

    this.dedent()
    this.push('}')
    this.push('')
  }

  writeConnections(scene) {
    this.push('Connections: {')
    for (const conn of scene.connections) {
      if (conn.property) {
        this.push(`C: "${conn.type}",${conn.childId},${conn.parentId},"${conn.property}"`)
      } else {
        this.push(`C: "${conn.type}",${conn.childId},${conn.parentId}`)
      }
    }
    this.push('}')
    this.push('')
  }

  writeTakes() {
    this.push('Takes: {')
    this.indent()
    this.push('Current: "Take 001"')
    this.push('Take: "Take 001" {')
    this.indent()
    this.push('FileName: "Take 001.tak"')
    this.push('LocalTime: 0,0')
    this.push('ReferenceTime: 0,0')
    this.dedent()
    this.push('}')
    this.dedent()
    this.push('}')
    this.push('')
  }

  toString() {
    return this.lines.join('\r\n') + '\r\n'
  }
}

export function createWriter() {
  return new FBXWriter()
}