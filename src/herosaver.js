/* global Blob */

import { Matrix4, Vector3 } from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { saveAs } from 'file-saver'
import { character, getName, process, bakeSkinnedVertex } from './utils'
import { removeCubeFromSTL, parseSTL, findConnectedComponents, analyzeShell } from './cube-remover'

// Sanitize strings for use in filenames and material names (replace spaces, special chars)
const sanitize = s => s.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '')

// Bump with each release so stale CDN/browser copies are easy to spot from the
// console: window.herosaverVersion.
window.herosaverVersion = '1.5.2'

// ─── scene discovery ────────────────────────────────────────────────────────
// HeroForge keeps the whole composition (figure + mounts + companions) inside
// window.CK.scene, but the exporter used to reach the color bake via a
// hard-coded child index, missing every model after the first. These helpers
// walk the scene to find every bake and every scene-level root that makes up
// the composition, so a rider + mount exports as a single piece.

const findColorBakes = () => {
  const bakes = []
  const seen = new Set()
  const scene = window.CK && window.CK.scene

  const tryAdd = obj => {
    if (!obj || !obj.colorBake || seen.has(obj.uuid)) return
    seen.add(obj.uuid)
    bakes.push(obj.colorBake)
  }

  if (scene) scene.traverse(obj => tryAdd(obj))

  // Legacy fallback in case the bake lives outside the scene graph.
  if (bakes.length === 0) {
    try {
      tryAdd(window.CK.scene.children[0].children[3]._partLightGroup.parent)
    } catch (e) { /* structure unavailable */ }
  }

  return bakes
}

const findCompositionRoots = () => {
  const roots = new Map()
  const scene = window.CK && window.CK.scene
  if (!scene) return []

  scene.traverse(obj => {
    if (!(obj.colorBake || obj._partLightGroup)) return
    let node = obj
    while (node && node !== scene && node.parent && node.parent !== scene) {
      node = node.parent
    }
    if (node && node !== scene) roots.set(node.uuid, node)
  })

  return [...roots.values()]
}

// The scene-level groups that contain every exported mesh: the main character
// plus any mount/familiar/companion (deduplicated by object uuid). Meshes are
// additionally deduplicated at export time.
const getExportRoots = () => {
  const roots = new Map()
  const add = obj => { if (obj && !roots.has(obj.uuid)) roots.set(obj.uuid, obj) }
  add(character)
  findCompositionRoots().forEach(add)
  return [...roots.values()]
}

// World-space axis-aligned bounding box of a mesh, using the same baked
// vertices the export uses (skinning + world transform). Returns null when the
// mesh has no readable geometry.
const worldAABB = obj => {
  const geo = obj.geometry
  if (!geo || typeof geo.getAttribute !== 'function') return null
  const pos = geo.getAttribute('position')
  if (!pos) return null
  const isSkinned = obj.isSkinnedMesh || (obj.skeleton && obj.skeleton.bones && obj.skeleton.bones.length > 0)
  let minX = Infinity; let minY = Infinity; let minZ = Infinity
  let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity
  for (let i = 0; i < pos.count; i++) {
    const v = isSkinned
      ? bakeSkinnedVertex(obj, i).applyMatrix4(obj.matrixWorld)
      : new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(obj.matrixWorld)
    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x
    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y
    if (v.z < minZ) minZ = v.z; if (v.z > maxZ) maxZ = v.z
  }
  return { minX, minY, minZ, maxX, maxY, maxZ }
}

// Names HeroForge uses for the display case / dome and other enclosing shells.
// Strong names identify the case outright; boundary names are only trusted when
// the mesh also sits flush against the exported model's outer bounds.
const CASE_NAME_STRONG = /vault|productVis|loRez|dome|cage|skydome/i
const CASE_NAME_BOUNDARY = /sky|case|display|cube|glass|shell|env/i

// Identifies the HeroForge wrapping cube / display case ("dome") so OBJ export
// can skip it. Three independent detectors, any of which can flag a shell:
//   1. Containment: a mesh whose world AABB encloses the union of every other
//      exported mesh (single-piece case, works at any size ratio).
//   2. Name + boundary: a mesh whose name looks like a case (sky/dome/case/
//      glass/...) and whose AABB touches the union's outer surface (covers the
//      multi-panel "dome" that sits flush around the figure).
//   3. Volume gap: one mesh dwarfs every real body part by many orders of
//      magnitude (the original STL heuristic).
// Returns a Set of mesh uuids to skip.
const cubeMeshUuids = () => {
  const boxes = []
  const seen = new Set()
  getExportRoots().forEach(root => {
    root.updateMatrixWorld(true)
    root.traverse(obj => {
      if (!obj.isMesh || seen.has(obj.uuid)) return
      seen.add(obj.uuid)
      try {
        const b = worldAABB(obj)
        if (b) boxes.push({ uuid: obj.uuid, name: obj.name || obj.type, ...b })
      } catch (e) { /* unreadable mesh - ignore for case detection */ }
    })
  })
  if (boxes.length === 0) return new Set()

  // Filter out absurdly large meshes (>100 units) that are clearly broken/erroneous
  // (e.g., skinned meshes with bone matrix issues). These corrupt the union bounds.
  const validBoxes = boxes.filter(b => {
    const dx = b.maxX - b.minX
    const dy = b.maxY - b.minY
    const dz = b.maxZ - b.minZ
    return dx <= 100 && dy <= 100 && dz <= 100
  })
  const boxesForUnion = validBoxes.length > 0 ? validBoxes : boxes

  const union = {
    minX: Math.min(...boxesForUnion.map(b => b.minX)),
    minY: Math.min(...boxesForUnion.map(b => b.minY)),
    minZ: Math.min(...boxesForUnion.map(b => b.minZ)),
    maxX: Math.max(...boxesForUnion.map(b => b.maxX)),
    maxY: Math.max(...boxesForUnion.map(b => b.maxY)),
    maxZ: Math.max(...boxesForUnion.map(b => b.maxZ))
  }
  const diag = Math.sqrt(
    (union.maxX - union.minX) ** 2 +
    (union.maxY - union.minY) ** 2 +
    (union.maxZ - union.minZ) ** 2
  )
  const eps = 1e-4 * Math.max(diag, 1e-9)

  const removed = new Set()
  const flush = b =>
    b.minX <= union.minX + eps || b.maxX >= union.maxX - eps ||
    b.minY <= union.minY + eps || b.maxY >= union.maxY - eps ||
    b.minZ <= union.minZ + eps || b.maxZ >= union.maxZ - eps

  // Detector 1: Name + boundary (case-like name AND flush against union bounds)
  // Run FIRST since vault parts have clear names (vault*, productVis) and
  // containment can catch only 1 piece of a multi-part vault.
  for (const b of boxes) {
    if (CASE_NAME_STRONG.test(b.name) || (CASE_NAME_BOUNDARY.test(b.name) && flush(b))) {
      removed.add(b.uuid)
    }
  }

  if (removed.size > 0) {
    console.log(`[Herosaver] OBJ: dropped ${removed.size} case-like shell(s) (name/boundary)`)
    return removed
  }

  // Detector 2: Containment (any mesh whose AABB encloses the union of ALL OTHER meshes)
  for (const b of boxes) {
    const otherBoxes = boxes.filter(bx => bx.uuid !== b.uuid)
    if (otherBoxes.length === 0) continue
    const otherUnion = {
      minX: Math.min(...otherBoxes.map(bx => bx.minX)),
      minY: Math.min(...otherBoxes.map(bx => bx.minY)),
      minZ: Math.min(...otherBoxes.map(bx => bx.minZ)),
      maxX: Math.max(...otherBoxes.map(bx => bx.maxX)),
      maxY: Math.max(...otherBoxes.map(bx => bx.maxY)),
      maxZ: Math.max(...otherBoxes.map(bx => bx.maxZ))
    }
    const encloses =
      b.minX <= otherUnion.minX + eps && b.maxX >= otherUnion.maxX - eps &&
      b.minY <= otherUnion.minY + eps && b.maxY >= otherUnion.maxY - eps &&
      b.minZ <= otherUnion.minZ + eps && b.maxZ >= otherUnion.maxZ - eps
    if (encloses) removed.add(b.uuid)
  }

  if (removed.size > 0) {
    console.log(`[Herosaver] OBJ: dropped ${removed.size} enclosing shell(s) (containment)`)
    return removed
  }

  // Detector 3: Volume gap (one mesh dwarfs all others)
  const asc = boxes
    .map(b => ({ uuid: b.uuid, vol: (b.maxX - b.minX) * (b.maxY - b.minY) * (b.maxZ - b.minZ) }))
    .filter(b => b.vol > 0)
    .sort((a, b) => a.vol - b.vol)

  let splitPos = -1
  let maxRatio = 1
  for (let k = 0; k < asc.length - 1; k++) {
    const ratio = asc[k + 1].vol / asc[k].vol
    if (ratio > maxRatio) { maxRatio = ratio; splitPos = k }
  }

  if (splitPos >= 0 && maxRatio > 1000) {
    for (let k = splitPos + 1; k < asc.length; k++) removed.add(asc[k].uuid)
    console.log(`[Herosaver] OBJ: dropped ${removed.size} oversized shell(s) (volume gap ${maxRatio.toExponential(1)}x)`)
    return removed
  }

  const top = boxes
    .map(b => ({
      name: b.name,
      size: `${(b.maxX - b.minX).toFixed(2)}x${(b.maxY - b.minY).toFixed(2)}x${(b.maxZ - b.minZ).toFixed(2)}`,
      flush: flush(b) ? 'Y' : ''
    }))
    .sort((a, b) => b.size.length - a.size.length)
    .slice(0, 10)
  console.warn(`[Herosaver] OBJ: no case detected (union ${(union.maxX - union.minX).toFixed(2)}x${(union.maxY - union.minY).toFixed(2)}x${(union.maxZ - union.minZ).toFixed(2)}, gap ${maxRatio.toExponential(1)}x). Top meshes:`, top)
  return removed
}

