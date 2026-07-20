# Plotter 3D

A Desmos-style 3D graphing calculator in **one self-contained HTML file**.
Open `index.html` in any browser. No internet, no install.

Type math in the expression list and the object type is detected automatically:

| Type | You get |
|---|---|
| `r = 1` | cylinder (cylindrical coords) |
| `theta = pi/4` | half-plane |
| `rho = 2cos(phi)` | spherical surface |
| `phi = pi/6` | cone |
| `z = sin(x) + cos(y)` | surface z = f(x, y), also `x = …` and `y = …` |
| `z = r^2/4` | polar-graph surface |
| `x^2 + y^2 + z^2 = 9` | implicit surface, any coordinate system |
| `(3cos(t), 3sin(t), t/2)` | space curve with an editable `t` range |
| `((2+cos(v))cos(u), …)` | parametric surface with `u, v` ranges |
| `(1, 2, 3)` / `P = (1,2,3)` | point / named point, label in row settings |
| `vector((0,0,0), (1,2,2))` | arrow |
| `F(x,y,z) = (y, -x, z/2)` | vector field |
| `z <= 4 - x^2 - y^2` | solid region clipped to the window |
| `a = 1` | slider with min, max, step, and animation |
| `f(x,y) = x·y·e^(-x^2-y^2)` | reusable definition that also plots |
| `intersection` | curve of intersection of two chosen surfaces |

Typing `rho`, `theta`, `phi`, `pi`, or `tau` autocompletes to ρ, θ, φ, π, τ.
`/` makes a fraction and `^` an exponent, using the same editor engine as
Desmos (MathQuill). Unknown letters offer a one-click add-slider button.

Controls: Enter adds a row. Click a row's colored circle to hide its plot and
right-click it for color and opacity. Scroll or use `+` and `−` to zoom the
window itself, so the axis ranges rescale and everything replots. The `2D`
button flips to a flat orthographic grapher with a Desmos-style grid: drag to
pan, scroll to zoom, and curves like `r = 2 + cos(4θ)` or `y = x²/4` draw as
clean stroked lines. There is a light and a dark theme, and a `?` button with
a reference card. Everything autosaves to localStorage.

## Development

```
src/          application modules (parser, classify, compile, geometry, scene, ui, main)
deps/         vendored jQuery, MathQuill 0.10.1, three.js r134 + OrbitControls
build.sh      concatenates deps + src into index.html
test/         headless engine tests (gjs): ./test/run-tests.sh
```

Rebuild after editing sources: `./build.sh`.

Vendored libraries: [three.js](https://threejs.org) (MIT),
[MathQuill](http://mathquill.com) (MPL 2.0), [jQuery](https://jquery.com) (MIT).
