/* SMH-web — small statistics helpers: log-gamma, negative-binomial log-pmf and quantiles,
 * Dirichlet-multinomial log-pmf, empirical quantiles. */
(function (root) {
  "use strict";
  const G = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
    12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];

  function lgamma(z) {
    if (z < 0.5) return Math.log(Math.PI / Math.abs(Math.sin(Math.PI * z))) - lgamma(1 - z);
    z -= 1;
    let a = G[0];
    const t = z + 7.5;
    for (let i = 1; i < 9; i++) a += G[i] / (z + i);
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(a);
  }

  function nbLogpmf(y, mu, k) {
    mu = Math.max(mu, 1e-9);
    return lgamma(y + k) - lgamma(k) - lgamma(y + 1) + k * Math.log(k / (k + mu)) + y * Math.log(mu / (k + mu));
  }

  /* Negative-binomial quantiles (mean mu, dispersion k) at probabilities qs (ascending).
   * Exact (cumulative pmf) for moderate means; a moment-matched gamma (Wilson-Hilferty) for large ones. */
  function nbQuantiles(mu, k, qs) {
    mu = Math.max(mu, 1e-9);
    const v = mu + (mu * mu) / k;
    if (mu < 400) {
      const p = k / (k + mu);
      let pmf = Math.exp(k * Math.log(p)), cdf = pmf, y = 0;
      const out = new Array(qs.length);
      let qi = 0;
      const cap = Math.ceil(mu + 12 * Math.sqrt(v) + 20);
      while (qi < qs.length) {
        while (qi < qs.length && cdf >= qs[qi]) out[qi++] = y;
        if (y > cap) { while (qi < qs.length) out[qi++] = y; break; }
        pmf *= ((y + k) / (y + 1)) * (1 - p);
        y++; cdf += pmf;
      }
      return out;
    }
    const shape = (mu * mu) / v, scale = v / mu;
    return qs.map((q) => {
      const z = normInv(q), c = 1 / (9 * shape);
      return Math.max(0, shape * scale * Math.pow(1 - c + z * Math.sqrt(c), 3));
    });
  }

  function normInv(p) {   // Acklam's rational approximation
    const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
    const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
    const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
    const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
    const pl = 0.02425;
    if (p < pl) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - pl) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  }

  /* Dirichlet-multinomial log-pmf (without the multinomial coefficient) of counts n given proportions pi. */
  function dmLogpmf(n, pi, conc) {
    let A = 0, N = 0, s = 0;
    for (let i = 0; i < n.length; i++) {
      const a = Math.max(pi[i] * conc, 1e-9);
      A += a; N += n[i]; s += lgamma(n[i] + a) - lgamma(a);
    }
    return lgamma(A) - lgamma(N + A) + s;
  }

  root.SMHStats = { lgamma, nbLogpmf, nbQuantiles, normInv, dmLogpmf };
})(typeof self !== "undefined" ? self : this);