// Export the character to a binary STL ArrayBuffer (the common starting point
// for the STL/OBJ exports and the cube removal that both share).
// Export the character to a binary STL ArrayBuffer (the common starting point
// for the STL/OBJ exports). Optionally filters out the HeroForge wrapping
// cube/display case by UUID before export, using the same name/boundary
// detection as the OBJ export.
const exportSTLBuffer = subdivisions => {
  const group = process(getExportRoots(), subdivisions, !!character.data.mirroredPose)
  const view = new STLExporter().parse(group, { binary: true })
  // STLExporter binary mode returns a DataView; normalize to a plain ArrayBuffer.
  return view.buffer
    ? view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
    : view
}

// export full scene as JSON (for debugging)
window.saveJson = () => saveAs(new Blob([JSON.stringify(window.CK.data.getJson())], { type: 'application/json;charset=utf-8' }), `${sanitize(getName())}.json`)

// Debug: validate the corrected bakeSkinnedVertex formula against the live shader.
// Call debugSkin() in DevTools after loading herosaver.js to verify skinning output.
window.debugSkin = () => {
  let mesh = null
  character.traverseVisible(o => { if (o.isSkinnedMesh && o.name === 'bodyLower') mesh = o })
  if (!mesh) { character.traverseVisible(o => { if (o.isSkinnedMesh && !mesh) mesh = o }) }
  if (!mesh) { console.log('no skinned mesh found'); return }

  const geo = mesh.geometry
  const skel = mesh.skeleton

  // Sawtooth weight decoder (mirrors shader: abs(mod(v+1,2)-1))
  const decodeWeight = v => { let m = (v + 1) % 2; if (m < 0) m += 2; return Math.abs(m - 1) }

  // mat4 * vec3 (w=1), Three.js column-major
  const mulMV = (m, x, y, z) => [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14]
  ]
  const mulMM = (a, b) => {
    const r = new Array(16).fill(0)
    for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) r[c * 4 + row] += a[k * 4 + row] * b[c * 4 + k]
    return r
  }

  // Verify vertex 0
  const posAttr = geo.getAttribute('position')
  let vx = posAttr.getX(0); let vy = posAttr.getY(0); let vz = posAttr.getZ(0)

  // Apply morph targets (matches shader)
  const infl = mesh.morphTargetInfluences || []
  for (let mt = 0; mt < infl.length; mt++) {
    if (!infl[mt]) continue
    const a = geo.getAttribute('morphTarget' + mt)
    if (!a) continue
    vx += a.getX(0) * infl[mt]; vy += a.getY(0) * infl[mt]; vz += a.getZ(0) * infl[mt]
  }
  console.log('morphed vertex[0]:', [vx, vy, vz].map(v => v.toFixed(6)))

  // Apply bindMatrix
  const bm = mesh.bindMatrix.elements
  ;[vx, vy, vz] = mulMV(bm, vx, vy, vz)

  // Weighted skinning over skin0, skin1, skin2
  const bmi = mesh.bindMatrixInverse.elements
  let sx = 0; let sy = 0; let sz = 0; let skinSum = 0
  const active = (geo.skinNames || ['skin0']).slice(0, 3)
  active.forEach(sname => {
    const attr = geo.getAttribute(sname)
    if (!attr) return
    const pairs = attr.itemSize / 2
    const base = 0 * attr.itemSize
    for (let p = 0; p < pairs; p++) {
      const bi = Math.round(attr.array[base + p * 2])
      const w = decodeWeight(attr.array[base + p * 2 + 1])
      if (!w) continue
      const bone = skel.bones[bi]
      const inv = skel.boneInverses[bi]
      if (!bone || !inv) continue
      const mat = mulMM(bone.matrixWorld.elements, inv.elements)
      const [cx, cy, cz] = mulMV(mat, vx, vy, vz)
      console.log(`  bone[${bi}] "${bone.name}" w=${w.toFixed(4)} → [${cx.toFixed(4)}, ${cy.toFixed(4)}, ${cz.toFixed(4)}]`)
      sx += cx * w; sy += cy * w; sz += cz * w; skinSum += w
    }
  })
  if (skinSum > 0) { sx /= skinSum; sy /= skinSum; sz /= skinSum }
  const [rx, ry, rz] = mulMV(bmi, sx, sy, sz)
  console.log('skinSum:', skinSum.toFixed(6))
  console.log('final baked vertex[0] (world):', [rx, ry, rz].map(v => v.toFixed(4)))
  console.log('Expected: right toe area, roughly [-0.41..0.06..0.75] or post-transform')
}

// export character as STL file, cube included (binary to avoid JS string length
// limits on large models). Kept for callers that want the raw, uncleaned export.
window.saveStl = subdivisions => {
  saveAs(new Blob([exportSTLBuffer(subdivisions)], { type: 'application/octet-stream' }), `${sanitize(getName())}.stl`)
}

// export character as STL file with the surrounding cube/shell removed.
// Same pipeline as saveStl, then the cube is stripped from the exported buffer.
window.saveCleanStl = subdivisions => {
  const cleaned = removeCubeFromSTL(exportSTLBuffer(subdivisions))
  saveAs(new Blob([cleaned], { type: 'application/octet-stream' }), `${sanitize(getName())}_clean.stl`)
}

