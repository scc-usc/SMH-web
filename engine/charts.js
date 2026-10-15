/* SMH-web — small SVG time-series charts with bands, stacks, dots, ranges and a hover crosshair + tooltip.
 *
 * SMHCharts.chart(el, cfg)
 *   cfg.dates: ["YYYY-MM-DD", ...] (one per week); cfg.i0 / cfg.i1: index range shown
 *   cfg.series: [{type: "line"|"band"|"stack"|"dots"|"range", ...}], cfg.tip: [{name, y, color, f}]
 *   options: height, ymax, ymin, autoMin, yfmt, hline, marker (index of a dashed vertical line)
 */
(function (root) {
  "use strict";
  const fmt = (v) => {
    if (v == null || !isFinite(v)) return "–";
    if (Math.abs(v) < 1e-9) return "0";
    const a = Math.abs(v);
    return a >= 1e4 ? Math.round(v).toLocaleString() : a >= 100 ? v.toFixed(0) : a >= 10 ? v.toFixed(1) : a >= 1 ? v.toFixed(2)
      : a >= 0.01 ? v.toFixed(3) : v.toPrecision(2);
  };
  const fmtN = (v) => (v == null || !isFinite(v) ? "–" : Math.round(v).toLocaleString());
  const dlabel = (s) => new Date(s + "T00:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "2-digit" });

  function niceTicks(lo, hi, n) {
    const span = hi - lo, step0 = span / n, mag = Math.pow(10, Math.floor(Math.log10(step0))), r = step0 / mag;
    const step = (r < 1.5 ? 1 : r < 3 ? 2 : r < 7 ? 5 : 10) * mag, out = [];
    for (let t = Math.ceil(lo / step) * step; t <= hi + 1e-9; t += step) out.push(+t.toPrecision(12));
    return out;
  }

  let tipEl = null;
  function tip() {
    if (!tipEl) { tipEl = document.createElement("div"); tipEl.className = "tip"; document.body.appendChild(tipEl); }
    return tipEl;
  }

  function chart(el, cfg) {
    const W = Math.max(240, el.clientWidth), H = cfg.height || 170, m = { l: 46, r: 8, t: 6, b: 20 };
    const dates = cfg.dates, i0 = cfg.i0 || 0, i1 = cfg.i1 != null ? cfg.i1 : dates.length - 1;
    const n = i1 - i0 + 1, xs = (i) => m.l + ((i - i0) / Math.max(1, n - 1)) * (W - m.l - m.r);
    let ymax = 0, ymin = cfg.ymin != null ? cfg.ymin : 0;
    const upd = (v) => { if (v != null && isFinite(v) && v > ymax) ymax = v; };
    for (const s of cfg.series) {
      for (let i = i0; i <= i1; i++) {
        if (s.type === "band") upd(s.hi[i]);
        else if (s.type === "paths") { if (!cfg.ymax) for (const y of s.ys) upd(y[i]); }
        else if (s.type === "stack") upd(s.ys.reduce((a, y) => a + (y[i] || 0), 0));
        else if (s.y) upd(s.y[i]);
      }
      if (s.type === "range") upd(s.hi);
    }
    if (cfg.ymax != null) ymax = Math.max(ymax, cfg.ymax);
    if (cfg.autoMin) {
      let mn = Infinity;
      for (const s of cfg.series) if (s.y) for (let i = i0; i <= i1; i++) if (s.y[i] != null) mn = Math.min(mn, s.y[i]);
      const pad = 0.04 * (ymax - mn || 1);
      ymin = Math.min(mn, cfg.hline != null ? cfg.hline : mn) - pad; ymax += pad;
    } else ymax = ymax <= ymin ? ymin + 1 : ymax * 1.05;
    const ys = (v) => m.t + (1 - (v - ymin) / (ymax - ymin)) * (H - m.t - m.b);
    let g = `<svg width="${W}" height="${H}" role="img" aria-label="${cfg.title || "chart"}">`;
    for (const t of niceTicks(ymin, ymax, 4))
      g += `<line x1="${m.l}" x2="${W - m.r}" y1="${ys(t)}" y2="${ys(t)}" stroke="var(--grid)"/>`
        + `<text x="${m.l - 6}" y="${ys(t) + 3}" text-anchor="end">${cfg.yfmt ? cfg.yfmt(t) : fmt(t)}</text>`;
    let last = -1;
    for (let i = i0; i <= i1; i++) {
      const d = new Date(dates[i] + "T00:00:00"), mo = d.getMonth();
      if (mo !== last && d.getDate() <= 7) {
        const every = n > 70 ? 3 : 2;
        if (mo % every === 0) g += `<text x="${xs(i)}" y="${H - 5}" text-anchor="middle">${d.toLocaleDateString(undefined, { month: "short" })}${mo === 0 ? " " + String(d.getFullYear()).slice(2) : ""}</text>`;
        last = mo;
      }
    }
    const clampY = (v) => Math.max(ymin, Math.min(v, ymax));
    const path = (y) => { let p = "", pen = false;
      for (let i = i0; i <= i1; i++) { const v = y[i];
        if (v == null || !isFinite(v)) { pen = false; continue; }
        p += (pen ? "L" : "M") + xs(i).toFixed(1) + "," + ys(clampY(v)).toFixed(1); pen = true; }
      return p; };
    const area = (lo, hi) => { let a = "", b = "";
      for (let i = i0; i <= i1; i++) a += (i === i0 ? "M" : "L") + xs(i).toFixed(1) + "," + ys(clampY(hi[i] ?? 0)).toFixed(1);
      for (let i = i1; i >= i0; i--) b += "L" + xs(i).toFixed(1) + "," + ys(clampY(lo[i] ?? 0)).toFixed(1);
      return a + b + "Z"; };
    for (const s of cfg.series) {
      if (s.type === "band") g += s.color ? `<path d="${area(s.lo, s.hi)}" fill="${s.color}" fill-opacity="${s.alpha}"/>`
        : `<path d="${area(s.lo, s.hi)}" fill="rgba(var(--band),${s.alpha})"/>`;
      else if (s.type === "paths") {          // many thin lines (individual trajectories)
        let d = "";
        for (const y of s.ys) d += path(y);
        g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-opacity="${s.alpha || 0.15}" stroke-width="${s.width || 0.8}" stroke-linejoin="round"/>`;
      } else if (s.type === "stack") {
        const cum = new Array(dates.length).fill(0);
        s.ys.forEach((y, k) => { const lo = cum.slice(), hi = cum.map((c, i) => c + (y[i] || 0)); hi.forEach((v, i) => (cum[i] = v));
          g += `<path d="${area(lo, hi)}" fill="${s.colors[k]}" fill-opacity=".85" stroke="var(--surface)" stroke-width="1"/>`; });
      } else if (s.type === "line") g += `<path d="${path(s.y)}" fill="none" stroke="${s.color}" stroke-width="${s.width || 1.8}" ${s.dash ? `stroke-dasharray="${s.dash}"` : ""} stroke-linejoin="round"/>`;
      else if (s.type === "dots") { for (let i = i0; i <= i1; i++) { const v = s.y[i]; if (v == null || !isFinite(v)) continue;
          g += `<circle cx="${xs(i).toFixed(1)}" cy="${ys(clampY(v)).toFixed(1)}" r="${s.r || 2.4}" fill="${s.hollow ? "var(--surface)" : s.color}" stroke="${s.color}" stroke-width="${s.hollow ? 1.2 : 0}"/>`; } }
      else if (s.type === "range" && s.x >= i0 && s.x <= i1) {
        const x = xs(s.x);
        g += `<line x1="${x}" x2="${x}" y1="${ys(s.lo)}" y2="${ys(s.hi)}" stroke="var(--data)" stroke-width="2"/>`
          + `<line x1="${x - 4}" x2="${x + 4}" y1="${ys(s.lo)}" y2="${ys(s.lo)}" stroke="var(--data)" stroke-width="2"/>`
          + `<line x1="${x - 4}" x2="${x + 4}" y1="${ys(s.hi)}" y2="${ys(s.hi)}" stroke="var(--data)" stroke-width="2"/>`;
      }
    }
    if (cfg.hline != null) g += `<line x1="${m.l}" x2="${W - m.r}" y1="${ys(cfg.hline)}" y2="${ys(cfg.hline)}" stroke="var(--muted)" stroke-dasharray="3 3"/>`;
    if (cfg.marker != null && cfg.marker > i0 && cfg.marker < i1) g += `<line x1="${xs(cfg.marker) + 0.5}" x2="${xs(cfg.marker) + 0.5}" y1="${m.t}" y2="${H - m.b}" stroke="var(--muted)" stroke-dasharray="4 3"/>`;
    g += `<line class="cross" x1="0" x2="0" y1="${m.t}" y2="${H - m.b}" stroke="var(--ink2)" visibility="hidden"/>`;
    g += `<rect x="${m.l}" y="${m.t}" width="${W - m.l - m.r}" height="${H - m.t - m.b}" fill="transparent"/></svg>`;
    el.innerHTML = g;
    const svg = el.firstChild, cross = svg.querySelector(".cross"), hit = svg.lastChild, tp = tip();
    hit.addEventListener("mousemove", (ev) => {
      const r = svg.getBoundingClientRect(), x = ev.clientX - r.left;
      const i = Math.max(i0, Math.min(i1, Math.round(i0 + ((x - m.l) / (W - m.l - m.r)) * (n - 1))));
      cross.setAttribute("x1", xs(i)); cross.setAttribute("x2", xs(i)); cross.setAttribute("visibility", "visible");
      let h = `<b>week ending ${dlabel(dates[i])}</b>`;
      for (const t of cfg.tip || []) { const v = t.y[i];
        h += `<div><span><span class="sw" style="background:${t.color}"></span>${t.name}</span><span>${t.f ? t.f(v) : fmt(v)}</span></div>`; }
      tp.innerHTML = h; tp.style.display = "block";
      const tx = ev.clientX + 14 + tp.offsetWidth > innerWidth ? ev.clientX - tp.offsetWidth - 14 : ev.clientX + 14;
      tp.style.left = tx + "px"; tp.style.top = ev.clientY - 10 + "px";
    });
    hit.addEventListener("mouseleave", () => { cross.setAttribute("visibility", "hidden"); tp.style.display = "none"; });
  }

  root.SMHCharts = { chart, fmt, fmtN, dlabel };
})(typeof self !== "undefined" ? self : this);
