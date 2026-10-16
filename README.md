# SMH-web

Interactive pages for Scenario Modeling Hub rounds, one folder per round:
https://scc-usc.github.io/SMH-web/

Each round page shows the calibration for any location (by age, by strain, and so on), every model parameter
with its fitted value and 95% range, and the scenario projections. Changing a parameter re-solves that
location's model in the browser.

Plain HTML and JavaScript: no build step and no server. To work on it locally, serve the folder with any static
server, for example `python -m http.server 8767`, and open http://localhost:8767.

## Layout

```
index.html, rounds.json      landing page; one entry per round
engine/                      shared by all rounds
  solver.js                  ODE solver for mass-action compartmental models with time-varying rates (RK4)
  stats.js                   log-gamma, negative-binomial and Dirichlet-multinomial helpers
  charts.js                  SVG time-series charts with hover tooltips
  app.js                     the round page: parameters, tiles, panels, projections, self-check
  style.css                  light and dark themes
<Round>/                     one self-contained folder per round, e.g. Flu2026-27_Round1/
  index.html                 loads the engine and the round's model.js
  round.json                 title, text, panels, tiles and controls for this round
  model.js                   the round's model (the only round-specific code)
  data/                      written by the round's exporter from the Python calibration
    structure.json           compartments and transitions
    inputs.json              dates, locations, populations, scenario inputs, constants
    obs.json                 observed data
    fit.json                 parameter list (labels, transforms, priors), fitted values, 95% ranges
    proj/<location>.json     projection bands and season summaries per scenario
    reference.json           Python solutions the page checks its own solver against
```

Rounds never share data files, so adding a round cannot change an earlier one. Engine changes affect every round,
so check older rounds after changing the engine.

## Adding a round

1. Calibrate the round's model in Python and write its `data/` folder with an exporter (for the flu round:
   `export_web.py` in the calibration code).
2. Write `<Round>/model.js`. It calls `SMH.registerModel({ init, solve, view })`:
   * `init(data) -> ctx`: data holds `structure`, `inputs`, `obs`, `fit` and `round`; precompute what you need.
   * `solve(ctx, i, u, opts) -> res`: location `i`, `u` = shared parameters then this location's parameters
     (unconstrained, as in `fit.json`), `opts` = the round's controls. Use `SMHSolver.solve` with a
     `setCoef(step, c)` callback that fills each transition's rate for that step. Return at least
     `res.perScenario[k]` (series per scenario, including the projections' headline series), `res.nbK`
     (noise dispersion for bands, if any) and `res.secs`.
   * `view(ctx, i, res, k, obs) -> {series, ll}`: the named series the panels in `round.json` refer to, for
     scenario `k`, and the fit-quality numbers shown as tiles.
3. Write `round.json`: the panels to show (`fit`, `groups`, `stack`, `lines`, `line`, `cumulative`,
   `projections`), tiles and controls. A `fit` panel with `"trajectories": true` also draws the projection
   trajectories of the selected scenario. Panels show the whole projection period by default; set
   `"default_view": "calibration"` to start on the calibration window instead. A control with `"draw_offset"`
   keeps each re-solved draw's own offset for that control (data/proj/<location>.json "live").
4. Copy `index.html` from an earlier round, add the round to `rounds.json`, and push.

To take a round off the public site while its results are being redone, set `"hidden": true` (and optionally
`"hidden_message"`) in its `round.json`: visitors see only the notice, while a local copy (localhost) shows the
full page.

On load the page compares its solver with `reference.json` and logs the result to the browser console.