// export character as OBJ file with UVs and a MTL referencing the saved color
// atlas. The atlas PNGs are written first (saveTextures), then every mesh is
// baked to world space and its local 0-1 UVs are remapped into its atlas
// rectangle using the same uvPosScl (offset.xy, scale.zw) uniform the live
// RawShaderMaterial uses - so the exported UVs sample exactly what the shader
// does. Meshes that reference the same colorAtlasMap texture (e.g. a mount's
// own atlas) are grouped under their own MTL material.
window.saveObj = () => {
  try {
    saveObjInner()
  } catch (e) {
    console.error('[Herosaver] saveObj failed:', e)
  }
}

const saveObjInner = () => {
  const atlases = window.saveTextures()
  console.log(`[Herosaver] saveObj: saved ${atlases.size} atlas texture(s)`)

  const vertices = []
  const uvs = []
  const faces = []

  // Same coordinate transform used by process() for STL/OBJ: rotate 90° on X, scale ×10
  const mrot = new Matrix4().makeRotationX(90 * Math.PI / 180)
  const msca = new Matrix4().makeScale(10, 10, 10)
  const mTransform = new Matrix4().multiplyMatrices(msca, mrot)

  // Which saved PNG a material samples, found by matching its colorAtlasMap
  // texture against the atlases saveTextures just wrote out.
  const atlasFileFor = material => {
    const tex = material && material.uniforms && material.uniforms.colorAtlasMap &&
      material.uniforms.colorAtlasMap.value
    const entry = tex && atlases.get(tex.uuid)
    return entry ? entry.file : null
  }

  // The shader's atlas-rect remap (offset.xy, scale.zw). Applied verbatim -
  // no extra v-flip, because saveTextures stores the PNG in GL orientation.
  const uvPosSclFor = material => {
    const uvps = material && material.uniforms && material.uniforms.uvPosScl &&
      material.uniforms.uvPosScl.value
    return uvps
      ? { ox: uvps.x, oy: uvps.y, sx: uvps.z, sy: uvps.w }
      : { ox: 0, oy: 0, sx: 1, sy: 1 }
  }

  const mtlMaterials = new Map()
  const mtlOrder = []

  const ensureMtl = atlasFile => {
    const name = atlasFile ? 'mat_' + atlasFile.replace(/\.png$/, '') : 'mat_hero'
    if (!mtlMaterials.has(name)) {
      mtlMaterials.set(name, atlasFile)
      mtlOrder.push(name)
    }
    return name
  }

  getExportRoots().forEach(root => root.updateMatrixWorld(true))

  // The wrapping cube / "display case" is removed from the OBJ just like the
  // STL export does, so the geometry you get is only the actual model. If
  // detection fails for any reason, export anyway (cube included) rather than
  // losing the whole OBJ.
  let cubeMeshes = new Set()
  try {
    cubeMeshes = cubeMeshUuids()
  } catch (e) {
    console.warn('[Herosaver] cube detection failed, exporting with the wrapping cube:', e)
  }

  const seenMeshes = new Set()
  let vertexOffset = 1
  let uvOffset = 1

  getExportRoots().forEach(root => {
    root.traverse(obj => {
      if (!obj.isMesh) return
      if (!obj.visible) return
      if (seenMeshes.has(obj.uuid)) return
      if (cubeMeshes.has(obj.uuid)) return
      seenMeshes.add(obj.uuid)

      // One broken mesh (unexpected geometry/material) must not abort the whole
      // export - log it and keep going so the OBJ still downloads.
      try {
        emitMesh(obj)
      } catch (e) {
        console.warn(`[Herosaver] skipped mesh "${obj.name || obj.type}" in saveObj:`, e)
      }
    })
  })

  function emitMesh (obj) {
    const geo = obj.geometry
    if (!geo || typeof geo.getAttribute !== 'function') {
      console.warn(`[Herosaver] skipped mesh "${obj.name || obj.type}": no readable geometry`)
      return
    }
    const pos = geo.getAttribute('position')
    if (!pos) return
    const uv = geo.getAttribute('uv')
    const isSkinned = obj.isSkinnedMesh || (obj.skeleton && obj.skeleton.bones && obj.skeleton.bones.length > 0)

    // Bake vertices to world space (skinning included) and apply the export transform.
    const vStart = vertexOffset
    for (let i = 0; i < pos.count; i++) {
      const v = isSkinned
        ? bakeSkinnedVertex(obj, i).applyMatrix4(obj.matrixWorld)
        : new Vector3(pos.getX(i), pos.getY(i), pos.getZ(i)).applyMatrix4(obj.matrixWorld)
      v.applyMatrix4(mTransform)
      vertices.push(`v ${v.x} ${v.y} ${v.z}`)
    }
    vertexOffset += pos.count

    // Remap this part's local 0-1 UV into its rectangle in the shared color
    // atlas. HeroForge meshes use a single material, so one remap per mesh.
    const uStart = uvOffset
    if (uv) {
      const remap = uvPosSclFor(Array.isArray(obj.material) ? obj.material[0] : obj.material)
      for (let i = 0; i < uv.count; i++) {
        uvs.push(`vt ${uv.getX(i) * remap.sx + remap.ox} ${uv.getY(i) * remap.sy + remap.oy}`)
      }
      uvOffset += uv.count
    }

    const index = geo.index
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    const groups = geo.groups && geo.groups.length
      ? geo.groups
      : [{ start: 0, count: index ? index.count : pos.count, materialIndex: 0 }]

    for (const group of groups) {
      const mat = materials[group.materialIndex] || materials[0]
      faces.push(`usemtl ${ensureMtl(atlasFileFor(mat))}`)

      for (let i = 0; i < group.count; i += 3) {
        let ai, bi, ci
        if (index) {
          ai = index.getX(group.start + i)
          bi = index.getX(group.start + i + 1)
          ci = index.getX(group.start + i + 2)
        } else {
          const base = group.start + i
          ai = base
          bi = base + 1
          ci = base + 2
        }

        const av = ai + vStart
        const bv = bi + vStart
        const cv = ci + vStart

        if (uv) {
          const at = ai + uStart
          const bt = bi + uStart
          const ct = ci + uStart
          faces.push(`f ${av}/${at} ${bv}/${bt} ${cv}/${ct}`)
        } else {
          faces.push(`f ${av} ${bv} ${cv}`)
        }
      }
    }
  }

  const obj =
`mtllib ${getName()}.mtl

${vertices.join('\n')}

${uvs.join('\n')}

${faces.join('\n')}
`

  console.log(`[Herosaver] saveObj: built ${vertices.length} vertices / ${uvs.length} UVs / ${faces.length} faces (${(obj.length / 1024 / 1024).toFixed(1)} MB)`)
  try {
    saveAs(new Blob([obj]), `${sanitize(getName())}.obj`)
    console.log('[Herosaver] saveObj: .obj download triggered')
  } catch (e) {
    console.error('[Herosaver] failed to save OBJ:', e)
  }

  const mtl = []
  for (const name of mtlOrder) {
    mtl.push(
      `newmtl ${name}`,
      'Ka 1.0 1.0 1.0',
      'Kd 1.0 1.0 1.0',
      'Ks 0.0 0.0 0.0',
      'd 1.0',
      'illum 1'
    )
    const file = mtlMaterials.get(name)
    if (file) mtl.push(`map_Kd ${file}`)
  }

  try {
    saveAs(new Blob([mtl.join('\n')], { type: 'text/plain' }), `${sanitize(getName())}.mtl`)
    console.log('[Herosaver] saveObj: .mtl download triggered')
  } catch (e) {
    console.error('[Herosaver] failed to save MTL:', e)
  }
}

