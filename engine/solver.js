/* SMH-web — ODE solver for mass-action compartmental models with time-varying rates.
 *
 *   dx[tgt_e]/dt += c_e(step) * prod_{s in src_e} x_s        (sum over transitions e)
 *
 * A model is a list of transitions ("edges"): source compartments, a target compartment and a rate coefficient.
 * Coefficients are held constant within each step of length h and may change between steps (seasonality,
 * vaccination campaigns, interventions). Classical RK4 with `fine` substeps per step; states are clamped at 0
 * after every substep. This is the same scheme as the Python solver used for calibration, so the two agree to
 * rounding error.
 */
(function (root) {
  "use strict";

  function compile(st) {
    // st: { n, src: flat source list, ptr: [E+1] offsets into src, tgt: [E] }
    const E = st.tgt.length;
    return { n: st.n, E, src: Int32Array.from(st.src), ptr: Int32Array.from(st.ptr), tgt: Int32Array.from(st.tgt) };
  }

  /* x0: Float64Array(n); T: number of steps; h: step length; fine: RK4 substeps per step;
   * setCoef(s, c): fill Float64Array c (length E) with the coefficients of step s;
   * outEvery: keep the state every outEvery steps (and at t = 0).
   * Returns Float64Array((floor(T / outEvery) + 1) * n). */
  function solve(sys, x0, T, h, fine, setCoef, outEvery) {
    const { n, E, src, ptr, tgt } = sys;
    const hs = h / fine;
    const c = new Float64Array(E);
    let x = Float64Array.from(x0);
    const k1 = new Float64Array(n), k2 = new Float64Array(n), k3 = new Float64Array(n), k4 = new Float64Array(n);
    const tmp = new Float64Array(n);
    const nOut = Math.floor(T / outEvery) + 1;
    const out = new Float64Array(nOut * n);
    out.set(x, 0);
    const rhs = (y, k) => {
      k.fill(0);
      for (let e = 0; e < E; e++) {
        let p = c[e];
        if (p === 0) continue;
        for (let q = ptr[e]; q < ptr[e + 1]; q++) {
          const v = y[src[q]];
          p *= v > 1e-30 ? v : 1e-30;
        }
        k[tgt[e]] += p;
      }
    };
    let o = 1;
    for (let s = 0; s < T; s++) {
      setCoef(s, c);
      for (let f = 0; f < fine; f++) {
        rhs(x, k1);
        for (let i = 0; i < n; i++) tmp[i] = x[i] + 0.5 * hs * k1[i];
        rhs(tmp, k2);
        for (let i = 0; i < n; i++) tmp[i] = x[i] + 0.5 * hs * k2[i];
        rhs(tmp, k3);
        for (let i = 0; i < n; i++) tmp[i] = x[i] + hs * k3[i];
        rhs(tmp, k4);
        for (let i = 0; i < n; i++) {
          const v = x[i] + (hs / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i]);
          x[i] = v > 0 ? v : 0;
        }
      }
      if ((s + 1) % outEvery === 0) { out.set(x, o * n); o++; }
    }
    return out;
  }

  /* Largest real eigenvalue of a small non-negative matrix (row-major, m x m), by power iteration. */
  function spectralRadius(A, m, iters = 200) {
    let v = new Float64Array(m).fill(1), lam = 0;
    for (let it = 0; it < iters; it++) {
      const w = new Float64Array(m);
      for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) w[i] += A[i * m + j] * v[j];
      let nrm = 0; for (let i = 0; i < m; i++) nrm = Math.max(nrm, Math.abs(w[i]));
      if (nrm === 0) return 0;
      for (let i = 0; i < m; i++) w[i] /= nrm;
      lam = nrm; v = w;
    }
    return lam;
  }

  root.SMHSolver = { compile, solve, spectralRadius };
})(typeof self !== "undefined" ? self : this);
