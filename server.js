import express from "express";
import "dotenv/config";

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

app.get("/api/health", (_req, res) =>
  res.json({ ok: true, rate: { availableMinute: rate.availableMinute, resetSeconds: rate.resetSeconds } })
);
app.get("/api/standings/:code", route((c) => `/competitions/${c}/standings`));
app.get("/api/scorers/:code", route((c) => `/competitions/${c}/scorers?limit=30`));

app.use(express.static("public"));
app.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
