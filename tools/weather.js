/**
 * tools/weather.js
 * Level 1 (SAFE) — read-only network fetch.
 *
 * Uses Open-Meteo (https://open-meteo.com), which is free and requires
 * no API key: first geocode the place name, then pull current conditions.
 */

const fetch = require('node-fetch');

// WMO weather interpretation codes -> human readable text
const WMO_CODES = {
  0: 'clear sky', 1: 'mainly clear', 2: 'partly cloudy', 3: 'overcast',
  45: 'fog', 48: 'depositing rime fog',
  51: 'light drizzle', 53: 'moderate drizzle', 55: 'dense drizzle',
  56: 'light freezing drizzle', 57: 'dense freezing drizzle',
  61: 'slight rain', 63: 'moderate rain', 65: 'heavy rain',
  66: 'light freezing rain', 67: 'heavy freezing rain',
  71: 'slight snow fall', 73: 'moderate snow fall', 75: 'heavy snow fall',
  77: 'snow grains',
  80: 'slight rain showers', 81: 'moderate rain showers', 82: 'violent rain showers',
  85: 'slight snow showers', 86: 'heavy snow showers',
  95: 'thunderstorm', 96: 'thunderstorm with slight hail', 99: 'thunderstorm with heavy hail',
};

const definition = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: 'Get current weather conditions for a named city or location.',
    parameters: {
      type: 'object',
      properties: {
        location: {
          type: 'string',
          description: 'City name, optionally with country, e.g. "Bridgwater, UK" or "Tokyo"',
        },
        units: {
          type: 'string',
          enum: ['celsius', 'fahrenheit'],
          description: 'Temperature unit to report in. Defaults to celsius.',
        },
      },
      required: ['location'],
    },
  },
};

async function execute(args) {
  const location = args.location;
  const useFahrenheit = args.units === 'fahrenheit';

  try {
    const geoRes = await fetch(
      `https://geocoding-api.open-meteo.com/v1/search?count=1&language=en&format=json&name=${encodeURIComponent(location)}`
    );
    if (!geoRes.ok) throw new Error(`Geocoding request failed (${geoRes.status})`);
    const geoData = await geoRes.json();

    if (!geoData.results || geoData.results.length === 0) {
      return { ok: false, error: `Could not find a location matching "${location}"` };
    }

    const place = geoData.results[0];
    const tempUnit = useFahrenheit ? '&temperature_unit=fahrenheit' : '';
    const windUnit = useFahrenheit ? '&wind_speed_unit=mph' : '';

    const forecastRes = await fetch(
      `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&current=temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m` +
      `&timezone=auto${tempUnit}${windUnit}`
    );
    if (!forecastRes.ok) throw new Error(`Forecast request failed (${forecastRes.status})`);
    const forecastData = await forecastRes.json();
    const current = forecastData.current;

    return {
      ok: true,
      location: [place.name, place.admin1, place.country].filter(Boolean).join(', '),
      temperature: current.temperature_2m,
      feels_like: current.apparent_temperature,
      humidity_percent: current.relative_humidity_2m,
      precipitation_mm: current.precipitation,
      wind_speed: current.wind_speed_10m,
      unit: useFahrenheit ? 'F' : 'C',
      conditions: WMO_CODES[current.weather_code] || 'unknown',
      local_time: current.time,
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

module.exports = {
  level: 1,
  definition,
  execute,
  softConfirm: false,
};
