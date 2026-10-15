# Fleeto ride score prototype

A phone web app that reads GPS and motion sensors during a two-wheeler ride and gives a 0-100 safety score with a per-behaviour breakdown. Everything stays on the phone (browser storage). Version 0.1, 2026-10-15.

Live app (open on your phone): https://ianbaswana.github.io/fleeto-ride-score/

The `gh-pages` branch holds a copy of `app/`. Update it after changing `app/` (see below).

## Run it on a phone

GPS and motion sensors only work on an **https** page. GitHub Pages serves the `gh-pages` branch. To publish a change: copy the contents of `app/` to the root of `gh-pages` and push. Other static hosts also work:

- **Netlify Drop:** unzip `fleeto-ride-score-app.zip` (it has `index.html` at the top), open https://app.netlify.com/drop on a laptop, drag the unzipped folder in, open the https link it gives on the phone. If Netlify says "Not Found", the folder you dragged has `index.html` one level down: drag that inner folder, or add the folder name to the link (for example `/app/`).
- **GitHub Pages:** push `app/` to a public repo, turn on Pages for it.
- **Local test:** `npx http-server app` and open `http://localhost:8080` (localhost counts as secure; a phone on the same Wi-Fi does not).

On the phone: Chrome (Android) or Safari (iPhone). Allow location and motion. Mount the phone, keep the screen on, tap Start ride. "Add to home screen" installs it like an app.

## Files

| File | What it does |
|---|---|
| `app/roads.js` | Road speed limits from OpenStreetMap (Overpass API, no key): downloads roads around the rider, matches each GPS fix to a road, reads its limit. |
| `app/scoring.js` | All detection and scoring rules. No browser code. Thresholds and weights are in `CONFIG` and `COMPONENTS` at the top. |
| `app/app.js` | Reads sensors (geolocation, devicemotion, wake lock), feeds the analyzer, draws the screens. The ride summary shows the route on an OpenStreetMap street map (Leaflet), with Google Maps links for each event. |
| `app/sim.js` | Synthetic 15-minute ride with five planted events, for the demo and the test. |
| `app/index.html`, `style.css` | Screens and styles. |
| `app/sw.js`, `manifest.webmanifest`, `icon.svg` | Installable app and offline cache. |
| `test/demo-ride.test.js` | `node test/demo-ride.test.js`: checks that each planted event is found once. |
| `test/roads.test.js` | `node test/roads.test.js`: checks limit parsing, road matching and the road-data loader with sample roads. |
| `build-preview.js` | Builds the single-file preview page for Claude. |

## Testing features

- **Spoken alerts:** during a ride the phone beeps and says the event ("Harsh brake", "Over 50"). Turn it off on the home screen.
- **Sensor log (CSV):** one row per GPS fix with speed, accuracy, heading, speed change and sideways acceleration, plus the events found at that moment. Open it in Google Sheets to tune thresholds. Only the 5 newest rides keep a log.
- **Share score:** opens the phone's share sheet (WhatsApp etc.) with the ride score and event counts.
- **GPS-lost warning:** the summary says how long GPS was lost, for example when the screen locked.

## How the score works

Each behaviour gets a score from 0 to 100. The ride score is the weighted average. **All thresholds and weights are placeholders.**

| Behaviour | Weight | Signal | Rule |
|---|---|---|---|
| Speeding | 25% | GPS speed vs the current road's limit (see below) | 100 − 2 × % time over limit − 4 × % time over limit + 20 |
| Harsh braking | 20% | GPS speed drop over 2 s ≥ 3.0 m/s² | 100 − 15 per event per 10 km |
| Sharp cornering | 15% | speed × GPS heading change rate ≥ 3.5 m/s² | 100 − 15 per event per 10 km |
| Phone use | 15% | phone tilted ≥ 35° from mount position for 2 s, screen touch, or app switch, above 10 km/h | 100 − 15 per event per riding hour |
| Harsh acceleration | 10% | GPS speed gain over 2 s ≥ 2.5 m/s² | 100 − 10 per event per 10 km |
| Night riding | 7.5% | share of riding time 22:00-05:00 | 100 − 0.5 × % night time |
| Long riding without a break | 7.5% | longest stretch without a 15-min stop | 100 − 20 per 30 min beyond 120 min |

Rides under 1 km are marked as too short to judge. Per-10-km rates use at least 2 km, per-hour rates at least 0.5 h.

## Road speed limits

With "Use road speed limits" on (the default), the app downloads the roads around the rider from OpenStreetMap through the free Overpass API, in boxes about 1.5 km wide. It matches each GPS fix to the nearest road within 30 m, preferring roads that run in the direction of travel. The limit comes from, in order:

1. the road's posted limit in OpenStreetMap (`maxspeed:motorcycle`, then `maxspeed`),
2. a typical two-wheeler limit for that road type (PLACEHOLDERS in `TYPE_LIMITS` in `roads.js`: for example main road 60, secondary 50, residential 30),
3. the fallback limit in settings, where no road is found or the data has not loaded.

The ride summary says how much riding time used each source. Only the map area is sent to Overpass, never the GPS track.

## Known limits

- A web page stops getting GPS when the screen locks or the rider switches apps. A real rider app needs a native Android foreground service.
- Few Indian roads have a posted limit in OpenStreetMap, so most limits will be the typical value for the road type.
- Road matching is 2D: on a flyover it may pick the road underneath, and the other way round.
- Overpass is a free public service with rate limits. A real product needs its own road database or a paid speed-limit API.
- GPS at 1 Hz smooths out short, sharp events. Harsh-event counts are likely under-counted.
- Phone tilt detection assumes a firm mount. A loose mount gives false phone-use events.
- No calibration yet. Next step: record calibration rides with known events and tune `CONFIG`.
