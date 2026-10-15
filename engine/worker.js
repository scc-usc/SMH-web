/* SMH-web — background solver. Loads the engine and the round's model, then solves parameter vectors on request.
 *   init:  {type: "init", base, model, data}       base = absolute URL of the site root, model = absolute URL of model.js
 *   solve: {type: "solve", id, i, u, opts, key}    -> {id, key, series: res.perScenario[k][key] for every scenario, nbK}
 */
let MODEL = null, CTX = null;
self.SMH = { registerModel: (m) => (MODEL = m) };
self.onmessage = (ev) => {
  const m = ev.data;
  if (m.type === "init") {
    importScripts(m.base + "engine/solver.js", m.base + "engine/stats.js", m.model);
    CTX = MODEL.init(m.data);
    self.postMessage({ type: "ready" });
  } else if (m.type === "solve") {
    try {
      const res = MODEL.solve(CTX, m.i, Float64Array.from(m.u), m.opts);
      self.postMessage({ type: "done", id: m.id, series: res.perScenario.map((r) => r[m.key]), nbK: res.nbK });
    } catch (e) { self.postMessage({ type: "done", id: m.id, error: e.message }); }
  }
};
