# Plotter — Desmos-style 3D grapher (single offline HTML file)

Date: 2026-07-19 · Status: approved by user

## Goal

A Desmos-feel 3D graphing calculator delivered as one self-contained `index.html`
(works offline, double-click to open). Typed expression list — **no drag-and-drop
object menus** like CalcPlot3D. The row's math determines the object type
automatically. Pretty math input (exponents raise, fractions stack, `rho`→ρ,
`theta`→θ, `pi`→π as you type).

## Decisions (user-confirmed)

- Scope: **everything** in the CalcPlot3D object menu.
- Input: **pretty math editor** → MathQuill (inlined) — same engine Desmos uses.
  `autoCommands` handles the Greek autocomplete requirement.
- Delivery: **fully offline single file**, deps inlined (~1 MB). Sources +
  `build.sh` kept in the repo; `index.html` is the build artifact.

## Architecture

Pipeline per expression row:

MathQuill LaTeX → tokenizer/parser (LaTeX subset → AST) → classifier →
typed plot object → compiled JS evaluator → Three.js geometry.

Modules (concatenated by `build.sh` into `index.html`):

- `parser.js` — LaTeX subset: numbers, vars, subscripts, `\frac`, `\sqrt`
  (+nthroot), `^`, implicit multiplication, functions (`\sin` … `\operatorname`),
  relations (`=`, `\le`, `\ge`, `<`, `>`), tuples `( , , )`, calls `f(…)`.
- `compile.js` — AST → JS closure; free-variable analysis; cylindrical/spherical
  → cartesian substitution (r=√(x²+y²), θ=atan2(y,x), ρ, φ) for implicit mode.
- `classify.js` — statement → object type (table below).
- `geometry.js` — surface tessellation, marching cubes (implicit + regions),
  tube curves, arrow fields, points, labels.
- `scene.js` — Three.js scene, axes + tick labels, bounding box, orbit controls,
  lighting, window ranges.
- `ui.js` — expression rows (MathQuill), Desmos palette + show/hide circle,
  per-row settings popover (color, opacity, resolution, domains), sliders with
  play/animate, error badges, global window settings.
- `main.js` — name resolution + dependency graph (order-independent like
  Desmos), re-evaluation on edit/slider.

## Classification table

| Input | Object |
|---|---|
| `z = f(x,y)` / bare `f(x,y)` (also solved `x=`, `y=`) | Cartesian surface |
| `z = f(r,θ)` | Polar-graph surface |
| `r = f(θ,z)` (incl. `r=1`) | Cylindrical surface |
| `θ = c` | Half-plane; general `θ=f(r,z)` parametric |
| `ρ = f(φ,θ)` | Spherical surface; `φ = c` → cone |
| Unsolved equation (any coord system) | Implicit surface (marching cubes, coord substitution) |
| 3-tuple in `t` | Space curve (inline editable domain, default [0,2π]) |
| 3-tuple in `u,v` | Parametric surface (inline domains) |
| Constant 3-tuple | Point; `name = (a,b,c)` → named point |
| `vector(A, B)` | Arrow A→B |
| `F(x,y,z) = (P,Q,R)` | Vector field (arrow grid over window) |
| Inequality | Region: marching cubes of `max(F, window-planes)` → closed translucent solid |
| `a = number` (free letter) | Slider (min/max/step, play) |
| `f(x)=…`, `c = 2a` | Reusable definition |

Text labels: quotes are not typeable in MathQuill, so labels are a per-row
setting on point rows (rendered as a halo sprite) instead of `label("…")`
syntax. Default window is [-4,4]³ (editable).

Focused/Unfocused Objects → row selection highlights its object; colored circle
toggles visibility (Desmos behavior).

## Rendering

Three.js r134 UMD + OrbitControls, inlined. Per-row solid color (Desmos
palette), double-sided Phong, opacity slider, optional faint wireframe. Implicit
default 40³ (max 80³), surfaces 64×64. Slider drag re-tessellates in place,
throttled. Errors shown per-row (warning badge + message), never crash.

## Verification

Open in Chrome via browser automation; exercise one row per table entry above;
fix regressions. Multi-agent adversarial code review (parser edge cases, math
correctness, classifier, perf) before final delivery.
