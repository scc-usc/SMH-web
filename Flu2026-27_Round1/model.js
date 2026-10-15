/* Flu Scenario Modeling Hub, Round 1 2026-27: three-strain (H1, H3, B), five-age model.
 *
 * Port of the Python model used for calibration (flu-hyperode/model.py). Per location, all compartments are
 * fractions of their age group:
 *   per age a and strain j: S -> I (infection), I -> R (recovery), R -> S (waning immunity), S -> V (vaccination),
 *   V -> S (vaccine waning); leaky vaccine (susceptibility 1 - VE_inf);
 *   cross-protection between the A subtypes: infection with one moves people, vaccinated (V -> Q) or not (S -> P),
 *   into partial protection against the other (strength c), which wanes (P -> S, Q -> V); P -> Q by vaccination,
 *   Q -> P as vaccine protection wanes;
 *   hospital pipeline: infection -> Y -> admitted (Hc) and Z -> died (Dc); Inc / Hinc count infections and
 *   hospitalizations per strain.
 * Seasonality: contacts C(t) = home + school x open(t) + (work + others x (1 + (m - 1) hol(t))) x (1 + (k - 1) winter(t)),
 * optionally times a climate term. Vaccination follows scenario B through the calibration window for every scenario.
 *
 * Interface (see README): init(data) -> ctx; solve(ctx, i, u, opts) -> result.
 */