// ─── eye compositing ─────────────────────────────────────────────────────────
// The color-atlas bake renders creature eyes through the *simplified*
// surfaceBake path (solid sclera2 + solid iris1 disc), so the exported eye
// cells read as flat coloured discs with no pupil, iris gradient or sclera
// detail. The live eye shader (shaderkit.js) instead blends the scleraTexture /
// irisAndDistanceTexture red-channel gradients against the sclera0-2 / iris0-2
// basis colours, carves the pupil from the iris alpha, and shades the limbal
// ring from the distance map. We replicate that full path per pixel while the
// atlas PNG is still in memory, so the saved texture carries the real eye.

const eyePixels = texture => {
  if (!texture) return null
  const img = texture.image
  if (!img || !img.width || !img.height) return null
  const w = img.width; const h = img.height
  let raw = null
  if (img.data instanceof Uint8Array) {
    raw = img.data
  } else {
    try {
      const c = document.createElement('canvas')
      c.width = w; c.height = h
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0, w, h)
      raw = ctx.getImageData(0, 0, w, h).data
    } catch (e) {
      console.warn('[Herosaver] could not read eye texture:', e)
      return null
    }
  }
  const data = new Uint8Array(raw)
  if (texture.flipY !== false) {
    for (let y = 0; y < h; y++) {
      data.set(raw.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4)
    }
  }
  return { data, w, h }
}

const eyeColor3 = value => {
  if (!value) return { r: 0, g: 0, b: 0 }
  if (value.isColor) return { r: value.r, g: value.g, b: value.b }
  if (value.isVector3) return { r: value.x, g: value.y, b: value.z }
  if (Array.isArray(value)) return { r: value[0], g: value[1], b: value[2] }
  return { r: value.x || 0, g: value.y || 0, b: value.z || 0 }
}

const buildEyeSampler = material => {
  const u = material.uniforms
  const sclera = eyePixels(u.scleraTexture && u.scleraTexture.value)
  const iris = eyePixels(u.irisAndDistanceTexture && u.irisAndDistanceTexture.value)
  if (!sclera || !iris) return null

  // Mean red-channel value over the iris region (top half, where the alpha mask
  // is opaque). The iris texture's grayscale pattern is the actual fiber detail
  // the bake flattens away; normalising each sample against this mean lets us
  // overlay that detail without shifting the overall iris brightness.
  let irisSum = 0
  let irisN = 0
  const ih = Math.floor(iris.h / 2)
  for (let y = 0; y < ih; y++) {
    for (let x = 0; x < iris.w; x++) {
      const i = (y * iris.w + x) * 4
      if (iris.data[i + 3] > 128) {
        irisSum += iris.data[i]
        irisN++
      }
    }
  }

  return {
    sclera0: eyeColor3(u.sclera0 && u.sclera0.value),
    sclera1: eyeColor3(u.sclera1 && u.sclera1.value),
    sclera2: eyeColor3(u.sclera2 && u.sclera2.value),
    iris0: eyeColor3(u.iris0 && u.iris0.value),
    iris1: eyeColor3(u.iris1 && u.iris1.value),
    iris2: eyeColor3(u.iris2 && u.iris2.value),
    pupil: eyeColor3(u.pupil && u.pupil.value),
    limbus: +(u.limbus && u.limbus.value) || 0,
    irisSize: +(u.irisSize && u.irisSize.value) || 0.5,
    irisRotate: +(u.irisRotate && u.irisRotate.value) || 0,
    irisMean: irisN ? irisSum / irisN / 255 : 0.5,
    sclera: sclera,
    iris: iris
  }
}

// The eye shader, in plain JS. `uv` is the eye mesh's local UV (0-1) inside its
// atlas cell; returns the sRGB albedo the color bake would output.
const eyeShade = (eye, u, v) => {
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x))
  const mix = (a, b, t) => a + (b - a) * t
  const sample = (tex, su, sv) => {
    const x = clamp(Math.floor(su * (tex.w - 1)), 0, tex.w - 1)
    const y = clamp(Math.floor(sv * (tex.h - 1)), 0, tex.h - 1)
    const i = (y * tex.w + x) * 4
    return { r: tex.data[i] / 255, g: tex.data[i + 1] / 255, b: tex.data[i + 2] / 255, a: tex.data[i + 3] / 255 }
  }

  const veins = sample(eye.sclera, u, v)
  const w0 = clamp(1 - 2 * veins.r, 0, 1)
  const w1 = clamp(1 - Math.abs(1 - 2 * veins.r), 0, 1)
  const w2 = clamp(2 * veins.r - 1, 0, 1)
  let r = eye.sclera0.r * w0 + eye.sclera1.r * w1 + eye.sclera2.r * w2
  let g = eye.sclera0.g * w0 + eye.sclera1.g * w1 + eye.sclera2.g * w2
  let b = eye.sclera0.b * w0 + eye.sclera1.b * w1 + eye.sclera2.b * w2

  const iux0 = u - 0.5
  const iuy0 = v - 0.5
  const sr = Math.sin(eye.irisRotate)
  const cr = Math.cos(eye.irisRotate)
  const iux = (cr * iux0 + sr * iuy0) / eye.irisSize + 0.5
  const iuy = (-sr * iux0 + cr * iuy0) / eye.irisSize + 0.5

  if (iux > 0 && iuy > 0 && iux < 1 && iuy < 1) {
    const ramp = sample(eye.iris, iux, iuy * 0.5)
    const dist = sample(eye.iris, iux, iuy * 0.5 + 0.5)
    const radius = 1 - dist.r * 2
    let irisA = ramp.a
    if (irisA > 0.55) {
      r = eye.pupil.r; g = eye.pupil.g; b = eye.pupil.b
    }
    irisA = clamp(1 - Math.abs(1 - 2 * irisA), 0, 1)
    const limbusBlend = clamp(1 + (radius - 1) / Math.max(eye.limbus, 1e-3), 0, 1)
    const limbusShadow = clamp(1 + (radius - 1) / (2 * Math.max(eye.limbus, 1e-3)), 0, 1)
    irisA *= 1 - limbusBlend
    const iw0 = clamp(1 - 2 * ramp.r, 0, 1)
    const iw1 = clamp(1 - Math.abs(1 - 2 * ramp.r), 0, 1)
    const iw2 = clamp(2 * ramp.r - 1, 0, 1)
    let ir = eye.iris0.r * iw0 + eye.iris1.r * iw1 + eye.iris2.r * iw2
    let ig = eye.iris0.g * iw0 + eye.iris1.g * iw1 + eye.iris2.g * iw2
    let ib = eye.iris0.b * iw0 + eye.iris1.b * iw1 + eye.iris2.b * iw2
    const ish = 1 - limbusShadow
    ir *= ish; ig *= ish; ib *= ish
    // Overlay the iris texture's grayscale pattern as fiber detail, normalised
    // to its mean so brightness is preserved. The shader discards this channel
    // (it only uses the red gradient to pick basis colours), which is exactly
    // why the baked eye reads as a flat disc.
    const dl = ramp.r / (eye.irisMean || 0.5)
    const dw = 0.6
    ir = clamp(ir * (1 - dw + dw * dl), 0, 1)
    ig = clamp(ig * (1 - dw + dw * dl), 0, 1)
    ib = clamp(ib * (1 - dw + dw * dl), 0, 1)
    r = mix(r, ir, irisA)
    g = mix(g, ig, irisA)
    b = mix(b, ib, irisA)
  }

  // Baked cornea gloss: the unlit color bake has no specular, which is a big
  // part of why the in-game eye reads as wet/detailed. Lay a soft white glint
  // over the upper-iris area; kept subtle and elliptical so it doesn't fight
  // the flat low-poly body around the eye.
  const gu = (u - 0.4) / 0.15
  const gv = (v - 0.34) / 0.1
  const glint = 0.4 * Math.exp(-(gu * gu + gv * gv) / 2)
  r = clamp(r + glint, 0, 1)
  g = clamp(g + glint, 0, 1)
  b = clamp(b + glint, 0, 1)

  return [r, g, b]
}

