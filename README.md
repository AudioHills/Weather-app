# Weather

A sleek, hyper-local weather web app built for iPhone. Open it in Safari, tap **Share → Add to Home Screen**, and it runs full-screen like a native app.

No build step, no API keys, no tracking. It's just static files.

## What's in it

- **Precise GPS location**, named down to the neighborhood, with accuracy shown
- **Next 3 hours of precipitation in 15-minute steps**, e.g. "Rain starting in about 20 min" (uses the HRRR 3 km model in the US)
- **Animated radar**:
  - Canada (default): Environment and Climate Change Canada's official 1 km radar composite. It updates every 6 minutes, switches to its snow product when it's freezing, and also covers US radars near the border.
  - US: NOAA NEXRAD.
  - Rest of the world: RainViewer.
  - Tap the source tag to switch sources. Warning areas are drawn on the map. Tap the map to go full-screen and pinch to zoom.
- **Weather alerts**: Environment Canada warnings (Canada) or National Weather Service alerts (US)
- **Latest observation**: Environment Canada's current conditions for the nearest city, or the closest NWS station in the US
- **Forecaster notes**: Environment Canada or NWS text forecast for your area
- 30-hour temperature curve with icons, precipitation chances and sunrise/sunset markers; 10-day forecast as temperature-range columns (tap a day for details)
- Wind compass, feels-like, UV (with "use sun protection until…"), air quality (US AQI, PM2.5, ozone), humidity and dew point, visibility, pressure trend, rainfall totals, sun arc, moon phase
- Background and animated rain, snow or stars that match the current conditions
- Saved locations with live temperatures, city and ZIP search, °F/°C toggle
- Pull to refresh, auto-refresh, and works offline with the last update

## Hosting (needed for "Add to Home Screen")

Location access requires HTTPS, so host it somewhere. The simplest option is GitHub Pages:

1. Repo **Settings → Pages**
2. **Source:** "Deploy from a branch", **Branch:** `main`, folder `/ (root)`, then **Save**
3. After about a minute, open `https://<user>.github.io/<repo>/` on your iPhone in Safari, then **Share → Add to Home Screen**

Any static host works (Netlify, Cloudflare Pages, Vercel): just drop the folder in.

To run it locally: `python3 -m http.server` and open http://localhost:8000. Geolocation works on localhost.

## Data sources (all free, no keys)

| What | Source |
|---|---|
| Forecast, 15-min nowcast, air quality, place search | [Open-Meteo](https://open-meteo.com) |
| Canadian radar, alerts, observations, forecast text | [ECCC MSC GeoMet](https://eccc-msc.github.io/open-data/) (`geo.weather.gc.ca`, `api.weather.gc.ca`) |
| Alerts, station observations, forecaster text (US) | [NWS api.weather.gov](https://www.weather.gov/documentation/services-web-api) |
| US radar | NOAA NEXRAD via [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu) |
| Global radar | [RainViewer](https://www.rainviewer.com/api.html) |
| Neighborhood names | BigDataCloud reverse geocoding |
| Base map | [OpenFreeMap](https://openfreemap.org) vector tiles, © OpenMapTiles, © OpenStreetMap |

## Files

```
index.html            app shell and iOS home-screen meta tags
css/app.css           styles
js/app.js             all app logic
sw.js                 service worker (offline app shell)
manifest.webmanifest  PWA manifest
icons/                app icons
vendor/maplibre/      MapLibre GL JS 4.7.1 (map library)
fonts/                Space Grotesk + JetBrains Mono
```
