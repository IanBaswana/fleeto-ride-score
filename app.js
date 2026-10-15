/*
 * Fleeto ride safety score: sensors and screens.
 * Scoring rules live in scoring.js. This file only reads sensors,
 * feeds the RideAnalyzer, and draws the three screens.
 */
(function () {
  "use strict";

  const { RideAnalyzer, CONFIG, COMPONENTS, scoreRide } = window.RideScore;
  const $ = (id) => document.getElementById(id);

  const STORE_KEY = "fleeto.rides.v1";
  const LIMIT_KEY = "fleeto.limit.v1";
  const VOICE_KEY = "fleeto.voice.v1";
  const RIDES_WITH_LOG = 5; // keep the full sensor log only for the newest rides, to stay within browser storage
  const MAX_SAVED_RIDES = 20;
  const DEMO_SPEEDUP = 30;
  // Set by the build for the preview page, so it can point to the phone version.
  const PHONE_APP_URL = window.FLEETO_PHONE_APP_URL || "";

  const EVENT_INFO = {
    braking: { letter: "B", name: "Harsh brake" },
    acceleration: { letter: "A", name: "Harsh start" },
    cornering: { letter: "C", name: "Sharp corner" },
    speeding: { letter: "S", name: "Speeding" },
    phone: { letter: "P", name: "Phone use" },
  };

  let inFrame;
  try { inFrame = window.self !== window.top; } catch (e) { inFrame = true; }

  let ride = null; // the ride in progress, see beginRide()

  // ---------- Storage (this phone only) ----------

  function loadRides() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY)) || []; } catch (e) { return []; }
  }
  function saveRide(result) {
    const rides = [result, ...loadRides()].slice(0, MAX_SAVED_RIDES);
    const withoutLog = (r) => { const { log, ...rest } = r; return rest; };
    // Try to keep logs for the newest rides; if storage is full, keep fewer.
    for (const keep of [RIDES_WITH_LOG, 1, 0]) {
      try {
        localStorage.setItem(STORE_KEY, JSON.stringify(rides.map((r, i) => (i < keep ? r : withoutLog(r)))));
        return;
      } catch (e) { /* storage full or blocked: try with fewer logs */ }
    }
  }
  function readLimit() {
    const v = Number($("limitInput").value);
    return v >= 20 && v <= 120 ? v : CONFIG.speedLimitKmh;
  }

  // ---------- Formatting ----------

  const pad2 = (n) => String(n).padStart(2, "0");
  function fmtDuration(s) {
    s = Math.max(0, Math.round(s));
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return h ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
  }
  function fmtDate(t) {
    return new Date(t).toLocaleString("en-IN", { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }
  const bandClass = (score) => "band-" + (score.band ? score.band.key : "none");
  const bandColor = (score) => `var(--${score.band ? score.band.key : "muted"})`;

  function setChip(el, text, level) {
    el.textContent = text;
    el.className = "chip" + (level ? " " + level : "");
  }

  function show(screen) {
    for (const id of ["home", "ride", "summary"]) $(id).hidden = id !== screen;
    window.scrollTo(0, 0);
  }

  // ---------- Home ----------

  function renderHome() {
    const limit = readLimit();
    const rules = scoreRide({ distanceKm: 0, movingMin: 0, longestContinuousMin: 0, pctOverLimit: 0, pctSevere: 0,
      pctNight: 0, harshBrakes: 0, harshAccels: 0, harshCorners: 0, phoneEvents: 0, motionAvailable: true },
      { speedLimitKmh: limit });
    $("rulesList").replaceChildren(...rules.components.map((c) => {
      const li = document.createElement("li");
      li.innerHTML = `<span></span><span class="w">${c.weight}%</span><span class="r"></span>`;
      li.children[0].textContent = c.label;
      li.children[2].textContent = c.rule;
      return li;
    }));

    const rides = loadRides();
    $("noRides").hidden = rides.length > 0;
    $("rideList").replaceChildren(...rides.map((r) => {
      const li = document.createElement("li");
      const b = document.createElement("button");
      b.type = "button";
      b.className = "ride-item";
      const s = r.score;
      b.innerHTML = `<span><b></b><br><span class="muted small num"></span></span><span class="score-chip ${bandClass(s)}"></span>`;
      b.querySelector("b").textContent = (r.mode === "demo" ? "Demo ride · " : "") + (r.stats.startT ? fmtDate(r.stats.startT) : "Ride");
      b.querySelector(".muted").textContent = `${r.stats.distanceKm.toFixed(1)} km · ${Math.round(r.stats.movingMin)} min riding`;
      b.querySelector(".score-chip").textContent = s.overall == null ? "–" : s.overall;
      b.addEventListener("click", () => renderSummary(r));
      li.append(b);
      return li;
    }));

    const n = $("sensorNotice");
    if (inFrame) {
      n.hidden = false;
      n.innerHTML = "<b>This preview cannot read GPS or motion sensors.</b> Play the demo ride to see how scoring works. For a real ride, open the phone version of this app.";
      if (PHONE_APP_URL) {
        const a = document.createElement("a");
        a.href = PHONE_APP_URL; a.target = "_blank"; a.rel = "noopener"; a.textContent = " Open the phone version.";
        n.append(a);
      }
    } else if (!window.isSecureContext || !("geolocation" in navigator)) {
      n.hidden = false;
      n.textContent = "GPS needs a secure (https) page. Open this app from its https link, not from a file.";
    } else {
      n.hidden = true;
    }
    $("limitSign").textContent = limit;
    show("home");
  }

  // ---------- Spoken alerts ----------

  let audioCtx = null;
  function beep() {
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = 880;
      g.gain.value = 0.15;
      o.connect(g).connect(audioCtx.destination);
      o.start();
      o.stop(audioCtx.currentTime + 0.2);
    } catch (e) { /* no audio on this device */ }
  }
  // Short beep, then the words. Browsers allow sound only after a tap, so the first call is on Start.
  function say(text) {
    if (!$("voiceInput").checked) return;
    beep();
    try {
      if (!("speechSynthesis" in window)) return;
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "en-IN";
      u.rate = 1.05;
      speechSynthesis.speak(u);
    } catch (e) { /* speech not supported */ }
  }

  // ---------- Ride (live and demo share this) ----------

  function beginRide(mode) {
    ride = {
      mode,
      analyzer: new RideAnalyzer({ speedLimitKmh: readLimit() }),
      startT: Date.now(),
      clockT: Date.now(),
      shownEvents: 0,
      wasOver: false,
      lastOverSayT: 0,
      gotMotion: false,
      lastMotionT: 0,
      timers: [],
      watchId: null,
      wakeLock: null,
    };
    $("limitSign").textContent = ride.analyzer.cfg.speedLimitKmh;
    $("feed").replaceChildren();
    $("rideNotice").hidden = true;
    $("demoChip").hidden = mode !== "demo";
    $("skipBtn").hidden = mode !== "demo";
    setChip($("gpsChip"), mode === "demo" ? "GPS: simulated" : "GPS: searching", mode === "demo" ? "ok" : "");
    setChip($("motionChip"), mode === "demo" ? "Motion: simulated" : "Motion: waiting", mode === "demo" ? "ok" : "");
    setChip($("wakeChip"), "Screen: –", "");
    show("ride");
    renderLive();
    return ride;
  }

  async function startLive() {
    // iPhone asks for motion permission, and only inside a tap.
    let motionOk = "DeviceMotionEvent" in window;
    if (motionOk && typeof DeviceMotionEvent.requestPermission === "function") {
      try { motionOk = (await DeviceMotionEvent.requestPermission()) === "granted"; } catch (e) { motionOk = false; }
    }
    const r = beginRide("live");
    say("Ride started");

    if ("geolocation" in navigator) {
      r.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError,
        { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
    } else {
      rideError("This browser cannot read GPS.");
    }

    if (motionOk) {
      window.addEventListener("devicemotion", onMotion);
      r.timers.push(setTimeout(() => {
        if (ride === r && !r.gotMotion) setChip($("motionChip"), "Motion: no data", "warn");
      }, 4000));
    } else {
      setChip($("motionChip"), "Motion: not allowed", "warn");
    }

    document.addEventListener("pointerdown", onTouch, true);
    document.addEventListener("visibilitychange", onVisibility);
    r.timers.push(setInterval(renderClock, 1000));
    requestWakeLock();
  }

  function onPosition(p) {
    if (!ride || ride.mode !== "live") return;
    const c = p.coords;
    ride.analyzer.addFix({ t: p.timestamp, lat: c.latitude, lon: c.longitude, speed: c.speed, heading: c.heading, accuracy: c.accuracy });
    const acc = Math.round(c.accuracy);
    setChip($("gpsChip"), `GPS: ±${acc} m`, acc <= CONFIG.maxFixAccuracyM ? "ok" : "warn");
    $("r-acc").textContent = `±${acc} m`;
    renderLive();
  }

  function onGeoError(e) {
    if (!ride) return;
    if (e.code === 1) {
      setChip($("gpsChip"), "GPS: blocked", "bad");
      rideError(inFrame
        ? "This preview blocks GPS. Stop this ride and play the demo, or open the phone version of the app."
        : "Location is blocked for this site. Allow location in the browser's site settings, then start a new ride.");
    } else if (e.code === 2) {
      setChip($("gpsChip"), "GPS: no signal", "warn");
    } else {
      setChip($("gpsChip"), "GPS: searching", "warn");
    }
  }

  function onMotion(e) {
    if (!ride) return;
    const now = Date.now();
    if (now - ride.lastMotionT < 50) return; // about 20 samples per second is enough
    ride.lastMotionT = now;
    const g = e.accelerationIncludingGravity, a = e.acceleration, r = e.rotationRate;
    if (!g || g.x == null) return;
    if (!ride.gotMotion) { ride.gotMotion = true; setChip($("motionChip"), "Motion: on", "ok"); }
    ride.analyzer.addMotion({
      t: now, gx: g.x, gy: g.y, gz: g.z,
      ax: a && a.x != null ? a.x : null, ay: a && a.y, az: a && a.z,
      rotation: r && r.alpha != null ? Math.hypot(r.alpha, r.beta, r.gamma) : null,
    });
  }

  function onTouch(e) {
    if (!ride || ride.mode !== "live") return;
    if (e.target.closest && e.target.closest(".stopbar")) return; // tapping Stop is not phone use
    ride.analyzer.addTouch(Date.now());
    renderLive();
  }

  function onVisibility() {
    if (!ride) return;
    if (document.visibilityState === "hidden") ride.analyzer.addAppHidden(Date.now());
    else requestWakeLock();
  }

  async function requestWakeLock() {
    if (!ride || ride.mode !== "live") return;
    if (!("wakeLock" in navigator)) { setChip($("wakeChip"), "Screen: may lock", "warn"); return; }
    try {
      ride.wakeLock = await navigator.wakeLock.request("screen");
      setChip($("wakeChip"), "Screen: kept on", "ok");
    } catch (e) {
      setChip($("wakeChip"), "Screen: may lock", "warn");
    }
  }

  function rideError(msg) {
    $("rideNotice").textContent = msg;
    $("rideNotice").hidden = false;
  }

  function startDemo() {
    const durationGuessMs = 15 * 60 * 1000;
    const data = window.RideSim.generateDemoRide(Date.now() - durationGuessMs);
    const r = beginRide("demo");
    say("Demo ride started");
    r.demo = { data, fi: 0, mi: 0, simT: data.fixes[0].t - 1000 };
    r.startT = data.fixes[0].t;
    r.timers.push(setInterval(() => stepDemo(100 * DEMO_SPEEDUP), 100));
  }

  // Feed the simulated sensors up to the new simulated time.
  function stepDemo(advanceMs) {
    const d = ride && ride.demo;
    if (!d) return;
    d.simT += advanceMs;
    const { fixes, motion } = d.data;
    while (d.fi < fixes.length && fixes[d.fi].t <= d.simT) {
      while (d.mi < motion.length && motion[d.mi].t <= fixes[d.fi].t) ride.analyzer.addMotion(motion[d.mi++]);
      ride.analyzer.addFix(fixes[d.fi++]);
    }
    ride.clockT = Math.min(d.simT, fixes[fixes.length - 1].t);
    renderLive();
    if (d.fi >= fixes.length) stopRide();
  }

  function renderClock() {
    if (!ride) return;
    if (ride.mode === "live") ride.clockT = Date.now();
    $("timeNow").textContent = fmtDuration((ride.clockT - ride.startT) / 1000);
  }

  function renderLive() {
    if (!ride) return;
    const { stats, score, live } = ride.analyzer.snapshot();
    $("speedNow").textContent = Math.round(live.kmh);
    $("speedBox").classList.toggle("over", live.overLimit);
    renderClock();
    $("distNow").textContent = `${stats.distanceKm.toFixed(1)} km`;
    $("scoreNow").textContent = stats.distanceKm >= 0.2 && score.overall != null ? score.overall : "–";

    const counts = { braking: stats.harshBrakes, acceleration: stats.harshAccels, cornering: stats.harshCorners,
      speeding: stats.speedingEpisodes, phone: stats.phoneEvents };
    for (const k in counts) {
      const el = $("c-" + k);
      el.querySelector("b").textContent = counts[k];
      el.classList.toggle("hit", counts[k] > 0);
    }

    $("r-accel").textContent = `${live.accelMs2 >= 0 ? "+" : ""}${live.accelMs2.toFixed(1)} m/s²`;
    $("r-lat").textContent = `${live.lateralMs2.toFixed(1)} m/s²`;
    $("r-motion").textContent = ride.mode === "live" && !ride.gotMotion ? "–" : `${live.motionAccel.toFixed(1)} m/s²`;
    $("r-rot").textContent = ride.mode === "live" && !ride.gotMotion ? "–" : `${Math.round(live.rotationDegS)} °/s`;
    $("r-fixes").textContent = `${ride.analyzer.fixes.length} / ${stats.rejectedFixes}`;
    if (ride.mode === "demo") $("r-acc").textContent = "simulated";

    // Speak when the rider goes over the limit (at most every 30 s of ride time).
    if (live.overLimit && !ride.wasOver && ride.clockT - ride.lastOverSayT > 30000) {
      say(`Over ${ride.analyzer.cfg.speedLimitKmh}`);
      ride.lastOverSayT = ride.clockT;
    }
    ride.wasOver = live.overLimit;

    // Newest events first, at most four. Speak each new one (speeding was already announced above).
    const ev = ride.analyzer.events;
    if (ev.length !== ride.shownEvents) {
      const fresh = ev.slice(ride.shownEvents).filter((e) => e.type !== "speeding");
      if (fresh.length) say(fresh.map((e) => EVENT_INFO[e.type].name).join(", "));
      ride.shownEvents = ev.length;
      $("feed").replaceChildren(...ev.slice(-4).reverse().map((e) => eventItem(e, ride.startT)));
    }
  }

  function eventItem(e, startT, withMapLink) {
    const li = document.createElement("li");
    const info = EVENT_INFO[e.type];
    li.innerHTML = `<time class="num"></time><span class="mark"></span><span><b></b> <span class="muted"></span></span>`;
    li.querySelector("time").textContent = fmtDuration((e.t - startT) / 1000);
    li.querySelector(".mark").textContent = info.letter;
    li.querySelector("b").textContent = info.name;
    li.querySelector(".muted").textContent = e.detail;
    if (withMapLink && e.lat != null) {
      const a = document.createElement("a");
      a.className = "gmaps small";
      a.href = googleMapsUrl(e.lat, e.lon);
      a.target = "_blank"; a.rel = "noopener";
      a.textContent = "Map ↗";
      li.append(a);
    }
    return li;
  }

  function stopRide() {
    const r = ride;
    if (!r) return;
    ride = null;
    r.timers.forEach((t) => { clearInterval(t); clearTimeout(t); });
    if (r.watchId != null) navigator.geolocation.clearWatch(r.watchId);
    window.removeEventListener("devicemotion", onMotion);
    document.removeEventListener("pointerdown", onTouch, true);
    document.removeEventListener("visibilitychange", onVisibility);
    if (r.wakeLock) r.wakeLock.release().catch(() => {});

    const result = r.analyzer.finish();
    result.mode = r.mode;
    result.app = "fleeto-ride-score-prototype/0.2";
    if (r.analyzer.fixes.length > 1) saveRide(result);
    renderSummary(result);
  }

  // ---------- Summary ----------

  function renderSummary(r) {
    const s = r.stats, sc = r.score;
    const arcLen = 2 * Math.PI * 54;
    const pct = sc.overall == null ? 0 : sc.overall / 100;
    $("dialArc").setAttribute("stroke-dasharray", `${(arcLen * pct).toFixed(1)} ${arcLen.toFixed(1)}`);
    $("dialArc").style.stroke = bandColor(sc);
    $("dialNum").textContent = sc.overall == null ? "–" : sc.overall;
    $("sumBand").textContent = sc.band ? sc.band.label : "No score";
    $("sumBand").style.color = bandColor(sc);
    $("sumDate").textContent = (r.mode === "demo" ? "Demo ride · " : "") + (s.startT ? fmtDate(s.startT) : "Ride");
    $("sumNote").textContent = !s.startT
      ? "No GPS data was recorded, so there is nothing to score."
      : !sc.enoughData
        ? `Short ride (under ${CONFIG.minRideKm} km). Treat this score as a rough guide only.`
        : `Speed limit used: ${s.speedLimitKmh} km/h.`;
    if (s.gapMin >= 0.5) {
      $("sumNote").textContent += ` GPS was lost for ${Math.round(s.gapMin)} min (screen locked or app in the background), so part of the ride is missing.`;
    }

    $("sumDist").textContent = `${s.distanceKm.toFixed(1)} km`;
    $("sumTime").textContent = fmtDuration(s.movingMin * 60);
    $("sumAvg").textContent = `${Math.round(s.avgMovingKmh)} km/h`;
    $("sumMax").textContent = `${Math.round(s.maxKmh)} km/h`;

    $("compList").replaceChildren(...sc.components.map((c) => {
      const div = document.createElement("div");
      div.className = "comp";
      const color = c.score >= 85 ? "good" : c.score >= 70 ? "fair" : c.score >= 50 ? "risky" : "high";
      div.innerHTML = `<div class="comp-head"><span><span class="lbl"></span> <span class="muted small"></span></span><b class="num"></b></div>
        <div class="bar"><i></i></div><span class="small meas"></span><span class="rule"></span>`;
      div.querySelector(".lbl").textContent = c.label;
      div.querySelector(".muted").textContent = `${c.weight}% of score`;
      div.querySelector("b").textContent = c.available ? c.score : "–";
      const bar = div.querySelector(".bar i");
      bar.style.width = (c.available ? c.score : 0) + "%";
      bar.style.background = `var(--${color})`;
      div.querySelector(".meas").textContent = c.available ? c.measure : "This phone sent no motion data, so this part is left out of the score.";
      div.querySelector(".rule").textContent = c.rule;
      return div;
    }));

    $("eventList").replaceChildren(...r.events.map((e) => eventItem(e, s.startT || e.t, true)));
    $("noEvents").hidden = r.events.length > 0;
    $("exportMsg").hidden = true;
    $("exportBtn").onclick = () => exportRide(r);
    $("csvBtn").onclick = () => exportCsv(r);
    $("shareBtn").onclick = () => shareScore(r);
    show("summary");
    drawMap(r);
  }

  // Opens the spot in the Google Maps app on phones, or google.com/maps on a laptop. No API key needed.
  function googleMapsUrl(lat, lon) {
    return `https://www.google.com/maps/search/?api=1&query=${lat.toFixed(6)},${lon.toFixed(6)}`;
  }

  // Street map (OpenStreetMap tiles via Leaflet). Falls back to the plain canvas drawing
  // when Leaflet did not load (offline) or inside the Claude preview, which blocks map tiles.
  let leafletMap = null;
  function drawMap(r) {
    const pts = r.route || [];
    const useMap = window.L && !inFrame && pts.length >= 2;
    $("routeMap").hidden = !useMap;
    $("routeCanvas").hidden = useMap;
    $("mapHint").hidden = !useMap;
    if (!useMap) { drawRoute(r); return; }

    if (!leafletMap) {
      leafletMap = L.map("routeMap", { zoomControl: true, attributionControl: true, zoomSnap: 0.25 });
      L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(leafletMap);
    }
    if (leafletMap._rideLayer) leafletMap.removeLayer(leafletMap._rideLayer);
    const layer = L.layerGroup().addTo(leafletMap);
    leafletMap._rideLayer = layer;

    const css = getComputedStyle(document.documentElement);
    const col = (name) => css.getPropertyValue(name).trim();
    // One polyline per run of points on the same side of the speed limit.
    let run = [pts[0]];
    const flush = (over) => {
      if (run.length > 1) L.polyline(run.map((p) => [p[0], p[1]]), { color: over ? col("--high") : col("--good"), weight: 6, opacity: 0.9 }).addTo(layer);
    };
    // A segment takes the colour of the speed at its end point, as in the canvas drawing.
    const isOver = (p) => p[2] > r.stats.speedLimitKmh;
    let runOver = isOver(pts[1]);
    for (let i = 1; i < pts.length; i++) {
      if (isOver(pts[i]) !== runOver) { flush(runOver); run = [pts[i - 1]]; runOver = isOver(pts[i]); }
      run.push(pts[i]);
    }
    flush(runOver);

    const marker = (lat, lon, label, cls, title, detail) => {
      const icon = L.divIcon({ className: "", html: `<div class="map-mark ${cls}">${label}</div>`, iconSize: [26, 26], iconAnchor: [13, 13] });
      const m = L.marker([lat, lon], { icon, title }).addTo(layer);
      const box = document.createElement("div");
      const b = document.createElement("b"); b.textContent = title;
      const d = document.createElement("div"); d.textContent = detail || "";
      const a = document.createElement("a");
      a.href = googleMapsUrl(lat, lon); a.target = "_blank"; a.rel = "noopener"; a.textContent = "Open in Google Maps ↗";
      box.append(b, d, a);
      m.bindPopup(box);
    };
    const first = pts[0], last = pts[pts.length - 1];
    marker(first[0], first[1], "▶", "end", "Start", "");
    marker(last[0], last[1], "■", "end", "End", "");
    for (const e of r.events) {
      if (e.lat != null) marker(e.lat, e.lon, EVENT_INFO[e.type].letter, "", EVENT_INFO[e.type].name, e.detail);
    }

    leafletMap.invalidateSize();
    leafletMap.fitBounds(L.latLngBounds(pts.map((p) => [p[0], p[1]])), { paddingTopLeft: [52, 24], paddingBottomRight: [24, 24] });
  }

  function drawRoute(r) {
    const cv = $("routeCanvas");
    const ctx = cv.getContext("2d");
    const css = getComputedStyle(document.documentElement);
    const col = (name) => css.getPropertyValue(name).trim();
    ctx.clearRect(0, 0, cv.width, cv.height);
    const pts = r.route;
    if (!pts || pts.length < 2) {
      ctx.fillStyle = col("--muted");
      ctx.font = "28px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("No route recorded", cv.width / 2, cv.height / 2);
      return;
    }
    // Flat projection is fine at city scale.
    const lat0 = pts[0][0];
    const kx = Math.cos((lat0 * Math.PI) / 180);
    const xs = pts.map((p) => p[1] * kx), ys = pts.map((p) => p[0]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const padPx = 40;
    const scale = Math.min((cv.width - 2 * padPx) / (maxX - minX || 1e-9), (cv.height - 2 * padPx) / (maxY - minY || 1e-9));
    const ox = (cv.width - (maxX - minX) * scale) / 2, oy = (cv.height - (maxY - minY) * scale) / 2;
    const proj = (lat, lon) => [ox + (lon * kx - minX) * scale, cv.height - (oy + (lat - minY) * scale)];

    ctx.lineWidth = 7;
    ctx.lineCap = "round";
    for (let i = 1; i < pts.length; i++) {
      const [x0, y0] = proj(pts[i - 1][0], pts[i - 1][1]);
      const [x1, y1] = proj(pts[i][0], pts[i][1]);
      ctx.strokeStyle = pts[i][2] > r.stats.speedLimitKmh ? col("--high") : col("--good");
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke();
    }
    const dot = (lat, lon, fill, label, textColor) => {
      const [x, y] = proj(lat, lon);
      ctx.fillStyle = fill;
      ctx.beginPath(); ctx.arc(x, y, 17, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = textColor || "#fff";
      ctx.font = "bold 18px sans-serif";
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText(label, x, y + 1);
    };
    dot(pts[0][0], pts[0][1], col("--ink"), "▶", col("--bg"));
    dot(pts[pts.length - 1][0], pts[pts.length - 1][1], col("--ink"), "■", col("--bg"));
    for (const e of r.events) if (e.lat != null) dot(e.lat, e.lon, col("--risky"), EVENT_INFO[e.type].letter);
  }

  const fileStem = (r) => `fleeto-ride-${new Date(r.stats.startT || Date.now()).toISOString().slice(0, 16).replace(/[-:T]/g, "")}`;

  function exportRide(r) {
    return saveFile(`${fileStem(r)}.json`, JSON.stringify(r, null, 1), "application/json");
  }

  // One row per GPS fix, with the values the event rules use. Opens in Google Sheets or Excel.
  function exportCsv(r) {
    if (!r.log || !r.log.length) {
      $("exportMsg").hidden = false;
      $("exportMsg").textContent = "This ride has no sensor log. Only the newest rides keep one.";
      return;
    }
    const t0 = r.log[0].t;
    const eventsAt = r.log.map(() => []);
    for (const e of r.events) {
      let i = 0;
      while (i + 1 < r.log.length && r.log[i + 1].t <= e.t) i++;
      eventsAt[i].push(EVENT_INFO[e.type].name);
    }
    const head = "time,seconds_from_start,lat,lon,speed_kmh,gps_accuracy_m,heading_deg,speed_change_ms2,sideways_ms2,events";
    const rows = r.log.map((f, i) => [new Date(f.t).toISOString(), ((f.t - t0) / 1000).toFixed(1), f.lat, f.lon, f.kmh,
      f.acc ?? "", f.heading ?? "", f.accel ?? "", f.lateral ?? "", eventsAt[i].join("; ")].join(","));
    return saveFile(`${fileStem(r)}.csv`, [head, ...rows].join("\n"), "text/csv");
  }

  async function shareScore(r) {
    const s = r.stats, sc = r.score;
    const text = [
      `My Fleeto ride score: ${sc.overall ?? "–"}${sc.band ? ` (${sc.band.label})` : ""}`,
      `${s.distanceKm.toFixed(1)} km, ${Math.round(s.movingMin)} min riding, top speed ${Math.round(s.maxKmh)} km/h`,
      `Harsh brakes ${s.harshBrakes} · Harsh starts ${s.harshAccels} · Sharp corners ${s.harshCorners} · Speeding ${s.speedingEpisodes} · Phone use ${s.phoneEvents}`,
      "(Fleeto prototype)",
    ].join("\n");
    if (navigator.share && !inFrame) {
      try { await navigator.share({ text }); return; } catch (e) { if (e && e.name === "AbortError") return; }
    }
    // No share sheet (laptop or Claude preview): open WhatsApp with the text filled in.
    const a = document.createElement("a");
    a.href = `https://wa.me/?text=${encodeURIComponent(text)}`;
    a.target = "_blank"; a.rel = "noopener";
    document.body.append(a); a.click(); a.remove();
  }

  async function saveFile(name, data, type) {
    const msg = $("exportMsg");
    msg.hidden = false;
    if (inFrame && window.claude && window.claude.use) {
      const downloads = await window.claude.use("downloads").catch(() => null);
      if (!downloads) { msg.textContent = "Saving files is not available in this view."; return; }
      try { await downloads.save({ filename: name, data }); msg.textContent = `Saved ${name}.`; }
      catch (e) { msg.textContent = e && e.code === "declined" ? "Not saved." : "Could not save the file here."; }
      return;
    }
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data], { type }));
    a.download = name;
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    msg.textContent = `Saved ${name} to your downloads.`;
  }

  // ---------- Wire up ----------

  try { const v = localStorage.getItem(LIMIT_KEY); if (v) $("limitInput").value = v; } catch (e) { /* ignore */ }
  $("limitInput").addEventListener("change", () => {
    const v = readLimit();
    $("limitInput").value = v;
    try { localStorage.setItem(LIMIT_KEY, String(v)); } catch (e) { /* ignore */ }
    renderHome();
  });
  try { const v = localStorage.getItem(VOICE_KEY); if (v) $("voiceInput").checked = v === "on"; } catch (e) { /* ignore */ }
  $("voiceInput").addEventListener("change", () => {
    try { localStorage.setItem(VOICE_KEY, $("voiceInput").checked ? "on" : "off"); } catch (e) { /* ignore */ }
  });
  $("startBtn").addEventListener("click", startLive);
  $("demoBtn").addEventListener("click", startDemo);
  $("stopBtn").addEventListener("click", stopRide);
  $("skipBtn").addEventListener("click", () => stepDemo(24 * 3600 * 1000));
  $("homeBtn").addEventListener("click", renderHome);

  if (!inFrame && "serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }
  renderHome();
})();
