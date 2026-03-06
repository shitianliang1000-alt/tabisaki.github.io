const providers = [
  { name: "Open-Meteo (Best Match)", model: "best_match" },
  { name: "気象庁モデル (JMA MSM)", model: "jma_msm" },
  { name: "米国モデル (GFS)", model: "gfs_seamless" },
];

const weatherCodeMap = {
  0: "快晴",
  1: "晴れ",
  2: "薄曇り",
  3: "曇り",
  45: "霧",
  48: "着氷性の霧",
  51: "弱い霧雨",
  53: "霧雨",
  55: "強い霧雨",
  61: "弱い雨",
  63: "雨",
  65: "強い雨",
  71: "弱い雪",
  73: "雪",
  75: "強い雪",
  80: "にわか雨",
  81: "にわか雨",
  82: "激しいにわか雨",
  95: "雷雨",
};

const cityInput = document.getElementById("city");
const searchBtn = document.getElementById("searchBtn");
const statusElm = document.getElementById("status");
const resultsElm = document.getElementById("results");
const locationInfoElm = document.getElementById("locationInfo");
const cardTemplate = document.getElementById("cardTemplate");

searchBtn.addEventListener("click", runComparison);
cityInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    runComparison();
  }
});

async function runComparison() {
  const city = cityInput.value.trim();
  if (!city) {
    setStatus("都市名を入力してください。", true);
    return;
  }

  setStatus("都市情報を取得中...");
  resultsElm.innerHTML = "";

  try {
    const location = await geocodeCity(city);
    locationInfoElm.textContent = `対象: ${location.name} (${location.latitude.toFixed(2)}, ${location.longitude.toFixed(2)})`;

    setStatus("各社予報を取得中...");

    const forecasts = await Promise.all(
      providers.map(async (provider) => {
        try {
          const data = await fetchForecast(location, provider.model);
          return {
            provider: provider.name,
            rows: convertDailyData(data.daily),
            error: null,
          };
        } catch {
          return {
            provider: provider.name,
            rows: [],
            error: "データ取得に失敗しました",
          };
        }
      })
    );

    renderForecasts(forecasts);
    setStatus("比較結果を表示しました。");
  } catch (error) {
    locationInfoElm.textContent = "";
    setStatus(error.message || "予期しないエラーが発生しました。", true);
  }
}

async function geocodeCity(city) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1&language=ja&format=json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("都市情報の取得に失敗しました。");
  }

  const data = await response.json();
  if (!data.results || data.results.length === 0) {
    throw new Error("都市が見つかりませんでした。別の都市名でお試しください。");
  }

  return data.results[0];
}

async function fetchForecast(location, model) {
  const params = new URLSearchParams({
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: "Asia/Tokyo",
    forecast_days: "3",
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max",
    models: model,
  });

  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`);
  if (!response.ok) {
    throw new Error("予報取得エラー");
  }

  return response.json();
}

function convertDailyData(daily) {
  return daily.time.map((date, index) => ({
    date,
    weather: weatherCodeMap[daily.weather_code[index]] || `コード ${daily.weather_code[index]}`,
    tempMax: daily.temperature_2m_max[index],
    tempMin: daily.temperature_2m_min[index],
    precip: daily.precipitation_probability_max[index],
  }));
}

function renderForecasts(forecasts) {
  resultsElm.innerHTML = "";

  forecasts.forEach((forecast) => {
    const card = cardTemplate.content.firstElementChild.cloneNode(true);
    card.querySelector(".provider").textContent = forecast.provider;
    const tbody = card.querySelector("tbody");

    if (forecast.error) {
      const row = document.createElement("tr");
      row.innerHTML = `<td colspan="4">${forecast.error}</td>`;
      tbody.appendChild(row);
    } else {
      forecast.rows.forEach((rowData) => {
        const row = document.createElement("tr");
        row.innerHTML = `
          <td>${rowData.date}</td>
          <td>${rowData.weather}</td>
          <td>${Math.round(rowData.tempMax)}℃ / ${Math.round(rowData.tempMin)}℃</td>
          <td>${rowData.precip}%</td>
        `;
        tbody.appendChild(row);
      });
    }

    resultsElm.appendChild(card);
  });
}

function setStatus(message, isError = false) {
  statusElm.textContent = message;
  statusElm.style.color = isError ? "#d64545" : "#102a43";
}

runComparison();
