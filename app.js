const form = document.querySelector("#gamesForm");
const gamesList = document.querySelector("#gamesList");
const statusEl = document.querySelector("#status");
const refreshButton = form.querySelector("button");
const LOAD_TIMEOUT_MS = 45000;
let isLoading = false;
let hasRenderedGames = false;

const marketOrder = [237, 235, 236, 231];

const marketLabels = {
  231: "BTTS",
  235: "O/U 2.5",
  236: "O/U 3.5",
  237: "Match result",
};

const yesNoMarketLabels = {
  231: ["Yes", "No"],
  235: ["Over 2.5", "Under 2.5"],
  236: ["Over 3.5", "Under 3.5"],
};

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#ad2f2f" : "";
}

function setLoadingState(isBusy) {
  isLoading = isBusy;
  refreshButton.disabled = isBusy;
  refreshButton.textContent = isBusy ? "Loading..." : "Refresh";
  gamesList.classList.toggle("is-loading", isBusy && hasRenderedGames);
}

function formatKickoff(utcValue) {
  if (!utcValue) return "-";
  const date = new Date(`${utcValue.replace(" ", "T")}Z`);

  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getParticipant(fixture, location) {
  return fixture.participants?.find((team) => team.meta?.location === location);
}

function getPrediction(fixture, typeId) {
  return fixture.predictions?.find((prediction) => prediction.type_id === typeId);
}

function formatPercent(value) {
  return value === null || value === undefined ? "-" : `${Number(value).toFixed(1)}%`;
}

function highestKey(values) {
  const validEntries = Object.entries(values).filter(([, value]) => Number.isFinite(value));
  if (!validEntries.length) return null;

  return validEntries.sort((a, b) => b[1] - a[1])[0][0];
}

function highestKeys(values) {
  const validEntries = Object.entries(values).filter(([, value]) => Number.isFinite(value));
  if (!validEntries.length) return new Set();

  const max = Math.max(...validEntries.map(([, value]) => value));
  return new Set(validEntries.filter(([, value]) => value === max).map(([key]) => key));
}

function bestClass(bestKeys, key) {
  return bestKeys.has(key) ? " market-best" : "";
}

function renderResultMarket(prediction) {
  const values = prediction?.predictions || {};
  const bestKeys = highestKeys({
    home: values.home,
    draw: values.draw,
    away: values.away,
  });

  return `
    <div class="market-values result-values">
      <span class="${bestClass(bestKeys, "home")}"><strong>H</strong>${formatPercent(values.home)}</span>
      <span class="${bestClass(bestKeys, "draw")}"><strong>D</strong>${formatPercent(values.draw)}</span>
      <span class="${bestClass(bestKeys, "away")}"><strong>A</strong>${formatPercent(values.away)}</span>
    </div>
  `;
}

function renderYesNoMarket(prediction) {
  const labels = yesNoMarketLabels[prediction.type_id];
  const values = prediction.predictions || {};
  const bestKeys = highestKeys({
    yes: values.yes,
    no: values.no,
  });

  return `
    <div class="market-values">
      <span class="${bestClass(bestKeys, "yes")}"><strong>${labels[0]}</strong>${formatPercent(values.yes)}</span>
      <span class="${bestClass(bestKeys, "no")}"><strong>${labels[1]}</strong>${formatPercent(values.no)}</span>
    </div>
  `;
}

function renderMarket(fixture, typeId) {
  const prediction = getPrediction(fixture, typeId);

  if (!prediction) {
    return `
      <div class="market">
        <span class="market-name">${marketLabels[typeId]}</span>
        <div class="empty-market">No prediction</div>
      </div>
    `;
  }

  return `
    <div class="market">
      <span class="market-name">${marketLabels[typeId]}</span>
      ${typeId === 237 ? renderResultMarket(prediction) : renderYesNoMarket(prediction)}
    </div>
  `;
}

function scoreResult(homeGoals, awayGoals) {
  if (homeGoals > awayGoals) return "home";
  if (awayGoals > homeGoals) return "away";
  return "draw";
}

function scoreOutcomeForMarket(homeGoals, awayGoals, typeId) {
  const totalGoals = homeGoals + awayGoals;

  if (typeId === 237) return scoreResult(homeGoals, awayGoals);
  if (typeId === 235) return totalGoals > 2.5 ? "yes" : "no";
  if (typeId === 236) return totalGoals > 3.5 ? "yes" : "no";
  if (typeId === 231) return homeGoals > 0 && awayGoals > 0 ? "yes" : "no";

  return null;
}

function selectedMarketOutcome(fixture, typeId) {
  const prediction = getPrediction(fixture, typeId);
  const values = prediction?.predictions || {};

  if (typeId === 237) {
    return highestKey({
      home: values.home,
      draw: values.draw,
      away: values.away,
    });
  }

  return highestKey({
    yes: values.yes,
    no: values.no,
  });
}

function predictedScoreForFixture(fixture) {
  const selectedOutcomes = Object.fromEntries(
    marketOrder.map((typeId) => [typeId, selectedMarketOutcome(fixture, typeId)]),
  );
  const candidates = [];

  for (let homeGoals = 0; homeGoals <= 5; homeGoals += 1) {
    for (let awayGoals = 0; awayGoals <= 5; awayGoals += 1) {
      const matches = marketOrder.reduce((total, typeId) => {
        if (!selectedOutcomes[typeId]) return total;
        return total + (scoreOutcomeForMarket(homeGoals, awayGoals, typeId) === selectedOutcomes[typeId] ? 1 : 0);
      }, 0);
      const totalGoals = homeGoals + awayGoals;
      const scoreShapePenalty = Math.abs(totalGoals - 2.4) * 0.08 + Math.abs(homeGoals - awayGoals) * 0.03;

      candidates.push({
        homeGoals,
        awayGoals,
        matches,
        rank: matches - scoreShapePenalty,
      });
    }
  }

  return candidates.sort((a, b) => b.rank - a.rank)[0];
}

function renderPredictedScore(fixture) {
  const score = predictedScoreForFixture(fixture);

  return `
    <div class="predicted-score" aria-label="Predicted score">
      <span>Predicted score</span>
      <strong>${score.homeGoals}-${score.awayGoals}</strong>
      <small>${score.matches}/4 markets matched</small>
    </div>
  `;
}

function renderGame(fixture) {
  const home = getParticipant(fixture, "home");
  const away = getParticipant(fixture, "away");

  return `
    <article class="game-card">
      <div class="game-main">
        <div class="kickoff">
          <strong>${formatKickoff(fixture.starting_at)}</strong>
          <span>${fixture.league?.name || "League unavailable"}</span>
        </div>
        <div class="teams">
          <div class="team-row">
            <img src="${home?.image_path || ""}" alt="" />
            <strong>${home?.name || "Home"}</strong>
          </div>
          <div class="team-row">
            <img src="${away?.image_path || ""}" alt="" />
            <strong>${away?.name || "Away"}</strong>
          </div>
        </div>
      </div>
      <div class="markets">
        ${marketOrder.map((typeId) => renderMarket(fixture, typeId)).join("")}
      </div>
      ${renderPredictedScore(fixture)}
    </article>
  `;
}

function renderGames(fixtures) {
  if (!fixtures.length) {
    gamesList.innerHTML = `
      <div class="empty-state">
        <strong>No upcoming games found</strong>
        <span>Try a longer look-ahead range or check your subscribed leagues.</span>
      </div>
    `;
    return;
  }

  gamesList.innerHTML = fixtures.map(renderGame).join("");
}

async function loadUpcomingGames() {
  if (isLoading) return;

  setLoadingState(true);
  setStatus("Loading today's games...");

  if (!hasRenderedGames) {
    gamesList.innerHTML = `
      <div class="empty-state">
        <strong>Loading today's games</strong>
        <span>Fetching J1 and J2/J3 fixtures with predictions from SportsMonk.</span>
      </div>
    `;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);

  try {
    const response = await fetch("/api/today", {
      signal: controller.signal,
    });
    const payload = await response.json();

    if (!response.ok || payload.message) {
      throw new Error(payload.message || "Could not load upcoming games.");
    }

    renderGames(payload.data || []);
    hasRenderedGames = true;
    const cacheLabel = payload.cache?.hit ? " Cached." : "";
    setStatus(
      `Updated ${payload.data?.length || 0} games. Rate limit remaining: ${
        payload.rate_limit?.remaining ?? "unknown"
      }.${cacheLabel}`,
    );
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("Refresh took too long. Try again in a moment.");
    }

    throw error;
  } finally {
    clearTimeout(timeout);
    setLoadingState(false);
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  try {
    await loadUpcomingGames();
  } catch (error) {
    setStatus(error.message, true);
  }
});

loadUpcomingGames().catch((error) => setStatus(error.message, true));
