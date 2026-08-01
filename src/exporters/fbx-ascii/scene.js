export class FBXScene {
  constructor() {
    this.nodes = []
    this.geometries = []
    this.materials = []
    this.textures = []
    this.videos = []
    this.deformers = []
    this.poses = []
    this.connections = []
    this.globalSettings = new GlobalSettings()
    this.documents = []
  }

  addNode(node) { this.nodes.push(node) }
  addGeometry(geom) { this.geometries.push(geom) }
  addMaterial(mat) { this.materials.push(mat) }
  addTexture(tex) { this.textures.push(tex) }
  addVideo(vid) { this.videos.push(vid) }
  addDeformer(def) { this.deformers.push(def) }
  addPose(pose) { this.poses.push(pose) }
  addConnection(conn) { this.connections.push(conn) }
}

export class GlobalSettings {
  constructor() {
    this.version = 1000
    this.properties = {
      UpAxis: 1,
      UpAxisSign: 1,
      FrontAxis: 2,
      FrontAxisSign: 1,
      CoordAxis: 0,
      CoordAxisSign: 1,
      OriginalUpAxis: 1,
      OriginalUpAxisSign: 1,
      UnitScaleFactor: 1.0,
      OriginalUnitScaleFactor: 1.0,
      TimeSpanStart: 0,
      TimeSpanStop: 0,
      TimeMode: 0,
      CustomFrameRate: 30.0001,
      RotationOrder: 0
    }
  }
}

export class FBXDocument {
  constructor() {
    this.id = 1234567890
    this.name = 'Scene'
    this.type = 'Scene'
    this.version = 1000
    this.sourceObject = ''
    this.activeAnimStackName = 'AnimStack::Take 001'
    this.rootNode = 0
  }
}

export class FBXConnection {
  constructor(childId, parentId, type, property = null) {
    this.childId = childId
    this.parentId = parentId
    this.type = type
    this.property = property
  }
}

export class FBXObject {
  constructor(id, name, className) {
    this.id = id
    this.name = name
    this.className = className
  }
}

export function createScene() {
  return new FBXScene()
}

export function createGlobalSettings() {
  return new GlobalSettings()
}

export function createDocument() {
  return new FBXDocument()
}

export function createConnection(childId, parentId, type, property = null) {
  return new FBXConnection(childId, parentId, type, property)
}