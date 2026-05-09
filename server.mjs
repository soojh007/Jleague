import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

async function loadDotEnv() {
  try {
    const envFile = await readFile(join(__dirname, ".env"), "utf8");

    for (const line of envFile.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

      const [key, ...valueParts] = trimmed.split("=");
      const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
      process.env[key.trim()] ??= value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

await loadDotEnv();

const PORT = Number(process.env.PORT || 3000);
const API_TOKEN = process.env.SPORTMONKS_API_TOKEN;
const DEFAULT_FIXTURE_ID = "19630291";
const UPCOMING_MARKETS = new Set([231, 235, 236, 237]);
const DISPLAY_LEAGUES = new Set([3537, 3550]);
const CACHE_TTL_MS = 5 * 60 * 1000;
const todayCache = new Map();
const pendingTodayRequests = new Map();

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, data) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}

function todayUtcDate() {
  return new Date().toISOString().slice(0, 10);
}

async function fetchSportsMonk(endpoint, timeoutMs = 20000) {
  if (!API_TOKEN) {
    return {
      status: 500,
      data: {
        message: "SPORTMONKS_API_TOKEN is not set in the server environment.",
      },
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  let response;
  let data;

  try {
    response = await fetch(endpoint, { signal: controller.signal });
    data = await response.json();
  } catch (error) {
    if (error.name === "AbortError") {
      return {
        status: 504,
        data: {
          message: "SportsMonk request timed out. Try refreshing in a moment.",
        },
      };
    }

    return {
      status: 502,
      data: {
        message: `Could not reach SportsMonk: ${error.message}`,
      },
    };
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 429) {
    return {
      status: 429,
      data: {
        ...data,
        message:
          data.message ||
          `Rate limit reached. Try again in ${data.rate_limit?.resets_in_seconds ?? "about 3600"} seconds.`,
      },
    };
  }

  return {
    status: response.ok ? 200 : response.status,
    data,
  };
}

async function fetchFixture(fixtureId) {
  const endpoint = new URL(
    `https://api.sportmonks.com/v3/football/fixtures/${fixtureId}`,
  );
  endpoint.searchParams.set("api_token", API_TOKEN);
  endpoint.searchParams.set(
    "include",
    "participants;scores;events;statistics;predictions;league",
  );

  return fetchSportsMonk(endpoint);
}

function keepUpcomingMarkets(fixture) {
  return {
    ...fixture,
    predictions: (fixture.predictions || []).filter((prediction) =>
      UPCOMING_MARKETS.has(prediction.type_id),
    ),
  };
}

async function fetchTodayFixtures(date = todayUtcDate()) {
  const cached = todayCache.get(date);

  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return {
      ...cached.result,
      data: {
        ...cached.result.data,
        cache: {
          hit: true,
          max_age_seconds: Math.round((CACHE_TTL_MS - (Date.now() - cached.createdAt)) / 1000),
        },
      },
    };
  }

  if (pendingTodayRequests.has(date)) {
    return pendingTodayRequests.get(date);
  }

  const request = fetchTodayFixturesFromApi(date).finally(() => {
    pendingTodayRequests.delete(date);
  });

  pendingTodayRequests.set(date, request);
  return request;
}

async function fetchTodayFixturesFromApi(date = todayUtcDate()) {
  const fixtures = [];
  let finalResult;

  for (let page = 1; page <= 4; page += 1) {
    const endpoint = new URL(
      `https://api.sportmonks.com/v3/football/fixtures/date/${date}`,
    );
    endpoint.searchParams.set("api_token", API_TOKEN);
    endpoint.searchParams.set("include", "participants;league;predictions");
    endpoint.searchParams.set("per_page", "50");
    endpoint.searchParams.set("page", String(page));

    finalResult = await fetchSportsMonk(endpoint);

    if (!finalResult.data?.data || !Array.isArray(finalResult.data.data)) {
      return finalResult;
    }

    fixtures.push(...finalResult.data.data);

    if (!finalResult.data.pagination?.has_more) break;
  }

  const todayFixtures = fixtures
    .filter((fixture) => DISPLAY_LEAGUES.has(fixture.league_id))
    .map(keepUpcomingMarkets)
    .sort((a, b) => (a.starting_at_timestamp || 0) - (b.starting_at_timestamp || 0));

  const result = {
    ...finalResult,
    data: {
      ...finalResult.data,
      data: todayFixtures,
      cache: {
        hit: false,
        max_age_seconds: Math.round(CACHE_TTL_MS / 1000),
      },
      pagination: {
        ...finalResult.data.pagination,
        count: todayFixtures.length,
        has_more: Boolean(finalResult.data.pagination?.has_more),
      },
    },
  };

  todayCache.set(date, {
    createdAt: Date.now(),
    result,
  });

  return result;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host}`);

    if (url.pathname === "/health") {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (url.pathname === "/api/today") {
      const date = url.searchParams.get("date") || todayUtcDate();

      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        sendJson(res, 400, { message: "Date must use YYYY-MM-DD format." });
        return;
      }

      const result = await fetchTodayFixtures(date);
      sendJson(res, result.status, result.data);
      return;
    }

    if (url.pathname.startsWith("/api/fixture/")) {
      const fixtureId = url.pathname.split("/").pop() || DEFAULT_FIXTURE_ID;

      if (!/^\d+$/.test(fixtureId)) {
        sendJson(res, 400, { message: "Fixture id must be an integer." });
        return;
      }

      const result = await fetchFixture(fixtureId);
      sendJson(res, result.status, result.data);
      return;
    }

    const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
    const safePath = normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(__dirname, safePath);
    const body = await readFile(filePath);
    const type = contentTypes[extname(filePath)] || "application/octet-stream";

    res.writeHead(200, { "content-type": type });
    res.end(body);
  } catch (error) {
    if (error.code === "ENOENT") {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    console.error(error);
    sendJson(res, 500, { message: "Unexpected server error." });
  }
});

server.listen(PORT, () => {
  console.log(`SportsMonk dashboard: http://localhost:${PORT}`);
});