// Paint a faithful eye over every eye cell in the just-flipped atlas pixels.
const compositeEyes = (flipped, atlasW, atlasH, atlasTexture) => {
  const eyes = []
  const seen = new Set()
  getExportRoots().forEach(root => {
    root.traverse(obj => {
      if (!obj.isMesh || seen.has(obj.uuid)) return
      seen.add(obj.uuid)
      const m = Array.isArray(obj.material) ? obj.material[0] : obj.material
      if (!m || !m.uniforms) return
      const irisTex = m.uniforms.irisAndDistanceTexture && m.uniforms.irisAndDistanceTexture.value
      if (!irisTex || !irisTex.isTexture) return
      const atlasTex = m.uniforms.colorAtlasMap && m.uniforms.colorAtlasMap.value
      if (!atlasTex || atlasTex.uuid !== atlasTexture.uuid) return
      const uvps = m.uniforms.uvPosScl && m.uniforms.uvPosScl.value
      if (!uvps) return
      const eye = buildEyeSampler(m)
      if (!eye) return
      eyes.push({ name: obj.name || obj.type, eye, uvps })
    })
  })
  if (!eyes.length) return

  for (const e of eyes) {
    const x0 = Math.round(e.uvps.x * atlasW)
    const y0 = Math.round(e.uvps.y * atlasH)
    const cw = Math.max(1, Math.round(e.uvps.z * atlasW))
    const ch = Math.max(1, Math.round(e.uvps.w * atlasH))
    for (let fr = Math.max(0, atlasH - y0 - ch); fr < Math.min(atlasH, atlasH - y0); fr++) {
      const v = (atlasH - 1 - fr - y0) / ch
      for (let px = Math.max(0, x0); px < Math.min(atlasW, x0 + cw); px++) {
        const u = (px - x0) / cw
        const rgb = eyeShade(e.eye, u, v)
        const i = (fr * atlasW + px) * 4
        flipped[i] = Math.round(rgb[0] * 255)
        flipped[i + 1] = Math.round(rgb[1] * 255)
        flipped[i + 2] = Math.round(rgb[2] * 255)
        flipped[i + 3] = 255
      }
    }
    console.log(`[Herosaver] composited eye "${e.name}" into cell (${x0},${y0}) ${cw}x${ch} (irisSize=${e.eye.irisSize}, limbus=${e.eye.limbus}, iris=${toHex(e.eye.iris1)}, sclera=${toHex(e.eye.sclera2)}, pupil=${toHex(e.eye.pupil)})`)
  }
}

const toHex = c => `#${[c.r, c.g, c.b].map(x => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0')).join('')}`

// Every distinct bake in the scene is exported, so a composition with multiple
// models (rider + mount/familiar) produces one atlas per model. Each PNG is
// flipped to GL orientation (v=0 at the bottom) so it matches the shader's
// sampling and the OBJ UVs in saveObj.
// Returns a Map of texture uuid -> { file, width, height } used by saveObj.
window.saveTextures = () => {
  const renderer = window.CK.renderManager.renderer
  const manifest = new Map()
  const nameCounts = {}

  const saveTarget = (target, kind) => {
    const w = target.width
    const h = target.height
    const pixels = new Uint8Array(w * h * 4)

    renderer.readRenderTargetPixels(
      target,
      0,
      0,
      w,
      h,
      pixels
    )

    // Emissive bakes are sometimes not populated; skip a blank emissive atlas.
    if (kind === 'emissive') {
      let lit = false
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] || pixels[i + 1] || pixels[i + 2]) { lit = true; break }
      }
      if (!lit) return
    }

    const base = kind === 'emissive' ? 'emissiveAtlas' : 'colorAtlas'
    nameCounts[base] = (nameCounts[base] || 0) + 1
    const suffix = nameCounts[base] === 1 ? '' : `_${nameCounts[base]}`
    const file = `${sanitize(getName())}_${base}${suffix}.png`

    // readRenderTargetPixels returns rows bottom-to-top; flip them so the PNG
    // is stored top-down (v=0 at the bottom), exactly how the shader samples
    // the atlas. Without this flip the saved texture is upside down, which
    // shows up as misplaced/inverted detail (e.g. the eyes).
    const flipped = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      flipped.set(pixels.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4)
    }

    // Re-paint creature-eye cells with the full eye shader (the bake only has a
    // simplified disc), so the exported atlas carries pupil/iris/sclera detail.
    if (kind === 'color') {
      try {
        compositeEyes(flipped, w, h, target.texture)
      } catch (e) {
        console.warn('[Herosaver] eye compositing failed:', e)
      }
    }

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h

    const ctx = canvas.getContext('2d')
    const data = ctx.createImageData(w, h)

    data.data.set(flipped)
    ctx.putImageData(data, 0, 0)

    canvas.toBlob(blob => {
      if (blob) {
        saveAs(blob, file)
      }
    }, 'image/png')

    manifest.set(target.texture.uuid, { file, width: w, height: h })
  }

  findColorBakes().forEach(bake => {
    const rgba = bake.targetsRGBA
    if (!rgba) return

    // The color atlas is the important one; emissive is included when the bake
    // provides it (some compositions have glowing parts). Each target is saved
    // independently so one unreadable bake can't abort the rest.
    for (const kind of ['color', 'emissive']) {
      const target = rgba[kind]
      if (!target || !target.texture || manifest.has(target.texture.uuid)) continue
      try {
        saveTarget(target, kind)
      } catch (e) {
        console.warn('[Herosaver] failed to save', kind, 'atlas:', e)
      }
    }
  })

  window.__herosaverAtlases = manifest
  return manifest
}

// Debug: dump every discovered color bake and a sample of mesh material/UV
// mappings. Run heroBakes() in DevTools to inspect the atlas layout on the
// live site - useful for diagnosing eye/UV placement and multi-model exports.
window.heroBakes = () => {
  const bakes = []
  findColorBakes().forEach((bake, bi) => {
    const rgba = bake.targetsRGBA || {}
    Object.keys(rgba).forEach(kind => {
      const t = rgba[kind]
      if (!t) return
      bakes.push({
        bake: bi,
        kind,
        width: t.width,
        height: t.height,
        texture: t.texture ? t.texture.uuid : null
      })
    })
  })

  const meshes = []
  const seen = new Set()
  getExportRoots().forEach(root => {
    root.traverse(obj => {
      if (!obj.isMesh || seen.has(obj.uuid)) return
      seen.add(obj.uuid)
      if (!obj.geometry || typeof obj.geometry.getAttribute !== 'function') return // skip non-THREE.js geometries
      const m = Array.isArray(obj.material) ? obj.material[0] : obj.material
      const uvps = m && m.uniforms && m.uniforms.uvPosScl ? m.uniforms.uvPosScl.value : null
      const atlas = m && m.uniforms && m.uniforms.colorAtlasMap ? m.uniforms.colorAtlasMap.value : null
      const uv = obj.geometry.getAttribute('uv')
      meshes.push({
        name: obj.name || '(unnamed)',
        type: obj.type,
        material: m ? (m.type || m.constructor.name) : null,
        uvCount: uv ? uv.count : 0,
        uvPosScl: uvps ? [uvps.x, uvps.y, uvps.z, uvps.w].map(n => +n.toFixed(3)).join(',') : 'none',
        atlasTexture: atlas ? atlas.uuid : null,
        skinned: !!(obj.isSkinnedMesh || (obj.skeleton && obj.skeleton.bones && obj.skeleton.bones.length))
      })
    })
  })

  try {
    console.log('[Herosaver] color bakes:')
    console.table(bakes)
    console.log('[Herosaver] mesh material/UV mappings:')
    console.table(meshes)
  } catch (e) { /* console.table unavailable */ }

  return { bakes, meshes }
}

