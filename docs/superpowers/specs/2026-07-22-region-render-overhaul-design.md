# Region & surface rendering overhaul — design record

Date: 2026-07-22. Autonomous session; design was selected by a judge-panel
workflow over three competing schemes (refined marching cubes / GPU raymarch /
adaptive dual contouring) plus a material & 2D-fill design. Refined MC won the
performance and risk lenses and took the quality lens's best ideas as grafts.

## What was wrong

- 3D implicit surfaces and region solids used marching tetrahedra over
  `max(F, wall distances)`: staircase-scalloped box caps, chewed rims, lumpy
  silhouettes, noisy soup wireframe, patchy DoubleSide translucency.
- 2D inequalities drew only the boundary contour, no fill.

## Architecture

- `src/mesher.js` (new, THREE-free, fully tested under gjs):
  - `polygonize(F, win, N, opts)` — table-free marching cubes. Each active
    cell's isosurface cross-section is chained into loops from face
    marching-squares segments; face-center saddle deciders are cached per
    global face, so adjacent cells (and the caps) always agree. No 256-entry
    tables to get wrong; watertight by construction.
  - Per-crossing-edge zero refinement: 4 bisection steps (immune to the
    imbalanced brackets the region inset creates and to max() plateaus) then
    Illinois false position; a pole guard keeps 1/x-style sign flips at the
    linear estimate.
  - Normals: true-scale central differences at the refined vertex
    (settle) or trilinear lattice-gradient blend (gestures).
  - `parts` (per-constraint fields of a max()): per-triangle argmax picks the
    active constraint, vertices split per constraint (crisp crease shading),
    and a gated Newton snap moves genuine crease vertices onto g_i = g_j = 0
    (straight crease geometry). Window-face vertices never move.
  - `buildCaps` — box-face caps from the boundary lattice slices, reusing the
    surface's refined crossings and saddle deciders: exactly planar, seam
    vertex-identical with the surface rim, ~zero extra field evals.
  - `fillRegion2D` / `msCellsFill` — 2D inequality fill whose boundary uses
    the very crossings the stroke contour chains from; `dashPolylines` cuts
    strict-inequality strokes by absolute arc length.
- `geometry.js`: `G.region` marches the RAW field over exactly the window
  (never max()-ed with walls) through a 1e-6 inward shrink of space so
  constraints coinciding with a window face still cap; `surfacePair` renders
  every surface twice (BackSide then FrontSide, back tinted 0.86, gentle
  fresnel rim) so translucent solids composite deterministically;
  `G.isoLines` replaces the implicit wireframe with z-elevation contours.
- `scene.js`: `sortTransparent()` orders all pairs far-to-near per rendered
  frame (all plot objects sit at the origin, so three.js's own sort is
  useless here).
- `main.js`: regions default to opacity 0.45 once per row (the old hard 0.5
  clamp is gone — the slider now reaches 1), `_opacityMul` keeps the 2D fill
  at 25% of the stroke opacity under live opacity changes, and the 2D region
  branch builds fill + stroke (dashed when strict, flag from classify.js).

## Known limits (accepted)

- Two-pass ordering is per-object, not per-pixel: interpenetrating
  translucent solids can still mis-composite where they cross (WBOIT is the
  named upgrade path; renderOrder band 10+ left free for it).
- Zoom/pan gestures keep the previous full-quality mesh (content key
  comparison in buildGeomIfDirty): surfaces stay smooth mid-gesture and the
  settle pass re-fits them to the new window ~200 ms after the last input.
  The brief cost is stale extents: caps can lag the moving box until settle.
  Slider-driven changes still rebuild coarse per frame (N=12–16, no
  refinement) because the field itself is morphing.
- Interior creases sharper than the grid can resolve rely on the snap; a
  crease shorter than one cell can still round off.

## Verification

- 192 gjs tests including: closed-manifold sphere, surface+caps closed solid
  (seam exactness), cap planarity, crease normals pure per-constraint, split
  copies present, disc fill area = 4pi +-1%, saddle checkerboard fill area,
  NaN domains, dash splitting, N=48 perf smoke.
- Headless-Chrome screenshot harness (scratchpad shots/): before/after for 8
  scenes plus mixed-scene, dark-theme, strict-dash, polar-region, slider
  checks.
- gjs timings: region3 settle 101 ms, implicit settle 113 ms (V8 is 2-5x
  faster), gestures 5-6 ms, 2D fill 35 ms settle / 8 ms per gesture frame.
