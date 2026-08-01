# Changelog

All notable changes to this project are documented in this file.

## [1.5.8]

### Fixed
- glTF textures now apply in Blender. The exported atlas PNGs are stored
  vertically mirrored (matching the OBJ export's bottom-left UV origin), but
  glTF UVs have their origin at the top-left, so the whole texture came out
  flipped. The glTF exporter now flips V when remapping UVs into the atlas.

### Added
- On-page panel redesigned as a "Save as" dropdown (STL / OBJ + Textures /
  glTF) with a "Rigged (glTF)" toggle and a separate "Save JSON" button.
  OBJ/STL cannot carry a rig, so ticking "Rigged" exports the rigged glTF
  (textures included); leaving it off exports the selected unrigged format.
  `saveSelected()` dispatches from the panel's choices.
- OBJ + Textures now downloads as a single `.zip` containing the `.obj`, its
  `.mtl`, and the atlas PNGs it references (same STORE zip as glTF). STL also
  downloads as a `.zip`. Atlas PNGs are built once in memory (`buildAtlasFiles`)
  and shared by the OBJ, glTF and standalone-texture paths.

## [1.5.7]

### Fixed
- glTF export was emitting the HeroForge display-case icosphere shells (many
  small spheres arranged around the model). These are `visible=false` in the
  scene; OBJ/STL skip them but the glTF exporter did not. Invisible subtrees are
  now skipped (bones hidden under them are still re-synthesized for the rig), and
  the exporter logs how many invisible objects it skipped.

## [1.5.6]

### Fixed
- glTF export now passes the Khronos validator with zero errors, so Blender can
  import it. Fixes:
  - Accessors were missing the required `count` field (`writeAccessor` never
    returned it), which made importers reject the file outright.
  - Synthesized bones (kitbashing / detached skeletons) left non-root joints
    dangling outside the node tree; the exporter now emits the entire armature
    as a self-contained subtree under the mesh node with bone-local matrices.
  - Skin deduplication keyed skeletons by `skeleton.uuid`, but looked them up by
    the bone-set signature (and old three.js `Skeleton` has no `uuid`), so shared
    skeletons still produced duplicate armatures and all inverse-bind accessors
    collided into one. Both are now keyed by the bone-set signature.
  - Inverse-bind buffer views were tagged `target: ARRAY_BUFFER`; they are now
    target-less as required.

### Removed
- Raw STL export (`Save STL (raw)` button / menu entry and `saveStl()`). Only
  `Save Clean STL` remains; `exportSTLBuffer` is still used by the
  `heroCubeDiag` diagnostic.

## [1.5.5]

### Fixed
- glTF export failed with `t.matrixWorld.clone().invert is not a function` on
  HeroForge's older three.js build (which predates `Matrix4#invert`, added in
  r123). Bone/node local-matrix computation now uses a version-safe inverse
  helper that falls back to `getInverse()` when `invert()` is unavailable.

## [1.5.4]

### Added
- ZIP packaging for glTF export (`saveGltf()`, default format). The exporter now
  emits a `.zip` containing `scene.gltf` + `scene.bin` + a `textures/` folder
  with the color/emissive atlas PNGs as separate files (STORE method, no
  compression - PNGs are already compressed), instead of embedding everything as
  bloated base64 data URIs. The previous single self-contained `.gltf` output is
  still available via `saveGltf({ format: 'single' })`. Internal atlas option
  renamed from `textureDataUris` to `textureAtlas` (`uuid -> { file, dataUri }`)
  so the exporter can reference textures by relative path.

## [1.5.3]

### Added
- Rigged glTF 2.0 export (`Save glTF (rigged)` button + `saveGltf()`). The
  exporter walks the original HeroForge scene graph (not the baked `process()`
  output) so the rig survives: bones become glTF nodes with local matrices,
  `skeleton.boneInverses` become inverse bind matrices, and the sawtooth-encoded
  `skin0`/`skin1`/`skin2` blend weights are decoded into `JOINTS_0`/`WEIGHTS_0`
  (top-4, normalised). Geometry keeps native Y-up coordinates (no STL/OBJ axis
  rotation). Morph targets (stored as `morphTargetN` attributes) are exported as
  glTF morph targets with their influences/names. Color atlases are embedded as
  base-color textures (data URIs, same flip + eye-composite pipeline as
  `saveTextures`), and per-mesh UVs are remapped into their atlas rect via the
  same `uvPosScl` the shader uses. The display case / dome is removed via the
  same `cubeMeshUuids()` detection as OBJ/STL. `Save glTF` is registered in the
  userscript menu and on-page panel.

## [1.5.2]

### Added
- Baked a soft elliptical cornea-gloss glint over the upper-iris area of the
  composited eyes. The unlit color bake has no specular, which is a big part
  of why the in-game eye reads as wet; the glint is kept subtle so it doesn't
  clash with the flat low-poly body.

## [1.5.1]

### Added
- The eye composite now overlays the `irisAndDistanceTexture` top-half
  grayscale pattern as iris-fiber detail (normalised to its mean so overall
  iris brightness is preserved). The eye shader discards this channel, which
  is why the earlier composite looked flat; `heroEyeTextures()` was added to
  download the eye's source textures for inspection.

## [1.5.0]