// Debug: dump every mesh that would be exported, with its world AABB and
// whether it is a candidate for display-case removal. Run heroMeshes() in
// DevTools to identify the dome panels on a real composition.
window.heroMeshes = () => {
  const rows = []
  const seen = new Set()
  getExportRoots().forEach(root => {
    root.updateMatrixWorld(true)
    root.traverse(obj => {
      if (!obj.isMesh || seen.has(obj.uuid)) return
      seen.add(obj.uuid)
      if (!obj.geometry || typeof obj.geometry.getAttribute !== 'function') return // skip non-THREE.js geometries
      const b = worldAABB(obj)
      const m = Array.isArray(obj.material) ? obj.material[0] : obj.material
      rows.push({
        name: obj.name || obj.type || '(unnamed)',
        type: obj.type,
        material: m ? (m.type || m.constructor.name) : null,
        skinned: !!(obj.isSkinnedMesh || (obj.skeleton && obj.skeleton.bones && obj.skeleton.bones.length)),
        size: b ? `${(b.maxX - b.minX).toFixed(2)}x${(b.maxY - b.minY).toFixed(2)}x${(b.maxZ - b.minZ).toFixed(2)}` : '(no geometry)',
        caseName: (CASE_NAME_STRONG.test(obj.name || obj.type) || CASE_NAME_BOUNDARY.test(obj.name || obj.type)) ? 'Y' : ''
      })
    })
  })

  try {
    console.log('[Herosaver] exported meshes:')
    console.table(rows)
  } catch (e) { /* console.table unavailable */ }

  return rows
}

// Debug: inspect the eye meshes' UV mapping against the saved atlases. Run
// saveTextures() first (so __herosaverAtlases is populated), then heroEyes().
// Reports where each eye's UV island lands in the atlas (in pixels) and samples
// that rect - plus its vertical mirror - so we can see whether the eyes sample
// the iris/pupil detail or land on empty/orange-only atlas space.
window.heroEyes = () => {
  const renderer = window.CK && window.CK.renderManager && window.CK.renderManager.renderer
  const targetByUuid = new Map()
  findColorBakes().forEach(bake => {
    const rgba = bake.targetsRGBA || {}
    for (const kind of ['color', 'emissive']) {
      const t = rgba[kind]
      if (t && t.texture) targetByUuid.set(t.texture.uuid, t)
    }
  })

  const atlases = window.__herosaverAtlases || new Map()
  const rows = []
  const seen = new Set()

  const sample = (target, x, y, w, h) => {
    const X = Math.max(0, Math.floor(x))
    const Y = Math.max(0, Math.floor(y))
    const W = Math.min(target.width - X, Math.max(1, Math.round(w)))
    const H = Math.min(target.height - Y, Math.max(1, Math.round(h)))
    const px = new Uint8Array(W * H * 4)
    try {
      renderer.readRenderTargetPixels(target, X, Y, W, H, px)
    } catch (e) {
      return null
    }
    let r = 0; let g = 0; let b = 0; let dark = 0
    for (let i = 0; i < px.length; i += 4) {
      r += px[i]; g += px[i + 1]; b += px[i + 2]
      if (px[i] < 60 && px[i + 1] < 60 && px[i + 2] < 60) dark++
    }
    const n = px.length / 4
    return { avg: `rgb(${Math.round(r / n)},${Math.round(g / n)},${Math.round(b / n)})`, dark: +(100 * dark / n).toFixed(1) + '%' }
  }

  getExportRoots().forEach(root => {
    root.updateMatrixWorld(true)
    root.traverse(obj => {
      if (!obj.isMesh || seen.has(obj.uuid)) return
      seen.add(obj.uuid)
      const name = obj.name || obj.type || ''
      if (!/eye|iris|pupil/i.test(name)) return

      const m = Array.isArray(obj.material) ? obj.material[0] : obj.material
      const uvps = m && m.uniforms && m.uniforms.uvPosScl ? m.uniforms.uvPosScl.value : null
      const tex = m && m.uniforms && m.uniforms.colorAtlasMap ? m.uniforms.colorAtlasMap.value : null
      const entry = tex ? atlases.get(tex.uuid) : null
      const target = tex ? targetByUuid.get(tex.uuid) : null

      const uv = obj.geometry && obj.geometry.getAttribute ? obj.geometry.getAttribute('uv') : null
      let uMin = null; let uMax = null; let vMin = null; let vMax = null
      if (uv) {
        for (let i = 0; i < uv.count; i++) {
          const u = uv.getX(i); const v = uv.getY(i)
          if (uMin === null || u < uMin) uMin = u
          if (uMax === null || u > uMax) uMax = u
          if (vMin === null || v < vMin) vMin = v
          if (vMax === null || v > vMax) vMax = v
        }
      }

      const tw = (target && target.width) || (entry && entry.width) || 1
      const th = (target && target.height) || (entry && entry.height) || 1
      let pxRect = null
      let sampled = null
      let mirrored = null
      if (uvps && uMin !== null) {
        const rx = (uMin * uvps.z + uvps.x) * tw
        const ry = (vMin * uvps.w + uvps.y) * th
        const rw = ((uMax - uMin) * uvps.z) * tw
        const rh = ((vMax - vMin) * uvps.w) * th
        pxRect = `x${rx.toFixed(1)} y${ry.toFixed(1)} ${rw.toFixed(1)}x${rh.toFixed(1)}`
        if (target) {
          sampled = sample(target, rx, ry, rw, rh)
          mirrored = sample(target, rx, th - ry - rh, rw, rh)
        }
      }

      rows.push({
        name,
        atlas: entry ? entry.file : (tex ? tex.uuid.slice(0, 8) : null),
        atlasSize: `${tw}x${th}`,
        uvPosScl: uvps ? [uvps.x, uvps.y, uvps.z, uvps.w].map(n => +n.toFixed(4)).join(',') : 'none',
        uvRange: uMin !== null ? `u${uMin.toFixed(3)}..${uMax.toFixed(3)} v${vMin.toFixed(3)}..${vMax.toFixed(3)}` : 'none',
        atlasPx: pxRect,
        avg: sampled ? sampled.avg : null,
        dark: sampled ? sampled.dark : null,
        darkMirror: mirrored ? mirrored.dark : null
      })
    })
  })

  try {
    console.log('[Herosaver] eye meshes:')
    console.table(rows)
  } catch (e) { /* console.table unavailable */ }

  return rows
}

