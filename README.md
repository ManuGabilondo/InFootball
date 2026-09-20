# Football TFG

Web de fútbol con backend intermedio (Node + Express) que consume Football-Data.org.

## Puesta en marcha
1. Instala Node.js 18 o superior (https://nodejs.org)
2. `npm install`
3. Copia `.env.example` a `.env` y pon tu API key
4. `npm run dev`
5. Abre http://localhost:3000

## Funcionalidades
- Selector de ligas: LaLiga, Premier League, Serie A, Bundesliga, Ligue 1, Eredivisie, Primeira Liga, Championship y Champions League (según lo que incluya tu plan).
- Clasificación con vistas Total / Local / Visitante.
- Goleadores de la competición.
- Ficha de equipo al hacer clic: estadísticas por vista, forma, últimos y próximos partidos, estadio, entrenador y plantilla.

## Endpoints propios
- GET /api/standings/:code
- GET /api/scorers/:code
- GET /api/team/:id
- GET /api/health (incluye peticiones restantes del minuto)

## Estructura
- server.js: backend, caché, control de límite y endpoints
- public/index.html: frontend
- .env: tu clave (NO se sube a GitHub)
