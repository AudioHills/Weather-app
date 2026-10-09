# Weather

A sleek, hyper-local weather web app built for iPhone. Open it in Safari, tap **Share → Add to Home Screen**, and it runs full-screen like a native app.

No build step, no API keys, no tracking. It's just static files.

## What's in it

- **Precise GPS location**, named down to the neighborhood, with accuracy shown
- **Next 3 hours of precipitation in 15-minute steps**, e.g. "Rain starting in about 20 min" (uses the HRRR 3 km model in the US)
- **Animated radar**: NOAA NEXRAD (US, high-res) or RainViewer (rest of the world), with NWS warning polygons. Tap to go full-screen, pinch to zoom.
- **Severe weather alerts** from the National Weather Service
- **Nearest weather station**: live observation from the closest NWS station, with distance and age
- **Forecaster notes**: the NWS text forecast for your exact grid point
- 30-hour hourly forecast with sunrise and sunset markers; 10-day forecast (tap a day for details)
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
| Alerts, station observations, forecaster text (US) | [NWS api.weather.gov](https://www.weather.gov/documentation/services-web-api) |
| US radar | NOAA NEXRAD via [Iowa Environmental Mesonet](https://mesonet.agron.iastate.edu) |
| Global radar | [RainViewer](https://www.rainviewer.com/api.html) |
| Neighborhood names | BigDataCloud reverse geocoding |
| Base map | © OpenStreetMap, © CARTO |

## Files

```
index.html            app shell and iOS home-screen meta tags
css/app.css           styles
js/app.js             all app logic
sw.js                 service worker (offline app shell)
manifest.webmanifest  PWA manifest
icons/                app icons
vendor/leaflet/       Leaflet 1.9.4 (map library)
```