// Debug: scan each color atlas for the orange iris circles and report which
// 128px cells contain them. Run window.heroIris() to compare against the eye
// uvPosScl rects from heroEyes() (right eye samples cell ~(24,8), left ~(23,8)).
// If the irises live in different cells, the eye UV remap is off.
window.heroIris = () => {
  const renderer = window.CK && window.CK.renderManager && window.CK.renderManager.renderer
  if (!renderer) {
    console.log('[Herosaver] no renderer available')
    return []
  }
  const atlases = window.__herosaverAtlases || new Map()
  const report = []

  findColorBakes().forEach(bake => {
    const target = bake.targetsRGBA && bake.targetsRGBA.color
    if (!target || !target.texture) return
    const w = target.width; const h = target.height
    const px = new Uint8Array(w * h * 4)
    try {
      renderer.readRenderTargetPixels(target, 0, 0, w, h, px)
    } catch (e) {
      return
    }

    const cell = 128
    const ncx = Math.ceil(w / cell)
    const ncy = Math.ceil(h / cell)
    const counts = new Int32Array(ncx * ncy)
    for (let i = 0; i < w * h; i++) {
      const r = px[i * 4]; const g = px[i * 4 + 1]; const b = px[i * 4 + 2]
      if (r > 110 && g > 50 && g < 180 && b < 130 && r > b + 40) {
        const x = i % w; const y = (i / w) | 0
        counts[((x / cell) | 0) + ((y / cell) | 0) * ncx]++
      }
    }

    const cells = []
    for (let cy = 0; cy < ncy; cy++) {
      for (let cx = 0; cx < ncx; cx++) {
        const c = counts[cx + cy * ncx]
        if (c > 200) {
          cells.push({
            cell: `${cx},${cy}`,
            uv: `(${(cx * cell / w).toFixed(3)},${(cy * cell / h).toFixed(3)})`,
            px: c
          })
        }
      }
    }
    cells.sort((a, b) => b.px - a.px)

    const entry = atlases.get(target.texture.uuid)
    report.push({
      atlas: entry ? entry.file : target.texture.uuid.slice(0, 8),
      size: `${w}x${h}`,
      orangeCells: cells.slice(0, 10)
    })
  })

  try {
    console.log('[Herosaver] iris locations (orange clusters, 128px cells):')
    console.table(report)
  } catch (e) { /* console.table unavailable */ }

  return report
}

// Debug: crop each eye mesh's sampled atlas rect out of the render target,
// upscale it 8x (nearest-neighbour) and download as a PNG so the iris/pupil
// detail can be inspected directly. Also logs every texture the eye material
// uses - if the pupil lives in a separate map, it will show up there.
window.heroCropEyes = () => {
  const renderer = window.CK && window.CK.renderManager && window.CK.renderManager.renderer
  if (!renderer) {
    console.log('[Herosaver] no renderer available')
    return
  }
  const targetByUuid = new Map()
  findColorBakes().forEach(bake => {
    const rgba = bake.targetsRGBA || {}
    for (const kind of ['color', 'emissive']) {
      const t = rgba[kind]
      if (t && t.texture) targetByUuid.set(t.texture.uuid, t)
    }
  })

  const seen = new Set()
  getExportRoots().forEach(root => {
    root.traverse(obj => {
      if (!obj.isMesh || seen.has(obj.uuid)) return
      seen.add(obj.uuid)
      const name = obj.name || obj.type || ''
      if (!/eye|iris|pupil/i.test(name)) return

      const m = Array.isArray(obj.material) ? obj.material[0] : obj.material
      const textures = []
      if (m && m.uniforms) {
        for (const [k, u] of Object.entries(m.uniforms)) {
          if (u && u.value && u.value.isTexture) {
            textures.push(`${k}=${u.value.uuid.slice(0, 8)}${u.value.image ? `(${u.value.image.width}x${u.value.image.height})` : ''}`)
          }
        }
      }

      const uvps = m && m.uniforms && m.uniforms.uvPosScl ? m.uniforms.uvPosScl.value : null
      const tex = m && m.uniforms && m.uniforms.colorAtlasMap ? m.uniforms.colorAtlasMap.value : null
      const target = tex ? targetByUuid.get(tex.uuid) : null

      if (!target || !uvps) {
        console.warn(`[Herosaver] no readable eye atlas for ${name} (textures: ${textures.join(', ') || 'none'})`)
        return
      }

      const w = target.width; const h = target.height
      const x0 = Math.max(0, Math.floor(uvps.x * w))
      const y0 = Math.max(0, Math.floor(uvps.y * h))
      const x1 = Math.min(w, Math.ceil((uvps.x + uvps.z) * w))
      const y1 = Math.min(h, Math.ceil((uvps.y + uvps.w) * h))
      const rw = Math.max(1, x1 - x0)
      const rh = Math.max(1, y1 - y0)

      const px = new Uint8Array(rw * rh * 4)
      try {
        renderer.readRenderTargetPixels(target, x0, y0, rw, rh, px)
      } catch (e) {
        console.warn(`[Herosaver] could not read eye atlas for ${name}:`, e)
        return
      }

      const flipped = new Uint8Array(rw * rh * 4)
      for (let y = 0; y < rh; y++) {
        flipped.set(px.subarray(y * rw * 4, (y + 1) * rw * 4), (rh - 1 - y) * rw * 4)
      }
      let dark = 0
      for (let i = 0; i < flipped.length; i += 4) {
        if (flipped[i] < 60 && flipped[i + 1] < 60 && flipped[i + 2] < 60) dark++
      }

      const scale = 8
      const tmp = document.createElement('canvas')
      tmp.width = rw; tmp.height = rh
      const tmpCtx = tmp.getContext('2d')
      const img = tmpCtx.createImageData(rw, rh)
      img.data.set(flipped)
      tmpCtx.putImageData(img, 0, 0)

      const out = document.createElement('canvas')
      out.width = rw * scale; out.height = rh * scale
      const octx = out.getContext('2d')
      octx.imageSmoothingEnabled = false
      octx.drawImage(tmp, 0, 0, rw * scale, rh * scale)
      out.toBlob(blob => {
        if (blob) saveAs(blob, `${name}_crop.png`)
      }, 'image/png')

      console.log(`[Herosaver] ${name}: crop ${rw}x${rh} at (${x0},${y0}), ${(100 * dark / (rw * rh)).toFixed(1)}% dark, textures: ${textures.join(', ') || 'none'}`)
    })
  })
}

// Debug: dump the eye material's shader source so the export can replicate how
// scleraTexture / irisAndDistanceTexture / clutMap are sampled and blended.
// The material's own shader is a stub, so this reads the real compiled GLSL
// from the renderer's program cache (matched via the irisAndDistanceTexture
// uniform).
window.heroEyeShader = () => {
  const renderer = window.CK && window.CK.renderManager && window.CK.renderManager.renderer
  const programs = (renderer && renderer.info && renderer.info.programs) || []
  console.log('[Herosaver] total compiled programs:', programs.length)
  const EYE = /iris|sclera|clut|eye/i
  let found = 0
  programs.forEach((p, i) => {
    const prog = p && p.program
    if (!prog) return
    const fs = prog.fragmentShader || ''
    const vs = prog.vertexShader || ''
    if (EYE.test(fs + vs)) {
      found++
      console.log(`[Herosaver] program #${i} contains eye tokens`)
      console.log('[Herosaver] --- fragmentShader ---')
      console.log(fs)
      console.log('[Herosaver] --- vertexShader ---')
      console.log(vs)
    }
  })
  if (!found) {
    console.warn('[Herosaver] no eye program matched; listing programs by token:')
    programs.forEach((p, i) => {
      const prog = p && p.program
      const fs = (prog && prog.fragmentShader) || ''
      const tokens = ['iris', 'sclera', 'clut', 'colorAtlasMap', 'uvPosScl', 'physicalAtlas']
      const hit = tokens.filter(t => new RegExp(t, 'i').test(fs))
      if (hit.length) console.log(`program #${i}: ${hit.join(', ')} | fragmentShader ${fs.length} chars`)
    })
  }
}

