/* SMH-web — round-agnostic explorer.
 *
 * A round folder supplies round.json (title, text, panels, tiles, controls), data/*.json (structure, inputs, obs,
 * fit, proj/<location>.json, reference.json) and model.js, which calls SMH.registerModel({init, solve, view}).
 * See README.md for the interface. Everything runs in the browser; changing a parameter re-solves only the
 * selected location.
 */
(function (root) {
  "use strict";
  const { chart, fmt, fmtN, dlabel } = SMHCharts;
  const $ = (s) => document.querySelector(s);
  const css = (v) => getComputedStyle(document.documentElement).getPropertyValue(v).trim();
  const sigm = (x) => 1 / (1 + Math.exp(-x));
  // transforms from unconstrained u to natural units; "range(lo,hi)" = lo + (hi - lo) sigmoid(u)
  const rangeOf = (tr) => { const m = /^range\(([^,]+),([^)]+)\)$/.exec(tr); return m ? [+m[1], +m[2]] : null; };
  const nat = (tr, u) => { const r = rangeOf(tr); if (r) return r[0] + (r[1] - r[0]) * sigm(u);
    return tr === "log" ? Math.exp(u) : tr === "logit" ? sigm(u) : tr === "half_logit" ? 0.5 * sigm(u) : u; };
  const inv = (tr, x) => { const r = rangeOf(tr); if (r) { const z = (x - r[0]) / (r[1] - r[0]); return Math.log(z / (1 - z)); }
    return tr === "log" ? Math.log(x) : tr === "logit" ? Math.log(x / (1 - x)) : tr === "half_logit" ? Math.log((2 * x) / (1 - 2 * x)) : x; };
  const toDisp = (d, x) => (d === "percent" ? x * 100 : d === "duration" ? 1 / x : d === "per100k" ? x * 1e5 : x);
  const fromDisp = (d, y) => (d === "percent" ? y / 100 : d === "duration" ? 1 / y : d === "per100k" ? y / 1e5 : y);
  const PAL = ["--c1", "--c2", "--c3", "--c4", "--c5"];
  const QS = [0.05, 0.25, 0.75, 0.95];

  let MODEL = null;
  const S = { i: 0, k: 0, full: true, u: null, uFit: null, sd: null, res: null, resFit: null, view: null, viewFit: null,
    proj: null, noise: true, pview: "traj", trajCache: {}, ctl: {}, sharedEdit: null, timer: null };
  let R, DATA, CTX;

  function registerModel(m) { MODEL = m; }
  const getJSON = (p) => fetch(p).then((r) => { if (!r.ok) throw new Error(`${p}: ${r.status}`); return r.json(); });

  /* Dark by default; the Theme button's choice is remembered in this browser. */
  function savedTheme() { try { return localStorage.getItem("smh-theme"); } catch (e) { return null; } }
  function saveTheme(t) { try { localStorage.setItem("smh-theme", t); } catch (e) { /* storage unavailable */ } }
  document.documentElement.dataset.theme = savedTheme() || "dark";

  async function start() {
    status("loading", true);
    R = await getJSON("round.json");
    // A round marked "hidden" shows only a notice on the public site; local copies (localhost) show everything.
    const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) || location.protocol === "file:";
    if (R.hidden && !local) {
      document.body.innerHTML = `<div class="landing"><p><a href="../">SMH-web</a></p><h1>${R.title}</h1>
        <p>${R.hidden_message || "Results are being updated. Please come back later."}</p></div>`;
      return;
    }
    const [structure, inputs, obs, fit] = await Promise.all(["structure", "inputs", "obs", "fit"].map((f) => getJSON(`data/${f}.json`)));
    DATA = { structure, inputs, obs, fit, round: R };
    CTX = MODEL.init(DATA);
    document.title = R.title;
    buildLayout();
    S.k = Math.max(0, inputs.scenarios.indexOf(R.default_scenario || inputs.scenarios[0]));
    S.full = (R.default_view || "projection") !== "calibration";       // round.json may set "calibration"
    $("#rangeAll").classList.toggle("on", S.full); $("#rangeFit").classList.toggle("on", !S.full);
    $("#scen").value = S.k;
    for (const c of R.controls || []) S.ctl[c.id] = c.value;
    buildParams();
    await loadLocation();
    selfCheck();
  }

  // ------------------------------------------------------------------ layout
  function buildLayout() {
    const inp = DATA.inputs;
    document.body.innerHTML = `
      <header>
        <a class="home" href="../">SMH-web</a><h1>${R.title}</h1>
        <label>Location <select id="loc">${inp.locations.map((l, i) => `<option value="${i}">${l.abbr} – ${l.name}</option>`).join("")}</select></label>
        <label>Scenario shown in the fit panels <select id="scen">${inp.scenarios.map((s, k) => `<option value="${k}">${inp.scenario_labels ? inp.scenario_labels[k] : s}</option>`).join("")}</select></label>
        <span><button id="rangeAll">Through the projection period</button> <button id="rangeFit">Calibration window only</button></span>
        <span>Uncertainty: <button data-pv="bands">Bands</button> <button data-pv="traj" class="on">Individual trajectories</button></span>
        <label><input type="checkbox" id="noise" checked> include reporting noise</label>
        <button id="resetAll" title="Return every parameter to the fitted value">Reset all to fit</button>
        <button id="theme" title="Toggle light / dark">Theme</button>
        <span class="status" id="status"></span>
      </header>
      <div class="wrap"><aside id="params"></aside>
        <main><p class="about">${R.about || ""}</p><div class="tiles" id="tiles"></div><div class="panels" id="panels"></div>
          <footer id="footer"></footer></main></div>`;
    $("#panels").innerHTML = R.panels.map((p, n) => `<div class="card ${p.full ? "full" : ""}" id="pn${n}"><h3>${p.title}</h3>${p.note ? `<div class="sub">${p.note}</div>` : ""}<div class="legend"></div><div class="body"></div></div>`).join("");
    $("#loc").addEventListener("change", (e) => { S.i = +e.target.value; loadLocation(); });
    $("#scen").addEventListener("change", (e) => { S.k = +e.target.value; render(); });
    $("#rangeFit").addEventListener("click", () => { S.full = false; $("#rangeFit").classList.add("on"); $("#rangeAll").classList.remove("on"); render(); });
    $("#rangeAll").addEventListener("click", () => { S.full = true; $("#rangeAll").classList.add("on"); $("#rangeFit").classList.remove("on"); render(); });
    $("#noise").addEventListener("change", (e) => { S.noise = e.target.checked; render(); });
    document.querySelectorAll("header [data-pv]").forEach((b) => b.addEventListener("click", () => { S.pview = b.dataset.pv;
      document.querySelectorAll("header [data-pv]").forEach((x) => x.classList.toggle("on", x === b)); render(); }));
    $("#resetAll").addEventListener("click", () => { S.u = S.uFit.slice(); S.sharedEdit = null; for (const c of R.controls || []) S.ctl[c.id] = c.value; syncControls(); syncAll(); solve(); });
    $("#theme").addEventListener("click", () => { const r = document.documentElement;
      const dark = r.dataset.theme ? r.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      r.dataset.theme = dark ? "light" : "dark"; saveTheme(r.dataset.theme); render(); });
    let rt; addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(render, 120); });
  }

  function status(t, busy) { const s = $("#status"); if (!s) return; s.textContent = t; s.classList.toggle("busy", !!busy); s.classList.toggle("err", String(t).startsWith("error")); }

  // ------------------------------------------------------------------ parameters
  function buildParams() {
    const f = DATA.fit;
    const grp = (title, note, specs, base) => {
      let h = `<div class="group"><h2>${title}</h2><p>${note}</p>`;
      for (const p of specs) {
        h += `<div class="param" title="${p.desc}"><div class="ph"><span class="pl">${p.label}</span><span class="pu">${p.unit}</span></div>${p.desc ? `<div class="pd">${p.desc}</div>` : ""}`;
        for (let e = 0; e < p.n; e++)
          h += `<div class="row" data-idx="${base + p.offset + e}" data-tr="${p.transform}" data-disp="${p.display}" data-pm="${p.prior_m[e]}" data-ps="${p.prior_sd[e]}">`
            + `<span class="el">${p.elems ? p.elems[e] : ""}</span><input type="range"><input type="number" step="any"><button class="rs" title="Reset to fitted value">↺</button><span></span><span class="ci"></span></div>`;
        h += `</div>`;
      }
      return h + `</div>`;
    };
    $("#params").innerHTML = grp("This location", "Fitted for the selected location only.", f.local, f.ns)
      + grp("Shared by all locations", "Changing these re-solves only the selected location; the others would change too.", f.shared, 0)
      + `<div class="group"><p>${f.method || ""}</p></div>`;
    document.querySelectorAll(".row").forEach((row) => {
      const idx = +row.dataset.idx, tr = row.dataset.tr, disp = row.dataset.disp, sl = row.children[1], num = row.children[2];
      sl.addEventListener("input", () => { S.u[idx] = +sl.value; syncRow(row, false); changed(idx); });
      num.addEventListener("change", () => { const y = parseFloat(num.value); const u = inv(tr, fromDisp(disp, y));
        if (!isFinite(u)) return syncRow(row); S.u[idx] = u; syncRow(row); changed(idx); });
      row.children[3].addEventListener("click", () => { S.u[idx] = S.uFit[idx]; syncRow(row); changed(idx); });
    });
  }
  function syncRow(row, moveSlider = true) {
    const idx = +row.dataset.idx, tr = row.dataset.tr, disp = row.dataset.disp, pm = +row.dataset.pm, ps = +row.dataset.ps;
    const sl = row.children[1], num = row.children[2], uf = S.uFit[idx], u = S.u[idx];
    const lo = Math.min(pm - 3 * ps, uf - 0.5, u), hi = Math.max(pm + 3 * ps, uf + 0.5, u);
    sl.min = lo; sl.max = hi; sl.step = (hi - lo) / 500; if (moveSlider) sl.value = u;
    num.value = fmt(toDisp(disp, nat(tr, u))).replace(/,/g, "");
    row.classList.toggle("changed", Math.abs(u - uf) > 1e-9);
    const ci = row.querySelector(".ci");
    if (S.sd) { const s = S.sd[idx], a = toDisp(disp, nat(tr, uf - 1.96 * s)), b = toDisp(disp, nat(tr, uf + 1.96 * s));
      ci.textContent = `fit ${fmt(toDisp(disp, nat(tr, uf)))}, 95% range ${fmt(Math.min(a, b))} – ${fmt(Math.max(a, b))}`; }
  }
  function syncAll() { document.querySelectorAll(".row").forEach((r) => syncRow(r)); }
  function changed(idx) { if (idx < DATA.fit.ns) S.sharedEdit = S.u.slice(0, DATA.fit.ns); schedule(); }
  function schedule() { clearTimeout(S.timer); S.timer = setTimeout(solve, 60); }

  // ------------------------------------------------------------------ solving
  function uFor(i) { const f = DATA.fit; return [...f.u_shared, ...f.u_local[i]]; }
  function sdFor(i) { const f = DATA.fit; return f.sd_shared ? [...f.sd_shared, ...f.sd_local[i]] : null; }
  function run(u) { return MODEL.solve(CTX, S.i, Float64Array.from(u), { ...S.ctl }); }

  async function loadLocation() {
    status("solving", true);
    await new Promise((r) => setTimeout(r, 0));
    S.uFit = uFor(S.i); S.u = S.uFit.slice(); S.sd = sdFor(S.i);
    const defaults = {}; for (const c of R.controls || []) defaults[c.id] = c.value;
    S.resFit = MODEL.solve(CTX, S.i, Float64Array.from(S.uFit), defaults);
    const edited = S.sharedEdit && S.sharedEdit.some((v, k) => Math.abs(v - S.uFit[k]) > 1e-12);
    if (edited) S.sharedEdit.forEach((v, k) => (S.u[k] = v));
    const ctlChanged = (R.controls || []).some((c) => S.ctl[c.id] !== c.value);
    S.res = edited || ctlChanged ? run(S.u) : S.resFit;
    syncAll();
    S.proj = null; S.live = null; S.trajCache = {}; render(); loadProj();
    status(`${DATA.inputs.locations[S.i].abbr}: solved in ${S.res.secs.toFixed(2)} s`);
  }
  function solve() {
    status("solving", true);
    setTimeout(() => {
      try { S.res = run(S.u); render(); status(`${DATA.inputs.locations[S.i].abbr}: solved in ${S.res.secs.toFixed(2)} s`); scheduleLive(); }
      catch (e) { status("error: " + e.message); console.error(e); }
    }, 0);
  }
  async function loadProj() {
    const ab = DATA.inputs.locations[S.i].abbr;
    try { S.proj = await getJSON(`data/proj/${ab}.json`); } catch (e) { S.proj = null; }
    if (DATA.inputs.locations[S.i].abbr === ab) { render(); if (isEdited()) scheduleLive(); }
  }

  // ------------------------------------------------------------------ rendering
  function range() { const inp = DATA.inputs; return { i0: 0, i1: S.full ? inp.n_weeks - 1 : inp.fit_weeks - 1 }; }
  function colors(n) { return Array.from({ length: n }, (_, k) => css(PAL[k % PAL.length])); }
  const col = (A, j) => A.map((r) => (r == null ? null : r[j]));
  function nbBand(mu, k) {
    const q = [[], [], [], []];
    mu.forEach((m) => { const v = m == null ? [null, null, null, null] : SMHStats.nbQuantiles(m, k, QS); v.forEach((x, j) => q[j].push(x)); });
    return q;
  }
  function legend(el, items) {
    el.innerHTML = items.map((it) => `<span><i class="${it.kind || ""}" style="background:${it.color}"></i>${it.label}</span>`).join("");
  }

  function render() {
    if (!S.res) return;
    S.view = MODEL.view(CTX, S.i, S.res, S.k, DATA.obs);
    S.viewFit = MODEL.view(CTX, S.i, S.resFit, S.k, DATA.obs);
    tiles();
    const inp = DATA.inputs, dates = inp.dates, { i0, i1 } = range(), sv = S.view.series;
    const model = css("--model"), data = css("--data");
    const marker = inp.fit_weeks - 1;
    R.panels.forEach((p, n) => {
      const card = $(`#pn${n}`), body = card.querySelector(".body"), lg = card.querySelector(".legend");
      const has = p.type === "projections" || sv[p.key] != null;
      card.style.display = has ? "" : "none";
      if (!has) return;
      const labels = p.labels ? inp[p.labels] : null;
      const base = { dates, i0, i1, marker, height: p.height };
      if (p.type === "fit") {
        const mu = sv[p.key], ob = sv[p.data], b = nbBand(mu, S.res.nbK);
        const tr = p.trajectories && S.pview === "traj" && S.proj && S.proj.traj ? trajectories(S.proj, inp.n_weeks)[S.k] : null;
        const until = tr ? S.proj.traj.start : null;
        legend(lg, [{ label: tr ? "model, current values" : "model", color: model },
          { label: tr ? "noise band 50% / 90% (calibration)" : "noise band 50% / 90%", color: `rgba(${css("--band")},.5)`, kind: "area" }]
          .concat(tr ? [{ label: `${S.live && S.live.i === S.i ? S.live.series.length + " trajectories re-solved for your changes" : S.proj.draws + " trajectories"}, scenario ${inp.scenarios[S.k]}${S.noise ? ", with reporting noise" : ""}`, color: model }] : [])
          .concat([{ label: p.data_label || "data", color: data, kind: "dot" }]));
        const top = tr ? Math.max(...tr.map((y) => Math.max(...y.slice(i0, i1 + 1).map((v) => v || 0))), ...mu.slice(i0, i1 + 1)) : null;
        chart(body, { ...base, height: p.height || 230, ymax: top, series: (tr ? [{ type: "paths", ys: tr, color: model, alpha: 0.18, width: 0.9 }] : [])
          .concat([{ type: "band", lo: b[0], hi: b[3], alpha: 0.16, until }, { type: "band", lo: b[1], hi: b[2], alpha: 0.32, until },
          { type: "line", y: mu, color: model }, { type: "dots", y: ob, color: data, r: 2.6 }]),
          tip: [{ name: "model", y: mu, color: model, f: fmtN }, { name: "90% band", y: b[0].map((v, w) => [v, b[3][w]]), color: "transparent", f: (v) => (v ? `${fmtN(v[0])} – ${fmtN(v[1])}` : "–") },
            { name: p.data_label || "data", y: ob, color: data, f: fmtN }] });
      } else if (p.type === "groups") {
        legend(lg, [{ label: "model", color: model }, { label: "noise band 50% / 90%", color: `rgba(${css("--band")},.5)`, kind: "area" }, { label: p.data_label || "data", color: data, kind: "dot" }]);
        if (!body.classList.contains("multi")) { body.classList.add("multi"); body.innerHTML = labels.map((l) => `<div><div class="sub">${l}</div><div></div></div>`).join(""); }
        labels.forEach((l, g) => { const mu = col(sv[p.key], g), ob = sv[p.data] ? col(sv[p.data], g) : null, b = nbBand(mu, S.res.nbK);
          chart(body.children[g].lastChild, { ...base, height: p.height || 140, series: [{ type: "band", lo: b[0], hi: b[3], alpha: 0.16 }, { type: "band", lo: b[1], hi: b[2], alpha: 0.32 },
            { type: "line", y: mu, color: model, width: 1.5 }].concat(ob ? [{ type: "dots", y: ob, color: data, r: 2 }] : []),
            tip: [{ name: "model", y: mu, color: model, f: fmtN }].concat(ob ? [{ name: "data", y: ob, color: data, f: fmtN }] : []) }); });
      } else if (p.type === "stack") {
        const cs = colors(labels.length), ys = labels.map((_, g) => col(sv[p.key], g)), ob = p.data ? sv[p.data] : null;
        legend(lg, labels.map((l, g) => ({ label: l, color: cs[g], kind: "area" })).concat(ob ? [{ label: p.data_label || "data", color: data, kind: "dot" }] : []));
        chart(body, { ...base, height: p.height || 190, series: [{ type: "stack", ys, colors: cs }].concat(ob ? [{ type: "dots", y: ob, color: data, r: 2.3 }] : []),
          tip: ys.map((y, g) => ({ name: labels[g], y, color: cs[g], f: fmtN })).concat(ob ? [{ name: "data", y: ob, color: data, f: fmtN }] : []) });
      } else if (p.type === "lines") {
        const cs = colors(labels.length), ys = labels.map((_, g) => col(sv[p.key], g)), ob = p.data && sv[p.data] ? labels.map((_, g) => col(sv[p.data], g)) : null;
        const f = p.percent ? (v) => (v == null ? "–" : (v * 100).toFixed(0) + "%") : (v) => fmt(v) + (p.unit || "");
        legend(lg, labels.map((l, g) => ({ label: l, color: cs[g] })).concat(ob ? [{ label: p.data_label || "data", color: css("--muted"), kind: "dot" }] : []));
        chart(body, { ...base, height: p.height || 180, ymax: p.ymax, yfmt: p.percent ? (v) => (v * 100).toFixed(0) + "%" : null,
          series: ys.map((y, g) => ({ type: "line", y, color: cs[g] })).concat(ob ? ob.map((y, g) => ({ type: "dots", y, color: cs[g], hollow: true })) : []),
          tip: ys.map((y, g) => ({ name: labels[g] + (ob ? " model" : ""), y, color: cs[g], f })).concat(ob ? ob.map((y, g) => ({ name: labels[g] + " data", y, color: cs[g], f })) : []) });
      } else if (p.type === "line") {
        legend(lg, [{ label: p.label || "model", color: model }]);
        chart(body, { ...base, height: p.height || 170, autoMin: p.autoMin, hline: p.hline, series: [{ type: "line", y: sv[p.key], color: model }],
          tip: [{ name: p.label || "value", y: sv[p.key], color: model, f: (v) => (v == null ? "–" : v.toFixed(3)) }] });
      } else if (p.type === "cumulative") {
        const rg = sv[p.range];
        legend(lg, [{ label: "model", color: model }, { label: p.range_label || "reference range", color: data }]);
        chart(body, { ...base, i1: S.full ? inp.n_weeks - 1 : Math.max(i1, rg.x), height: p.height || 170, ymax: rg.hi,
          series: [{ type: "line", y: sv[p.key], color: model }, { type: "range", x: rg.x, lo: rg.lo, hi: rg.hi }], tip: [{ name: "model", y: sv[p.key], color: model }] });
      }
    });
    renderProj();
  }

  function tiles() {
    const ll = S.view.ll, llf = S.viewFit.ll, inp = DATA.inputs;
    const dl = (a, b) => { if (b == null) return ""; const d = a - b;
      if (Math.abs(d) < 0.05) return `<span class="delta">same as fit</span>`;
      return `<span class="delta ${d > 0 ? "up" : "down"}">${d > 0 ? "+" : ""}${d.toFixed(1)} vs fit</span>`; };
    let h = "";
    for (const [name, v] of Object.entries(ll)) h += `<div class="tile"><div class="k">${name}</div><div class="v">${v.toFixed(1)}</div><div class="s">${dl(v, llf[name])}</div></div>`;
    let lp = 0, lpf = 0;
    const pr = [...DATA.fit.shared.map((s) => [s, 0]), ...DATA.fit.local.map((s) => [s, DATA.fit.ns])];
    for (const [s, off] of pr) for (let e = 0; e < s.n; e++) { const i = off + s.offset + e;
      lp += -0.5 * ((S.u[i] - s.prior_m[e]) / s.prior_sd[e]) ** 2; lpf += -0.5 * ((S.uFit[i] - s.prior_m[e]) / s.prior_sd[e]) ** 2; }
    h += `<div class="tile"><div class="k">Prior (shared + this location)</div><div class="v">${lp.toFixed(1)}</div><div class="s">${dl(lp, lpf)}</div></div>`;
    for (const t of R.tiles || []) {
      const mu = S.view.series[t.key], ob = t.data ? S.view.series[t.data] : null;
      const a = t.from === "proj_first" ? inp.proj_first : t.from || 0, b = t.to === "proj_first" ? inp.proj_first : t.to === "fit_weeks" ? inp.fit_weeks : inp.n_weeks;
      const am = (arr) => { let bi = -1, bv = -Infinity; for (let w = a; w < b; w++) if (arr[w] != null && arr[w] > bv) { bv = arr[w]; bi = w; } return [bi, bv]; };
      const [mi, mv] = am(mu);
      if (ob) { const [oi, ov] = am(ob.map((v, w) => (w < inp.fit_weeks ? v : null)));
        h += `<div class="tile"><div class="k">${t.label}</div><div class="v">${fmtN(mv)} / ${fmtN(ov)}</div><div class="s">${dlabel(inp.dates[mi])} / ${oi >= 0 ? dlabel(inp.dates[oi]) : "–"}</div></div>`; }
      else h += `<div class="tile"><div class="k">${t.label.replace("{scenario}", inp.scenarios[S.k])}</div><div class="v">${fmtN(mv)}</div><div class="s">week ending ${dlabel(inp.dates[mi])}</div></div>`;
    }
    $("#tiles").innerHTML = h;
  }

  // ------------------------------------------------------------------ projections
  function renderProj() {
    const n = R.panels.findIndex((p) => p.type === "projections");
    if (n < 0 || !S.res) return;
    const p = R.panels[n], card = $(`#pn${n}`), body = card.querySelector(".body");
    const inp = DATA.inputs, SC = inp.scenarios, cs = colors(SC.length), data = css("--data");
    const P = S.proj, have = !!P, QT = have ? P[S.noise ? "noise" : "expected"] : null;
    const live = have && S.live && S.live.i === S.i;
    const trajAll = have && (live || (S.pview === "traj" && P.traj)) ? trajectories(P, inp.n_weeks) : null;
    const Q = live ? { hosp: quantOf(trajAll, inp.n_weeks) } : QT;
    const i0 = Math.max(0, inp.fit_weeks - 10), i1 = inp.n_weeks - 1;
    const pts = S.res.perScenario.map((r) => r[p.headline]);
    const ob = S.view.series[p.data];
    if (!body.dataset.built) {
      body.dataset.built = "1";
      body.innerHTML = `<div class="sub pdesc"></div><div class="ctl">
        ${(R.controls || []).map((c) => `<label title="${c.title || ""}">${c.label} <input type="range" data-ctl="${c.id}" min="${c.min}" max="${c.max}" step="${c.step}"> <b data-ctlv="${c.id}"></b></label>`).join("")}</div>
        <div class="pover"></div><div class="tablewrap"><table class="sum"></table></div><div class="multi pmult"></div>`;
      body.querySelectorAll("[data-ctl]").forEach((el) => el.addEventListener("input", () => { S.ctl[el.dataset.ctl] = +el.value; syncControls(); schedule(); }));
      syncControls();
    }
    legend(card.querySelector(".legend"), SC.map((s, k) => ({ label: inp.scenario_labels ? inp.scenario_labels[k] : s, color: cs[k] }))
      .concat([{ label: "dashed: current parameter values", color: css("--muted") }, { label: p.data_label || "data", color: data, kind: "dot" }]
        .concat(S.pview === "traj" ? [{ label: "shaded: 90% band at each week (trajectories peak in different weeks, so they rise above it)", color: css("--muted"), kind: "area" }] : [])));
    body.querySelector(".pdesc").textContent = have ? (R.projection_note || "").replace("{draws}", P.draws)
      .replace("{shift}", `median ${P.hol_shift[1].toFixed(0)} days, 5–95% ${P.hol_shift[0].toFixed(0)} to ${P.hol_shift[2].toFixed(0)}`)
      + (live ? " The table's ranges are still at the fitted values." : "")
      : "No precomputed draws for this location; dashed lines only.";
    const ser = (qi, k) => Q.hosp[qi][k];
    const traj = S.pview === "traj" ? trajAll : null;
    const series = traj ? SC.map((s, k) => ({ type: "band", lo: ser(0, k), hi: ser(4, k), alpha: 0.10, color: cs[k] }))
      .concat(SC.map((s, k) => ({ type: "paths", ys: traj[k], color: cs[k], alpha: 0.12, width: 0.9 }))) : [], tip = [];
    SC.forEach((s, k) => {
      if (have) { series.push({ type: "line", y: ser(2, k), color: cs[k], width: 1.8 }); tip.push({ name: s + " median", y: ser(2, k), color: cs[k], f: fmtN }); }
      series.push({ type: "line", y: pts[k], color: cs[k], width: 1.3, dash: "4 3" }); tip.push({ name: s + " current", y: pts[k], color: cs[k], f: fmtN });
    });
    series.push({ type: "dots", y: ob, color: data, r: 2.4 }); tip.push({ name: "data", y: ob, color: data, f: fmtN });
    const dates = inp.dates;
    const topAll = traj ? Math.max(...traj.flat().map((y) => Math.max(...y.slice(i0).map((v) => v || 0)))) : null;
    chart(body.querySelector(".pover"), { dates, i0, i1, marker: inp.fit_weeks - 1, height: traj ? 300 : 230, ymax: topAll, series, tip });
    const box = body.querySelector(".pmult");
    if (box.children.length !== SC.length) box.innerHTML = SC.map((s, k) => `<div><div class="sub">${inp.scenario_labels ? inp.scenario_labels[k] : s}</div><div></div></div>`).join("");
    const top = traj ? Math.max(...traj.flat().map((y) => Math.max(...y.slice(i0).map((v) => v || 0))))
      : have ? Math.max(...Q.hosp[4].map((v) => Math.max(...v.slice(i0)))) : null;
    SC.forEach((s, k) => {
      const ss = !have ? [] : traj ? [{ type: "band", lo: ser(0, k), hi: ser(4, k), alpha: 0.18, color: cs[k] }, { type: "band", lo: ser(1, k), hi: ser(3, k), alpha: 0.28, color: cs[k] },
        { type: "paths", ys: traj[k], color: cs[k], alpha: 0.25, width: 0.9 }, { type: "line", y: ser(2, k), color: cs[k], width: 1.8 }]
        : [{ type: "band", lo: ser(0, k), hi: ser(4, k), alpha: 0.16, color: cs[k] }, { type: "band", lo: ser(1, k), hi: ser(3, k), alpha: 0.32, color: cs[k] },
        { type: "line", y: ser(2, k), color: cs[k], width: 1.6 }];
      ss.push({ type: "line", y: pts[k], color: cs[k], width: 1.2, dash: "4 3" }, { type: "dots", y: ob, color: data, r: 2 });
      const tp = have ? [{ name: "90% range", y: ser(0, k).map((v, w) => [v, ser(4, k)[w]]), color: "transparent", f: (v) => (v ? `${fmtN(v[0])} – ${fmtN(v[1])}` : "–") },
        { name: "median", y: ser(2, k), color: cs[k], f: fmtN }] : [];
      tp.push({ name: "current", y: pts[k], color: cs[k], f: fmtN });
      chart(box.children[k].lastChild, { dates, i0, i1, marker: inp.fit_weeks - 1, height: 150, ymax: top, series: ss, tip: tp });
    });
    const w0 = inp.proj_first, sum = (a) => a.slice(w0).reduce((x, y) => x + y, 0);
    const rng = (q) => `${fmtN(q[1])} <small>(${fmtN(q[0])}–${fmtN(q[2])})</small>`;
    const last = SC[SC.length - 1];
    let h = `<tr><th>Scenario</th><th>${p.total_label || "Total"}</th><th>Averted vs ${last}</th><th>Deaths</th><th>Deaths averted vs ${last}</th><th>Peak week</th><th>${p.total_label || "Total"}, current values</th></tr>`;
    SC.forEach((s, k) => {
      const sm = have ? QT.summary[k] : null;
      h += `<tr><td><span style="display:inline-block;width:9px;height:9px;border-radius:2px;margin-right:6px;background:${cs[k]}"></span>${s}</td>`
        + (sm ? `<td>${rng(sm.admissions)}</td><td>${k === SC.length - 1 ? "–" : rng(sm.averted)}</td><td>${rng(sm.deaths)}</td><td>${k === SC.length - 1 ? "–" : rng(sm.deaths_averted)}</td>`
          + `<td>${dlabel(dates[sm.peak_week[1]])} <small>(${dlabel(dates[sm.peak_week[0]])} – ${dlabel(dates[sm.peak_week[2]])})</small></td>` : `<td>–</td><td>–</td><td>–</td><td>–</td><td>–</td>`)
        + `<td>${fmtN(sum(pts[k]))}</td></tr>`;
    });
    body.querySelector("table.sum").innerHTML = h;
  }
  /* Individual trajectories per scenario as full-length week arrays; reporting noise is sampled once per location
   * (seeded, so redraws agree) from each draw's own negative-binomial dispersion. */
  function trajectories(P, N) {
    if (S.live && S.live.i === S.i) {
      const key = `live|${S.live.gen}|${S.noise}`;
      if (S.trajCache[key]) return S.trajCache[key];
      const K = DATA.inputs.scenarios.length, u = SMHStats.rng(12345), start = P.traj ? P.traj.start : 0;
      const out = Array.from({ length: K }, (_, k) => S.live.series.map((ser, d) =>
        ser[k].map((v, w) => (w < start ? null : S.noise ? SMHStats.nbSample(v, S.live.nbK[d], u) : v))));
      S.trajCache = { [key]: out };
      return out;
    }
    const key = `${DATA.inputs.locations[S.i].abbr}|${S.noise}`;
    if (S.trajCache[key]) return S.trajCache[key];
    const T = P.traj, K = DATA.inputs.scenarios.length, u = SMHStats.rng(12345);
    const out = Array.from({ length: K }, () => []);
    T.hosp.forEach((draw, d) => draw.forEach((ys, k) => {
      const a = new Array(N).fill(null);
      ys.forEach((v, w) => (a[T.start + w] = S.noise ? SMHStats.nbSample(v, T.nb_k[d], u) : v));
      out[k].push(a);
    }));
    S.trajCache = { [key]: out };
    return out;
  }

  // ------------------------------------------------------------------ live trajectories (re-solved after edits)
  /* When parameters or controls differ from the fit, a subset of the paired draws (data/proj/<loc>.json "live") is
   * re-solved around the edited values: each draw keeps its offset from the fitted point, and controls with a
   * "draw_offset" keep each draw's own offset (e.g. its pre-holiday timing). Solves run on background workers. */
  const POOL = { workers: null };
  function pool() {
    if (POOL.workers) return POOL.workers;
    const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
    const base = new URL("../", location.href).href, model = new URL("model.js", location.href).href;
    const data = { structure: DATA.structure, inputs: DATA.inputs, fit: DATA.fit, round: R };
    POOL.workers = Promise.all(Array.from({ length: n }, () => new Promise((res, rej) => {
      const w = new Worker(base + "engine/worker.js");
      w.onmessage = (ev) => { if (ev.data.type === "ready") res(w); };
      w.onerror = (e) => rej(new Error(e.message || "worker failed"));
      w.postMessage({ type: "init", base, model, data });
    })));
    return POOL.workers;
  }
  async function runMany(tasks) {
    const ws = await pool();
    return new Promise((resolve) => {
      const out = new Array(tasks.length); let next = 0, done = 0;
      const feed = (w) => {
        if (next >= tasks.length) return;
        const id = next++;
        w.onmessage = (ev) => { if (ev.data.type !== "done") return; out[id] = ev.data; if (++done === tasks.length) resolve(out); else feed(w); };
        w.postMessage({ type: "solve", id, ...tasks[id] });
      };
      ws.forEach(feed);
    });
  }
  function isEdited() {
    return S.u.some((v, q) => Math.abs(v - S.uFit[q]) > 1e-12) || (R.controls || []).some((c) => S.ctl[c.id] !== c.value);
  }
  const LIVE = { timer: null, busy: false, pending: false, gen: 0 };
  function scheduleLive() { clearTimeout(LIVE.timer); LIVE.timer = setTimeout(refreshLive, 250); }
  async function refreshLive() {
    if (LIVE.busy) { LIVE.pending = true; return; }
    const P = S.proj;
    if (!P || !P.live || !isEdited()) { if (S.live) { S.live = null; S.trajCache = {}; render(); } return; }
    LIVE.busy = true;
    const i = S.i, u0 = S.u.slice(), uf = S.uFit, ctl = { ...S.ctl }, ab = DATA.inputs.locations[i].abbr;
    const pp = R.panels.find((x) => x.type === "projections"), key = pp ? pp.headline : "admAll";
    const tasks = P.live.u.map((ud, d) => {
      const opts = { ...ctl };
      for (const c of R.controls || []) if (c.draw_offset && P.live[c.draw_offset]) opts[c.id] = ctl[c.id] + P.live[c.draw_offset][d];
      return { i, u: u0.map((v, q) => v + (ud[q] - uf[q])), opts, key };
    });
    status(`${ab}: updating ${tasks.length} trajectories`, true);
    const t0 = performance.now();
    try {
      const res = await runMany(tasks);
      if (i === S.i && !LIVE.pending) {
        S.live = { i, gen: ++LIVE.gen, series: res.map((r) => r.series), nbK: res.map((r) => r.nbK) };
        S.trajCache = {}; render();
        status(`${ab}: ${tasks.length} trajectories re-solved in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
      }
    } catch (e) { status("error: " + e.message); console.error(e); }
    LIVE.busy = false;
    if (LIVE.pending) { LIVE.pending = false; refreshLive(); }
  }
  function quantOf(traj, N) {
    const qs = [0.05, 0.25, 0.5, 0.75, 0.95];
    const out = qs.map(() => traj.map(() => new Array(N).fill(null)));
    traj.forEach((draws, k) => {
      for (let w = 0; w < N; w++) {
        const v = draws.map((a) => a[w]).filter((x) => x != null).sort((a, b) => a - b);
        if (!v.length) continue;
        qs.forEach((q, qi) => { const h = q * (v.length - 1), lo = Math.floor(h); out[qi][k][w] = v[lo] + (h - lo) * (v[Math.min(lo + 1, v.length - 1)] - v[lo]); });
      }
    });
    return out;
  }

  function syncControls() {
    for (const c of R.controls || []) {
      const el = document.querySelector(`[data-ctl="${c.id}"]`), v = document.querySelector(`[data-ctlv="${c.id}"]`);
      if (el) el.value = S.ctl[c.id];
      if (v) v.textContent = `${S.ctl[c.id] > 0 ? "+" : ""}${S.ctl[c.id]} ${c.unit || ""}`;
    }
  }

  // ------------------------------------------------------------------ self-check against the Python reference
  // For whoever maintains the round: the result goes to the browser console only, not the page.
  async function selfCheck() {
    $("#footer").innerHTML = R.footer || "";
    try {
      const ref = await getJSON("data/reference.json");
      let worst = 0;
      for (const rf of Object.values(ref)) {
        const res = MODEL.solve(CTX, rf.i, Float64Array.from(uFor(rf.i)), Object.fromEntries((R.controls || []).map((c) => [c.id, c.value])));
        res.perScenario.forEach((r, k) => r.admAll.forEach((v, w) => { const a = rf.adm[k][w]; worst = Math.max(worst, Math.abs(v - a) / Math.max(Math.abs(a), 1)); }));
      }
      const msg = `SMH-web: browser solver vs Python reference, largest relative difference ${worst.toExponential(1)} over ${Object.keys(ref).length} locations`;
      if (worst < 1e-4) console.info(msg); else console.error(msg + " (MISMATCH)");
    } catch (e) { console.warn("SMH-web: reference check unavailable:", e.message); }
  }

  root.SMH = { registerModel, start, nat };
})(typeof self !== "undefined" ? self : this);
