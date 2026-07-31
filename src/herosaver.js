/* global Blob */

import { Matrix4, Vector3 } from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { saveAs } from 'file-saver'
import { character, getName, process, bakeSkinnedVertex } from './utils'
import { removeCubeFromSTL } from './cube-remover'

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

// Export the character to a binary STL ArrayBuffer (the common starting point
// for the STL/OBJ exports and the cube removal that both share).
const exportSTLBuffer = subdivisions => {
  const group = process(getExportRoots(), subdivisions, !!character.data.mirroredPose)
  const view = new STLExporter().parse(group, { binary: true })
  // STLExporter binary mode returns a DataView; normalize to a plain ArrayBuffer.
  return view.buffer
    ? view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength)
    : view
}

// export full scene as JSON (for debugging)
window.saveJson = () => saveAs(new Blob([JSON.stringify(window.CK.data.getJson())], { type: 'application/json;charset=utf-8' }), `${getName()}.json`)

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
  saveAs(new Blob([exportSTLBuffer(subdivisions)], { type: 'application/octet-stream' }), `${getName()}.stl`)
}

// Debug: list every mesh in the character so the cube/shell can be identified
// by name. Run heroMeshes() in DevTools and look for an axis-aligned box whose
// size encloses the whole figure - that is the cube.
window.heroMeshes = () => {
  const rows = []
  const seen = new Set()
  getExportRoots().forEach(root => {
    root.updateMatrixWorld(true)
    root.traverse(mesh => {
      if (seen.has(mesh.uuid)) return
      seen.add(mesh.uuid)
      const geo = mesh.geometry
      if (!geo || !(geo.attributes && geo.attributes.position)) return
      const pos = geo.getAttribute('position')
      let minX = Infinity; let minY = Infinity; let minZ = Infinity
      let maxX = -Infinity; let maxY = -Infinity; let maxZ = -Infinity
      for (let i = 0; i < pos.count; i++) {
        const x = pos.getX(i); const y = pos.getY(i); const z = pos.getZ(i)
        if (x < minX) minX = x; if (x > maxX) maxX = x
        if (y < minY) minY = y; if (y > maxY) maxY = y
        if (z < minZ) minZ = z; if (z > maxZ) maxZ = z
      }
      rows.push({
        name: mesh.name || '(unnamed)',
        type: mesh.type,
        visible: mesh.visible,
        skinned: !!(mesh.isSkinnedMesh || (mesh.skeleton && mesh.skeleton.bones && mesh.skeleton.bones.length)),
        verts: pos.count,
        size: [maxX - minX, maxY - minY, maxZ - minZ].map(s => +s.toFixed(3)).join(' x ')
      })
    })
  })
  console.table(rows)
  return rows
}

// export character as STL file with the surrounding cube/shell removed.
// Same pipeline as saveStl, then the cube is stripped from the exported buffer.
window.saveCleanStl = subdivisions => {
  const cleaned = removeCubeFromSTL(exportSTLBuffer(subdivisions))
  saveAs(new Blob([cleaned], { type: 'application/octet-stream' }), `${getName()}_clean.stl`)
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

  const seenMeshes = new Set()
  let vertexOffset = 1
  let uvOffset = 1

  getExportRoots().forEach(root => {
    root.traverse(obj => {
      if (!obj.isMesh) return
      if (seenMeshes.has(obj.uuid)) return
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
    const pos = geo.getAttribute('position')
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

  saveAs(new Blob([obj]), `${getName()}.obj`)

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

  saveAs(new Blob([mtl.join('\n')], { type: 'text/plain' }), `${getName()}.mtl`)
}

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
    const file = `${getName()}_${base}${suffix}.png`

    // readRenderTargetPixels returns rows bottom-to-top; flip them so the PNG
    // is stored top-down (v=0 at the bottom), exactly how the shader samples
    // the atlas. Without this flip the saved texture is upside down, which
    // shows up as misplaced/inverted detail (e.g. the eyes).
    const flipped = new Uint8Array(w * h * 4)
    for (let y = 0; y < h; y++) {
      flipped.set(pixels.subarray(y * w * 4, (y + 1) * w * 4), (h - 1 - y) * w * 4)
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

// Debug: dump the scene hierarchy so you can see exactly where every model
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
