// Modelo ELO + Davidson para predecir 1X2. Funciones puras, sin dependencias.
export const PARAMS = { K: 20, HFA: 65, NU: 0.7, START: 1500, PROMOTED: 1450, REGRESS: 0.25 };

// Convierte la diferencia de rating en probabilidades local / empate / visitante (modelo de Davidson)
export function probs(rh, ra, p = PARAMS) {
  const r = 10 ** ((rh + p.HFA - ra) / 400);
  const den = r + 1 + p.NU * Math.sqrt(r);
  return { H: r / den, D: (p.NU * Math.sqrt(r)) / den, A: 1 / den };
}

const outcomeOf = (hg, ag) => (hg > ag ? "H" : hg < ag ? "A" : "D");
const goalMult = (d) => (d <= 1 ? 1 : d === 2 ? 1.5 : (11 + d) / 8); // más peso a goleadas

// seasons: array de temporadas (de la más antigua a la actual), cada una con partidos FINISHED normalizados.
// currentAll: todos los partidos de la temporada actual (para conocer todos sus equipos).
// Evaluación "walk-forward": cada partido se predice ANTES de actualizar los ratings con su resultado.
export function build(seasons, p = PARAMS, currentAll = null) {
  const R = new Map(), names = new Map(), rows = [], history = new Map();
  seasons.forEach((matches, si) => {
    const current = si === seasons.length - 1;
    if (si > 0) for (const [id, r] of R) R.set(id, p.START + (1 - p.REGRESS) * (r - p.START));
    const sorted = [...matches].sort((a, b) => new Date(a.date) - new Date(b.date));
    const src = current && currentAll ? currentAll : sorted;
    const ids = new Set();
    src.forEach((m) => {
      ids.add(m.homeId); ids.add(m.awayId);
      names.set(m.homeId, m.home); names.set(m.awayId, m.away);
    });
    ids.forEach((id) => { if (!R.has(id)) R.set(id, si === 0 ? p.START : p.PROMOTED); });
    if (current) ids.forEach((id) => history.set(id, [R.get(id)]));
    const burn = si === 0 ? ids.size : 0; // descarta el arranque de la primera temporada procesada
    sorted.forEach((m, i) => {
      const rh = R.get(m.homeId), ra = R.get(m.awayId);
      const pr = probs(rh, ra, p), o = outcomeOf(m.hg, m.ag);
      if (i >= burn) rows.push({ current, id: m.id, date: m.date, pr, outcome: o });
      const E = pr.H + 0.5 * pr.D, S = o === "H" ? 1 : o === "D" ? 0.5 : 0;
      const d = p.K * goalMult(Math.abs(m.hg - m.ag)) * (S - E);
      R.set(m.homeId, rh + d); R.set(m.awayId, ra - d);
      if (current) { history.get(m.homeId).push(R.get(m.homeId)); history.get(m.awayId).push(R.get(m.awayId)); }
    });
  });
  return { R, names, rows, history, currentTeams: [...history.keys()] };
}

// rows: [{ pr:{H,D,A}, outcome:"H"|"D"|"A" }]
export function metrics(rows) {
  const n = rows.length;
  if (!n) return null;
  const BASE = { H: 0.45, D: 0.26, A: 0.29 }; // frecuencias típicas: línea base sin información
  const ks = ["H", "D", "A"];
  let acc = 0, home = 0, br = 0, bb = 0, ll = 0, bl = 0;
  const bins = Array.from({ length: 10 }, () => ({ p: 0, hit: 0, n: 0 }));
  for (const r of rows) {
    const pick = ks.reduce((a, k) => (r.pr[k] > r.pr[a] ? k : a), "H");
    if (pick === r.outcome) acc++;
    if (r.outcome === "H") home++;
    for (const k of ks) {
      const y = k === r.outcome ? 1 : 0;
      br += (r.pr[k] - y) ** 2; bb += (BASE[k] - y) ** 2;
      const b = bins[Math.min(9, Math.floor(r.pr[k] * 10))];
      b.p += r.pr[k]; b.hit += y; b.n++;
    }
    ll -= Math.log(Math.max(r.pr[r.outcome], 1e-9)); bl -= Math.log(BASE[r.outcome]);
  }
  return {
    n, accuracy: acc / n, brier: br / n, logLoss: ll / n, skill: 1 - br / bb,
    baseline: { accuracy: home / n, brier: bb / n, logLoss: bl / n },
    calibration: bins.filter((b) => b.n).map((b) => ({ meanP: b.p / b.n, freq: b.hit / b.n, n: b.n })),
  };
}