// Debug: download the eye material's dedicated source textures (scleraTexture,
// irisAndDistanceTexture) as PNGs and report per-channel stats plus the basis
// colours, so we can see what detail the eye shader is working from. The shader
// only uses each texture's RED channel to pick between the sclera0-2 / iris0-2
// basis colours - if those colours are near-identical (all one orange), the
// exported iris is inherently flat and the in-game richness comes from the
// normal map / specular under lighting, which an unlit atlas bake cannot carry.
window.heroEyeTextures = () => {
  const rows = []
  const seen = new Set()

  const stats = tex => {
    if (!tex) return null
    const n = tex.w * tex.h
    const c = [0, 1, 2, 3].map(k => {
      let min = 255; let max = 0; let sum = 0
      for (let i = k; i < tex.data.length; i += 4) {
        const v = tex.data[i]
        if (v < min) min = v
        if (v > max) max = v
        sum += v
      }
      return `${min}-${(sum / n).toFixed(0)}-${max}`
    })
    return { R: c[0], G: c[1], B: c[2], A: c[3] }
  }

  const download = (tex, name) => {
    if (!tex) return
    const c = document.createElement('canvas')
    c.width = tex.w; c.height = tex.h
    const ctx = c.getContext('2d')
    const img = ctx.createImageData(tex.w, tex.h)
    img.data.set(tex.data)
    ctx.putImageData(img, 0, 0)
    c.toBlob(blob => {
      if (blob) saveAs(blob, name)
    }, 'image/png')
  }

  getExportRoots().forEach(root => {
    root.traverse(obj => {
      if (!obj.isMesh || seen.has(obj.uuid)) return
      seen.add(obj.uuid)
      const m = Array.isArray(obj.material) ? obj.material[0] : obj.material
      if (!m || !m.uniforms) return
      const irisTex = m.uniforms.irisAndDistanceTexture && m.uniforms.irisAndDistanceTexture.value
      if (!irisTex || !irisTex.isTexture) return
      const name = (obj.name || obj.type).replace(/[^a-zA-Z0-9_]/g, '_')
      const sclera = eyePixels(m.uniforms.scleraTexture && m.uniforms.scleraTexture.value)
      const iris = eyePixels(irisTex)
      const uvps = m.uniforms.uvPosScl && m.uniforms.uvPosScl.value
      download(sclera, `${name}_sclera.png`)
      download(iris, `${name}_irisDistance.png`)
      rows.push({
        name: obj.name || obj.type,
        sclera: stats(sclera),
        irisDistance: stats(iris),
        sclera0: toHex(eyeColor3(m.uniforms.sclera0 && m.uniforms.sclera0.value)),
        sclera1: toHex(eyeColor3(m.uniforms.sclera1 && m.uniforms.sclera1.value)),
        sclera2: toHex(eyeColor3(m.uniforms.sclera2 && m.uniforms.sclera2.value)),
        iris0: toHex(eyeColor3(m.uniforms.iris0 && m.uniforms.iris0.value)),
        iris1: toHex(eyeColor3(m.uniforms.iris1 && m.uniforms.iris1.value)),
        iris2: toHex(eyeColor3(m.uniforms.iris2 && m.uniforms.iris2.value)),
        pupil: toHex(eyeColor3(m.uniforms.pupil && m.uniforms.pupil.value)),
        limbus: +(m.uniforms.limbus && m.uniforms.limbus.value),
        irisSize: +(m.uniforms.irisSize && m.uniforms.irisSize.value),
        uvPosScl: uvps ? [uvps.x, uvps.y, uvps.z, uvps.w].map(n => +n.toFixed(4)).join(',') : 'none'
      })
    })
  })

  console.log('[Herosaver] eye source textures:')
  try {
    console.table(rows)
  } catch (e) { console.log(rows) }
  return rows
}

// lives (main figure, mount/familiar/companion). Lists only nodes that are a
// mesh or carry a colorBake/_partLightGroup, with their full ancestor path.
// Run heroScene() in DevTools to locate the other model(s) in a composition.
window.heroScene = () => {
  const scene = window.CK && window.CK.scene
  if (!scene) {
    console.log('[Herosaver] no window.CK.scene')
    return []
  }

  const pathOf = obj => {
    const parts = []
    let n = obj
    while (n && n !== scene && n.parent) {
      parts.unshift(n.name || n.type || '(unnamed)')
      n = n.parent
    }
    parts.unshift('scene')
    return parts.join(' > ')
  }

  const rows = []
  scene.traverse(obj => {
    const hasMesh = !!obj.isMesh
    const hasBake = !!obj.colorBake
    const hasPL = !!obj._partLightGroup
    if (!(hasMesh || hasBake || hasPL)) return
    const pos = hasMesh && obj.geometry && obj.geometry.getAttribute ? obj.geometry.getAttribute('position') : null
    const uv = hasMesh && obj.geometry && obj.geometry.getAttribute ? obj.geometry.getAttribute('uv') : null
    rows.push({
      name: obj.name || obj.type || '(unnamed)',
      type: obj.type,
      path: pathOf(obj),
      mesh: hasMesh,
      bake: hasBake,
      partLight: hasPL,
      skinned: !!(obj.isSkinnedMesh || (obj.skeleton && obj.skeleton.bones && obj.skeleton.bones.length)),
      verts: pos ? pos.count : 0,
      uv: uv ? uv.count : 0
    })
  })

  try {
    console.table(rows)
  } catch (e) { /* console.table unavailable */ }

  return rows
}

// ─── Cube detection diagnostic ───────────────────────────────────────────────
// Run heroCubeDiag(subdivisions) in DevTools to inspect STL shell volumes and
// cube detection. Useful for tuning gapRatio when the display case isn't removed.
// Argument: subdivisions (default 2, matches the STL export default).
window.heroCubeDiag = (subdivisions = 2) => {
  try {
    const buffer = exportSTLBuffer(subdivisions)
    const triangles = parseSTL(buffer)
    if (triangles.length === 0) {
      console.log('[Herosaver] no triangles in STL')
      return
    }
    const shells = findConnectedComponents(triangles)
    const info = shells.map(s => analyzeShell(s, triangles))
    console.log(`[Herosaver cube diag] ${shells.length} shell(s), ${triangles.length} faces`)
    console.table(info.map((i, idx) => ({
      shell: idx,
      faces: i.count,
      volume: +i.volume.toPrecision(3),
      cubeScore: +i.cubeScore.toFixed(3),
      axisScore: +i.axisScore.toFixed(3),
      aspectScore: +i.aspectScore.toFixed(3),
      size: i.size.map(s => +s.toFixed(1)).join(' x '),
      bounds: i.bounds.map(v => +v.toFixed(1)).join(', ')
    })))
    // Volume gap analysis
    const asc = info
      .map((info, i) => ({ i, volume: info.volume }))
      .filter(s => s.volume > 0)
      .sort((a, b) => a.volume - b.volume)
    let maxRatio = 1; let splitPos = -1
    for (let k = 0; k < asc.length - 1; k++) {
      const ratio = asc[k + 1].volume / asc[k].volume
      if (ratio > 1) { maxRatio = ratio; splitPos = k }
    }
    console.log(`[Herosaver cube diag] max volume gap: ${maxRatio.toExponential(1)}x (threshold 1000x)`)
    if (splitPos >= 0) {
      console.log('[Herosaver cube diag] Shells above gap (would be removed):', asc.slice(splitPos + 1).map(s => s.i))
    }
  } catch (e) {
    console.error('[Herosaver cube diag] error:', e)
  }
}
