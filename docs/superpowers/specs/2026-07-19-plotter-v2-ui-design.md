# Plotter v2 — window zoom, style flyout, intersection rows, docs drawer

Date: 2026-07-19 · Status: approved by user (all four items)

## 1. Window-rescaling zoom

Viewport `+`/`−` buttons scale the axis ranges about their center (×½ / ×2)
instead of moving the camera; camera distance scales by the same factor so the
framing follows. Scroll-wheel keeps camera dolly. The settings-panel window
fields update live on zoom. Gear tooltip: "window & display settings".

## 2. Swatch style flyout

Right-click (or 550 ms long-press) a row's colored circle → compact card at
the swatch: 6 palette dots + opacity slider. Opacity applies live by mutating
materials (no re-tessellation while dragging); saved on release. Plain click
still toggles hide. Region opacity stays clamped ≤ 0.5. Swatch tooltip
documents both gestures.

## 3. Intersection rows

Typing `intersection` (autoOperatorNames) parses to `{kind:'intersection'}` →
spec `{type:'intersect'}`. Substrip shows two `<select>` pickers listing all
surface-capable rows ("2: r = 1", readable-ized latex); default = the two
nearest surface rows above, re-resolved while unset. Selection persists (as
row indices) and survives reload.

Algorithm: one target supplies an implicit form F(x,y,z) — graph (all axes +
polar), cylindrical, spherical, θ/φ constants (θ uses wrapped angle
difference), implicit, region; parametric surfaces cannot. F is evaluated at
the other target's rendered mesh vertices; sign-change triangles yield
interpolated segments; segments chain into polylines (quantized endpoints)
rendered as tubes (CatmullRom, closed when endpoints meet). Neither target
implicit-formable → row error. Fewer than two surfaces → row error.

Reactivity: the intersection's build key includes both targets' latex,
detail, and dependency values, so it rebuilds whenever they do. Geometry
builds run in two passes (intersections after everything else) so meshes are
fresh. Hiding a target surface does not hide the curve (feature: show just
the intersection).

## 4. Docs drawer

"?" button top-right of the viewport (and the panel's existing ? button)
opens a full-height right-side drawer (380 px): typing guide, complete
plot-type table with click-to-insert examples (replaces the old help
popover), coordinate conventions (z-up, φ from +z, θ = atan2(y,x)),
sliders/definitions/domains, intersections, window & view controls. Esc or ×
closes. StaticMath reflows on first open (hidden-container measurement fix).

## Testing

Engine tests: `intersection` parse/classify. Browser: zoom ±, flyout color +
live opacity, intersection of r=1 with ρ=2cos(φ) (circle), slider-driven
surface + intersection updating, docs drawer open/insert/close.