### Fixed
- Creature eyes exported as flat coloured discs ("two oranges") because the
  color-atlas bake renders eyes through HeroForge's simplified `surfaceBake`
  path (solid `sclera2` + solid `iris1` disc, no pupil/gradient/limbus). The
  full eye shader (read from `shaderkit.js`) is now replicated in JS during
  `saveTextures`: each eye cell is re-painted per-pixel, blending the
  `scleraTexture` / `irisAndDistanceTexture` red-channel gradients against the
  material's `sclera0-2` / `iris0-2` basis colours, carving the pupil from the
  iris alpha, and shading the limbal ring from the distance map. The exported
  atlas therefore carries a real eye, and the OBJ's existing `uvPosScl` UV
  remap samples it without any geometry changes.

## [1.4.0]

### Fixed
- Saved color-atlas PNGs were vertically flipped: `readRenderTargetPixels`
  returns rows bottom-to-top, but they were written straight into the canvas,
  so the exported texture was upside down. Rows are now flipped to GL
  orientation (v=0 at the bottom), matching how the shader samples the atlas.
  This was the cause of misplaced/inverted detail on the exported texture
  (e.g. the eyes looking wrong on the UV image).
- "Save OBJ and Textures" UVs were double-flipped (the old `1 - v` no longer
  matches, since the atlas PNG is now stored correctly oriented). The exported
  `vt` coordinates now use the shader's exact `uvPosScl` remap
  (`localUV * scale + offset`), so OBJ + atlas sample identically to the live
  renderer.

### Added
- `saveTextures` now discovers every `colorBake` in the scene instead of
  reaching one via a hard-coded `scene.children[0].children[3]...` path. A
  composition with several models (character + mount/familiar/companion)
  produces one atlas per model (`_colorAtlas.png`, `_colorAtlas_1.png`, ...).
- `saveObj` exports every scene-level composition root (rider + mount and any
  separate characters) and groups faces by the atlas each material actually
  samples, emitting a `newmtl`/`map_Kd` per atlas in the MTL.
- OBJ export now handles meshes with material arrays and non-indexed geometry.
- Emissive atlases are saved when the bake provides them (blank bakes are
  skipped), and one unreadable bake no longer aborts the rest.
- `window.heroBakes()` debug helper that dumps every discovered bake and the
  material/`uvPosScl`/atlas mapping of each mesh, for diagnosing eye/UV
  placement and multi-model exports on the live site.
- `window.heroScene()` debug helper that lists every mesh/bake node with its
  full scene path, so the location of each model (rider, mount, companion)
  can be confirmed on the live site.
- `saveObj` no longer aborts when one mesh has an unexpected geometry/material:
  the offending mesh is logged and skipped, and any other failure is printed
  to the console instead of silently producing no OBJ.
- OBJ export now strips the HeroForge wrapping cube ("display case") like the
  STL export does, by detecting the oversized enclosing shell mesh via the
  same volume-gap heuristic (`cubeMeshUuids`).
- STL export (`process`) accepts multiple roots and deduplicates meshes, so
  overlapping roots are never exported twice.

## [1.3.2]

### Changed
- "Save OBJ" now removes the wrapping cube too, just like "Save STL". The cube
  detection was refactored to operate on a shared triangle list
  (`removeCubeTriangles`), and the OBJ export routes through the same exported
  STL triangles, so STL and OBJ strip the exact same cube.

## [1.3.1]

### Fixed
- "Save OBJ" produced an empty (0 KB) file. three's `OBJExporter` detects
  meshes with `instanceof Mesh`, which fails when more than one copy of three
  is in scope, so nothing was written. Replaced it with a small self-contained
  OBJ writer (`src/obj-exporter.js`) that detects meshes via the `isMesh` flag,
  matching the robust approach `STLExporter` already uses. Output verified to
  match three's `OBJExporter` for indexed and non-indexed geometry.
- The panel buttons and menu commands now cache-bust the bundle fetch, so they
  always run the latest published bundle instead of a stale cached one.

## [1.3.0]

### Changed
- "Save STL" (both the on-page button and the Tampermonkey menu command) now
  performs the cube-removing export. The separate "Save Clean STL" action was
  removed and folded into "Save STL", since exporting without the wrapping cube
  is the expected default. The raw export is still available as `window.saveStl`.
- Cube detection rewritten: the HeroForge wrapping cube is now found by the huge
  bounding-box volume gap between it and the real body shells, instead of the
  "cube score" heuristic. After the export rotation and skin baking the cube is
  skewed, so its cube score fell below the old threshold and it was missed while
  a real body shell was removed by mistake. The volume-gap approach removes only
  the oversized enclosing shell and keeps the figure intact.

### Added
- The userscript now removes any foreign on-page button labelled exactly
  "Save STL" that it did not create, leaving only the Herosaver panel button.
- `window.heroMeshes()` debug helper that lists every mesh in the character
  (name, type, visibility, vertex count, bounding-box size). Cube removal also
  logs each detected shell to the console for inspection.

## [1.2.0]

### Added
- `saveCleanStl` export that saves the STL with the surrounding cube/shell
  automatically removed, done locally in the bundle (no external page needed).
  The cube-detection algorithm (connected shells + cube scoring) was ported into
  `src/cube-remover.js`.
- On-page floating button panel (Save STL, Save Clean STL, Save OBJ, Save JSON)
  in addition to the existing userscript-manager menu commands.

### Changed
- Userscript now restricts itself to HeroForge (`@match *://*.heroforge.com/*`)
  instead of running on every site.
- Ported the hand-edited `dist` changes back into the source so `src` and `dist`
  stay in sync: `process` now calls `updateMatrixWorld`, traverses all meshes
  (not only visible ones), and applies the mesh world matrix to skinned vertices.

### Removed
- `stl-cube-remover.html` (the standalone "Hero Cleaner" page) and the
  "Send to Hero Cleaner" integration. Cube removal now happens directly in the
  export via `saveCleanStl`, so the external page is no longer required.
