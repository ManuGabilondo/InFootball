import express from "express";
import "dotenv/config";
import fs from "fs";
import { build, metrics, probs, PARAMS } from "./elo.js";

const app = express();
const PORT = process.env.PORT || 3000;
const BASE = process.env.FOOTBALL_API_BASE || "https://api.football-data.org/v4";
const API_KEY = process.env.FOOTBALL_API_KEY;

if (!API_KEY || API_KEY === "tu_clave_aqui") {
  console.error("Falta FOOTBALL_API_KEY en el archivo .env");
  process.exit(1);
}

const ALLOWED = new Set(["PD", "PL", "SA", "BL1", "FL1", "DED", "PPL", "ELC", "CL"]);
const cache = new Map();
const TTL = 5 * 60 * 1000;
const rate = { availableMinute: null, resetSeconds: null, blockedUntil: 0 };

function updateRate(res) {
  const avail = res.headers.get("x-requests-available-minute");
  const reset = res.headers.get("x-requestcounter-reset");
  if (avail !== null) rate.availableMinute = Number(avail);
  if (reset !== null) rate.resetSeconds = Number(reset);
  if (res.status === 429 || rate.availableMinute === 0) {
    const wait = (rate.resetSeconds || 60) + 1;
    rate.blockedUntil = Date.now() + wait * 1000;
    console.warn(`Límite alcanzado. Pausa de ${wait}s.`);
  }
}

async function fdFetch(path, ttl = TTL) {
  const hit = cache.get(path);
  if (hit && Date.now() - hit.time < ttl) return hit.data;

  if (Date.now() < rate.blockedUntil) {
    if (hit) return hit.data;
    const secs = Math.ceil((rate.blockedUntil - Date.now()) / 1000);
    throw new Error(`Límite de peticiones alcanzado. Reintenta en ${secs}s`);
  }

  const res = await fetch(`${BASE}${path}`, { headers: { "X-Auth-Token": API_KEY } });
  updateRate(res);

  if (res.status === 429) {
    if (hit) return hit.data;
    throw new Error("Límite de peticiones alcanzado, reintenta en un minuto");
  }
  if (!res.ok) throw new Error(`Football-Data respondió ${res.status}`);

  const data = await res.json();
  cache.set(path, { data, time: Date.now() });
  return data;
}

function route(pathBuilder) {
  return async (req, res) => {
    const code = req.params.code.toUpperCase();
    if (!ALLOWED.has(code)) return res.status(400).json({ error: "Competición no permitida" });
    try {
      res.json(await fdFetch(pathBuilder(code)));
    } catch (e) {
      res.status(502).json({ error: e.message });
    }
  };
}

// Ficha de equipo: combina /teams/{id} y /teams/{id}/matches en una sola respuesta compacta
const slim = (x) => ({
  date: x.utcDate,
  comp: x.competition?.name,
  homeId: x.homeTeam?.id,
  awayId: x.awayTeam?.id,
  home: x.homeTeam?.shortName || x.homeTeam?.name,
  away: x.awayTeam?.shortName || x.awayTeam?.name,
  hg: x.score?.fullTime?.home ?? null,
  ag: x.score?.fullTime?.away ?? null,
});
const byDate = (a, b) => new Date(a.utcDate) - new Date(b.utcDate);

app.get("/api/team/:id", async (req, res) => {
  const id = req.params.id;
  if (!/^\d{1,8}$/.test(id)) return res.status(400).json({ error: "Id de equipo no válido" });
  const [t, m] = await Promise.allSettled([
    fdFetch(`/teams/${id}`, 30 * 60 * 1000),
    fdFetch(`/teams/${id}/matches`, 10 * 60 * 1000),
  ]);
  if (t.status === "rejected") return res.status(502).json({ error: t.reason.message });

  const team = t.value;
  const all = m.status === "fulfilled" ? m.value.matches || [] : [];
  res.json({
    team: {
      name: team.name,
      founded: team.founded,
      venue: team.venue,
      colors: team.clubColors,
      website: team.website,
      coach: team.coach ? { name: team.coach.name, nationality: team.coach.nationality } : null,
      squad: (team.squad || []).map((p) => ({
        name: p.name,
        position: p.position,
        nationality: p.nationality,
        dateOfBirth: p.dateOfBirth,
      })),
    },
    last: all.filter((x) => x.status === "FINISHED").sort(byDate).slice(-5).reverse().map(slim),
    next: all.filter((x) => ["SCHEDULED", "TIMED"].includes(x.status)).sort(byDate).slice(0, 3).map(slim),
  });
});