(function () {
  "use strict";
  const K_INF = 0, K_CROSS = 1, K_RECOV = 2, K_WANE_R = 3, K_VACC = 4, K_WANE_V = 5, K_WANE_P = 6, K_ADM = 7, K_ADM_Z = 8, K_DEATH = 9;
  const ROLE_Y = 2, ROLE_INC = 3, ROLE_HINC = 4;
  const CLS_V = 1, CLS_Q = 3;
  const NA = 5, NJ = 3;
  const sigm = (x) => 1 / (1 + Math.exp(-x));
  const TF = { log: Math.exp, logit: sigm, half_logit: (x) => 0.5 * sigm(x), id: (x) => x };

  function dayOf(t0, y, m, d) { return (Date.UTC(y, m - 1, d) - t0) / 86400000; }

  /* School open, pre-holiday mixing window, winter break at model times (weeks since t0), logistic edges. */
  function calendar(ctx, holShift) {
    const C = ctx.consts, t0 = ctx.t0, edge = C.CAL_EDGE_DAYS, T = ctx.T;
    const open = new Float64Array(T), hol = new Float64Array(T), win = new Float64Array(T);
    const w = (day, a, b) => 1 / (1 + Math.exp(-(day - a) / edge)) / (1 + Math.exp((day - b) / edge));
    for (let s = 0; s < T; s++) {
      const day = ((s + 0.5) / ctx.spw) * 7;
      let wi = 0, su = 0, ho = 0;
      for (let y = 2023; y < 2030; y++) {
        wi += w(day, dayOf(t0, y, ...C.WINTER_BREAK[0]), dayOf(t0, y + 1, ...C.WINTER_BREAK[1]));
        su += w(day, dayOf(t0, y, ...C.SUMMER_BREAK[0]), dayOf(t0, y, ...C.SUMMER_BREAK[1]));
        const sh = y >= 2026 ? holShift : 0;
        ho += w(day, dayOf(t0, y, ...C.HOLIDAY_MIX[0]) + sh, dayOf(t0, y, ...C.HOLIDAY_MIX[1]) + sh);
      }
      open[s] = Math.min(1, Math.max(0, 1 - wi - su)); hol[s] = Math.min(1, Math.max(0, ho)); win[s] = Math.min(1, Math.max(0, wi));
    }
    return { open, hol, win };
  }

  function init(data) {
    const st = data.structure, inp = data.inputs, fit = data.fit;
    const sys = SMHSolver.compile(st);
    const ix = {}; st.states.forEach((s, i) => (ix[s] = i));
    const t0 = Date.UTC(...inp.t0.split("-").map((v, k) => (k === 1 ? +v - 1 : +v)));
    const flat = (M) => Float64Array.from(M.flat());
    const ctx = {
      st, inp, fit, sys, ix, t0, consts: inp.consts, spw: inp.steps_per_week, N: inp.n_weeks, T: inp.n_weeks * inp.steps_per_week,
      W: inp.fit_weeks, Cs: { home: flat(inp.contacts.home), school: flat(inp.contacts.school), work: flat(inp.contacts.work), others: flat(inp.contacts.others) },
      cal: {}, ns: fit.ns, nl: fit.nl,
    };
    ctx.infl = []; ctx.vaccE = []; ctx.statE = [];
    for (let e = 0; e < st.tgt.length; e++) {
      const k = st.kind[e];
      if (k === K_INF || k === K_CROSS) ctx.infl.push(e); else if (k === K_VACC) ctx.vaccE.push(e); else ctx.statE.push(e);
    }
    ctx.inflAB = Int32Array.from(ctx.infl.map((e) => st.a[e] * NA + st.b[e]));
    ctx.vaccA = Int32Array.from(ctx.vaccE.map((e) => st.a[e]));
    ctx.idx = (pre, ...k) => ix[pre + k.join("")];
    return ctx;
  }

  function unpack(ctx, u) {
    const p = {};
    for (const s of ctx.fit.shared) p[s.name] = Array.from({ length: s.n }, (_, e) => TF[s.transform](u[s.offset + e]));
    for (const s of ctx.fit.local) p[s.name] = Array.from({ length: s.n }, (_, e) => TF[s.transform](u[ctx.ns + s.offset + e]));
    return p;
  }

  function solve(ctx, i, u, opts = {}) {
    const t_start = performance.now();
    const { st, inp, sys, consts: C, N, T, spw } = ctx;
    const holShift = opts.holShift || 0;
    const key = "s" + holShift;
    if (!ctx.cal[key]) ctx.cal[key] = calendar(ctx, holShift);
    const cal = ctx.cal[key];
    const p = unpack(ctx, u);
    const pop = inp.pop[i], popT = pop.reduce((a, b) => a + b, 0), frac = pop.map((v) => v / popT);
    // per-edge base coefficients
    const beta = p.r0.map((r) => (r * C.GAMMA) / inp.rho_C);
    const ve = p.ve_inf[0], hospCond = C.VE_HOSP / (1 - ve), cc = p.cross_c[0];
    const susc = [1, 1 - ve, 1 - cc, (1 - ve) * (1 - cc)];
    const h1 = p.ihr_age;
    const ihr = (a, j) => j === 0 ? h1[a] : j === 1 ? h1[a] * (a === 4 ? p.sev_h3_old[0] : p.sev_h3_young[0])
      : h1[a] * (a < 2 ? p.sev_b_child[0] : p.sev_b_adult[0]);
    const E = st.tgt.length, base = new Float64Array(E);
    for (let e = 0; e < E; e++) {
      const k = st.kind[e], a = Math.max(st.a[e], 0), j = Math.max(st.j[e], 0), cls = Math.max(st.cls[e], 0), role = st.role[e];
      let v;
      if (k === K_INF) {
        let rf = 1;
        if (role === ROLE_Y || role === ROLE_HINC) rf = ihr(a, j) * (cls === CLS_V || cls === CLS_Q ? hospCond : 1);
        v = beta[j] * susc[cls] * rf;
        if (role === ROLE_INC || role === ROLE_HINC) v *= frac[a];
      } else if (k === K_CROSS) v = beta[j];
      else if (k === K_RECOV) v = C.GAMMA;
      else if (k === K_WANE_R) v = p.omega_r[0];
      else if (k === K_WANE_V) v = p.omega_v[0];
      else if (k === K_WANE_P) v = p.omega_c[0];
      else if (k === K_ADM) v = C.DELTA;
      else if (k === K_ADM_Z) v = C.DELTA * p.hfr[0] * C.HFR_PROFILE[a];
      else if (k === K_DEATH) v = C.DELTA_D;
      else v = 1;                                   // vaccination: x hazard per step
      base[e] = v * st.sign[e];
    }
    // contacts and seasonal factor per step
    const m = p.hol_mix[0], kb = p.brk[0], Cs = ctx.Cs;
    const Ct = new Float64Array(T * 25), sig = new Float64Array(T);
    const nh = C.N_HARM, phase = p.phase[0];
    for (let s = 0; s < T; s++) {
      const fo = 1 + (m - 1) * cal.hol[s], fw = 1 + (kb - 1) * cal.win[s];
      for (let q = 0; q < 25; q++) Ct[s * 25 + q] = Cs.home[q] + Cs.school[q] * cal.open[s] + (Cs.work[q] + Cs.others[q] * fo) * fw;
      let arg = 0;
      if (nh > 0) {
        const ang = (2 * Math.PI * ((s + 0.5) / spw - phase)) / C.PERIOD;
        for (let h = 1; h <= nh; h++) arg += p.seas[2 * (h - 1)] * Math.cos(h * ang) + p.seas[2 * (h - 1) + 1] * Math.sin(h * ang);
      }
      sig[s] = Math.exp(arg);
    }
    // initial state
    const n = sys.n, x0 = new Float64Array(n);
    const pf = p.p0_frac[0], vLeft = Math.exp(-p.omega_v[0] * 26);
    for (let a = 0; a < NA; a++) for (let j = 0; j < NJ; j++) {
      const lvl = Math.log(p.s0[j] / (1 - p.s0[j]));
      const s0 = sigm(lvl + p.s0_prof[a * NJ + j]);
      const i0 = p.seed[j];
      const sTot = s0 * (1 - i0), vv = sTot * inp.cov_prev[i][a] * vLeft;
      const isA = C.A_STRAINS.includes(j);
      const pp = isA ? (sTot - vv) * pf : 0, qq = isA ? vv * pf : 0;
      x0[ctx.idx("S", a, j)] = sTot - vv - pp;
      x0[ctx.idx("V", a, j)] = vv - qq;
      if (isA) { x0[ctx.idx("P", a, j)] = pp; x0[ctx.idx("Q", a, j)] = qq; }
      x0[ctx.idx("I", a, j)] = i0;
      x0[ctx.idx("R", a, j)] = 1 - s0 * (1 - i0) - i0;
    }
    // one solve per scenario
    const K = inp.scenarios.length, rho = p.rho[0];
    const out = [];
    for (let k = 0; k < K; k++) {
      const vac = inp.vacc[i][k];
      const setCoef = (s, c) => {
        for (const e of ctx.statE) c[e] = base[e];
        const cb = s * 25, sg = sig[s];
        for (let q = 0; q < ctx.infl.length; q++) { const e = ctx.infl[q]; c[e] = base[e] * sg * Ct[cb + ctx.inflAB[q]]; }
        const wk = vac[Math.min(Math.floor(s / spw), N - 1)];
        for (let q = 0; q < ctx.vaccE.length; q++) { const e = ctx.vaccE[q]; c[e] = base[e] * wk[ctx.vaccA[q]]; }
      };
      out.push(SMHSolver.solve(sys, x0, T, 1 / spw, inp.fine, setCoef, spw));
    }
    // observations
    const at = (X, w, name) => X[w * n + ctx.ix[name]];
    const res = { scenarios: inp.scenarios, p, rho, nbK: p.nb_k[0], perScenario: [] };
    for (let k = 0; k < K; k++) {
      const X = out[k];
      const adm = [], dth = [], inc = [], hinc = [], susc = [];
      for (let w = 0; w < N; w++) {
        adm.push(Array.from({ length: NA }, (_, a) => (at(X, w + 1, "Hc" + a) - at(X, w, "Hc" + a)) * pop[a] * rho));
        dth.push(Array.from({ length: NA }, (_, a) => (at(X, w + 1, "Dc" + a) - at(X, w, "Dc" + a)) * pop[a]));
        inc.push(Array.from({ length: NJ }, (_, j) => at(X, w + 1, "Inc" + j) - at(X, w, "Inc" + j)));
        hinc.push(Array.from({ length: NJ }, (_, j) => at(X, w + 1, "Hinc" + j) - at(X, w, "Hinc" + j)));
        susc.push(Array.from({ length: NJ }, (_, j) => 100 * frac.reduce((acc, f, a) => acc + f * at(X, w + 1, `S${a}${j}`), 0)));
      }
      res.perScenario.push({ adm, dth, inc, hinc, susc, admAll: adm.map((r) => r.reduce((x, y) => x + y, 0)), dthAll: dth.map((r) => r.reduce((x, y) => x + y, 0)) });
    }
    // transmission potential relative to term time (weekly), shared by scenarios
    const A = new Float64Array(25), force = [];
    for (let w = 0; w < N; w++) {
      const s = w * spw;
      for (let q = 0; q < 25; q++) A[q] = Ct[s * 25 + q];
      force.push((SMHSolver.spectralRadius(A, 5) / inp.rho_C) * sig[s]);
    }
    res.force = force;
    res.secs = (performance.now() - t_start) / 1000;
    return res;
  }

  /* Series shown by the round's panels, for scenario k, plus fit-quality numbers. */
  function view(ctx, i, res, k, obs) {
    const { inp, N, W } = ctx;
    const r = res.perScenario[k];
    const pop = inp.pop[i], popT = pop.reduce((a, b) => a + b, 0);
    const hosp = obs.hosp[i];
    const obsAll = hosp.map((row) => (row.every((v) => v == null) ? null : row.reduce((a, v) => a + (v || 0), 0)));
    const shares = r.hinc.map((h) => { const s = h[0] + h[1] + h[2]; return h.map((v) => (s > 0 ? v / s : null)); });
    const series = {
      adm_all: r.admAll, obs_all: obsAll, adm_age: r.adm, obs_age: hosp,
      adm_strain: r.hinc.map((h) => h.map((v) => v * popT * res.rho)), shares, susc: r.susc,
      inf_strain: r.inc.map((h) => h.map((v) => v * 100)), force: res.force,
    };
    // likelihood parts over the calibration window
    const ll = {};
    let lh = 0;
    for (let w = 0; w < W; w++) for (let a = 0; a < 5; a++) { const y = hosp[w][a]; if (y != null) lh += SMHStats.nbLogpmf(y, r.adm[w][a], res.nbK); }
    ll["Admissions log-likelihood"] = lh;
    if (inp.locations[i].abbr === "US") {
      let ls = 0;
      for (let w = 0; w < W; w++) {
        const nn = obs.subtype[w];
        if (nn && nn[0] != null && nn[0] + nn[1] + nn[2] > 0) ls += SMHStats.dmLogpmf(nn, shares[w].map((v) => v || 0), inp.consts.SUB_CONC);
      }
      ll["Lab subtype log-likelihood"] = ls;
      const dd = obs.deaths, a1 = Math.min(dd.last, W - 1);
      let D = 0; for (let w = dd.first; w <= a1; w++) D += r.dthAll[w];
      const mu = 0.5 * (Math.log(dd.lo) + Math.log(dd.hi)), sd = (Math.log(dd.hi) - Math.log(dd.lo)) / 3.92;
      ll["Deaths (2025-26 range)"] = -0.5 * ((Math.log(Math.max(D, 1)) - mu) / sd) ** 2;
      series.lab_shares = obs.subtype.map((nn) => { if (!nn || nn[0] == null) return null; const s = nn[0] + nn[1] + nn[2]; return s > 0 ? nn.map((v) => v / s) : null; });
      const cum = new Array(N).fill(null); let c = 0;
      for (let w = dd.first; w <= Math.min(dd.last, N - 1); w++) { c += r.dthAll[w]; cum[w] = c / 1e3; }
      series.deaths_cum = cum; series.deaths_range = { x: Math.min(dd.last, N - 1), lo: dd.lo / 1e3, hi: dd.hi / 1e3 };
    }
    return { series, ll };
  }

  SMH.registerModel({ init, solve, view, unpack });
})();
