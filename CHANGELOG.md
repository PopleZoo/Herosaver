# Changelog

All notable changes to this project are documented in this file.

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