/* ---------- Modelo ELO y seguimiento de predicciones ---------- */
const MODEL_CODES = new Set(["PD", "PL", "SA", "BL1", "FL1", "DED", "PPL", "ELC"]);
const STORE = "data/predictions.json"; // predicciones congeladas antes de cada partido
let store = {};
try { store = JSON.parse(fs.readFileSync(STORE, "utf8")); } catch {}
const saveStore = () => {
  fs.mkdirSync("data", { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(store));
};

const norm = (x) => ({
  id: x.id, date: x.utcDate, status: x.status,
  homeId: x.homeTeam?.id, awayId: x.awayTeam?.id,
  home: x.homeTeam?.shortName || x.homeTeam?.name, away: x.awayTeam?.shortName || x.awayTeam?.name,
  hg: x.score?.fullTime?.home, ag: x.score?.fullTime?.away,
});
const valid = (m) => m.homeId && m.awayId;
const done = (m) => m.status === "FINISHED" && m.hg != null && m.ag != null;
const byD = (a, b) => new Date(a.date) - new Date(b.date);
const outcome = (hg, ag) => (hg > ag ? "H" : hg < ag ? "A" : "D");
const modelCache = new Map();
const prevMiss = new Map(); // ligas cuya temporada anterior no está disponible en tu plan

app.get("/api/model/:code", async (req, res) => {
  const code = req.params.code.toUpperCase();
  if (!MODEL_CODES.has(code)) return res.status(400).json({ error: "Modelo no disponible para esta competición" });
  const hit = modelCache.get(code);
  if (hit && Date.now() - hit.time < 10 * 60 * 1000) return res.json(hit.data);

  try {
    const raw = await fdFetch(`/competitions/${code}/matches`, 10 * 60 * 1000);
    const cur = (raw.matches || []).map(norm).filter(valid);
    if (!cur.length) throw new Error("Sin partidos para esta competición");

    // Temporada anterior para "calentar" los ratings (si tu plan la permite)
    let prev = [], warmNote = null, transient = false;
    const year = Number((raw.matches[0].season?.startDate || "").slice(0, 4));
    if (year && !(prevMiss.get(code) > Date.now() - 3600e3)) {
      try {
        const p = await fdFetch(`/competitions/${code}/matches?season=${year - 1}`, 24 * 3600e3);
        prev = (p.matches || []).map(norm).filter(valid).filter(done);
      } catch (e) {
        if (/40[34]/.test(e.message)) prevMiss.set(code, Date.now()); else transient = true;
        warmNote = "No se pudo cargar la temporada anterior (" + e.message + ")";
      }
    } else if (year) warmNote = "La temporada anterior no está disponible en tu plan";

    const { R, names, rows, history, currentTeams } = build(
      prev.length ? [prev, cur.filter(done)] : [cur.filter(done)], PARAMS, cur
    );
    const teams = currentTeams.map((id) => {
      const h = history.get(id);
      return { id, name: names.get(id), rating: Math.round(R.get(id)), played: h.length - 1, delta: Math.round(h[h.length - 1] - h[0]) };
    }).sort((a, b) => b.rating - a.rating);
    const hist = Object.fromEntries(currentTeams.map((id) => [id, history.get(id).map(Math.round)]));

    // Próxima jornada: se predice y se CONGELA la predicción (solo si el partido aún no ha empezado)
    const now = Date.now();
    const upcoming = cur
      .filter((m) => ["SCHEDULED", "TIMED"].includes(m.status) && new Date(m.date) > now)
      .sort(byD).slice(0, Math.floor(currentTeams.length / 2))
      .map((m) => ({
        id: m.id, date: m.date, home: m.home, away: m.away, homeId: m.homeId, awayId: m.awayId,
        pr: probs(R.get(m.homeId) ?? PARAMS.START, R.get(m.awayId) ?? PARAMS.START),
      }));
    for (const u of upcoming) if (!store[u.id]) store[u.id] = { ...u, code, frozenAt: new Date().toISOString() };

    // Comprobación: las predicciones congeladas cuyo partido ya terminó reciben su resultado real
    const byId = new Map(cur.map((m) => [m.id, m]));
    for (const s of Object.values(store)) {
      const m = byId.get(s.id);
      if (s.code === code && !s.result && m && done(m)) s.result = { hg: m.hg, ag: m.ag, outcome: outcome(m.hg, m.ag) };
    }
    saveStore();

    const all = Object.values(store);
    const mine = all.filter((s) => s.code === code);
    const asRows = (list) => list.filter((s) => s.result).map((s) => ({ pr: s.pr, outcome: s.result.outcome }));
    const data = {
      code, warm: prev.length > 0, warmNote, params: PARAMS, teams, history: hist,
      metrics: { all: metrics(rows), current: metrics(rows.filter((r) => r.current)) },
      upcoming,
      tracking: {
        league: metrics(asRows(mine)), all: metrics(asRows(all)),
        pending: mine.filter((s) => !s.result).length,
        recent: mine.filter((s) => s.result).sort((a, b) => new Date(b.date) - new Date(a.date)).slice(0, 8),
      },
    };
    if (!transient) modelCache.set(code, { time: Date.now(), data });
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
});

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, rate: { availableMinute: rate.availableMinute, resetSeconds: rate.resetSeconds } })
);
app.get("/api/standings/:code", route((c) => `/competitions/${c}/standings`));
app.get("/api/scorers/:code", route((c) => `/competitions/${c}/scorers?limit=30`));

app.use(express.static("public"));
app.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
