/*
 * Fleeto ride safety score: detection and scoring logic.
 *
 * This file has no browser code. It takes GPS fixes, motion samples and
 * touch events, finds risky events, and turns the ride totals into a
 * 0-100 score. The same code runs on the phone and in Node tests.
 *
 * ALL THRESHOLDS AND WEIGHTS BELOW ARE PLACEHOLDERS. They come from
 * general telematics practice, not from Indian two-wheeler data.
 * Calibrate them with real rides before you trust a score.
 */
(function (root) {
  "use strict";

  const CONFIG = {
    // Speed. Each fix can carry the road's own limit (see roads.js); this one is the fallback.
    speedLimitKmh: 50,          // PLACEHOLDER: used where no road limit is known
    severeOverKmh: 20,          // PLACEHOLDER: "severe" = limit + this
    speedingMinS: 3,            // an over-limit stretch must last this long to count as an episode

    // GPS quality and motion.
    maxFixAccuracyM: 25,        // ignore fixes less accurate than this
    maxGapS: 5,                 // a longer gap between fixes is a signal loss, not riding time
    maxPlausibleKmh: 130,       // ignore jumps that imply a faster speed (GPS glitch)
    movingKmh: 5,               // below this the rider is stopped

    // Harsh events, from GPS speed and heading (more reliable than raw accelerometer on a bike).
    dynamicsWindowS: 2,         // compare speed/heading over about this many seconds
    dynamicsMinKmh: 12,         // ignore dynamics at walking speed
    harshBrakeMs2: 3.0,         // PLACEHOLDER: about 0.3 g of deceleration
    harshAccelMs2: 2.5,         // PLACEHOLDER: about 0.25 g
    harshCornerMs2: 3.5,        // PLACEHOLDER: lateral accel = speed x turn rate, about 0.35 g
    eventCooldownS: 4,          // one event per manoeuvre

    // Phone use while riding.
    handlingMinKmh: 10,         // only count phone use above this speed
    handlingAngleDeg: 35,       // PLACEHOLDER: phone tilted this far from its mount position
    handlingHoldS: 2,           // ...for at least this long
    touchCooldownS: 10,         // several taps in a row count as one event

    // Exposure.
    nightStartHour: 22,         // PLACEHOLDER: night = 22:00 to 05:00 local time
    nightEndHour: 5,
    maxContinuousMin: 120,      // PLACEHOLDER: riding longer than this without a break is fatigue risk
    breakMin: 15,               // a stop this long resets the continuous-riding clock

    // Normalisation floors, so a very short ride does not swing the score.
    minScoringKm: 2,
    minScoringHours: 0.5,
    minRideKm: 1,               // below this the score is shown as "too short to judge"
  };

  // Weights add up to 100. PLACEHOLDER: set them from crash/claims data later.
  const COMPONENTS = [
    { key: "speeding", label: "Speeding", weight: 25 },
    { key: "braking", label: "Harsh braking", weight: 20 },
    { key: "cornering", label: "Sharp cornering", weight: 15 },
    { key: "phone", label: "Phone use while riding", weight: 15 },
    { key: "acceleration", label: "Harsh acceleration", weight: 10 },
    { key: "night", label: "Night riding", weight: 7.5 },
    { key: "fatigue", label: "Long riding without a break", weight: 7.5 },
  ];

  const BANDS = [
    { min: 85, key: "safe", label: "Safe" },
    { min: 70, key: "fair", label: "Fair" },
    { min: 50, key: "risky", label: "Risky" },
    { min: 0, key: "high", label: "High risk" },
  ];

  const toRad = (d) => (d * Math.PI) / 180;
  const toDeg = (r) => (r * 180) / Math.PI;
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

  function haversineM(a, b) {
    const R = 6371000;
    const dLat = toRad(b.lat - a.lat);
    const dLon = toRad(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  function bearingDeg(a, b) {
    const y = Math.sin(toRad(b.lon - a.lon)) * Math.cos(toRad(b.lat));
    const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) -
      Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lon - a.lon));
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
  }

  // Smallest signed difference b - a in degrees, in [-180, 180).
  function headingDiff(a, b) {
    return ((b - a + 540) % 360) - 180;
  }

  function angleBetween(u, v) {
    const dot = u.x * v.x + u.y * v.y + u.z * v.z;
    const nu = Math.hypot(u.x, u.y, u.z);
    const nv = Math.hypot(v.x, v.y, v.z);
    if (!nu || !nv) return 0;
    return toDeg(Math.acos(clamp(dot / (nu * nv), -1, 1)));
  }

  function isNight(tMs, cfg) {
    const h = new Date(tMs).getHours();
    return cfg.nightStartHour > cfg.nightEndHour
      ? h >= cfg.nightStartHour || h < cfg.nightEndHour
      : h >= cfg.nightStartHour && h < cfg.nightEndHour;
  }

  /*
   * RideAnalyzer keeps the running state of one ride.
   * Feed it with addFix(), addMotion(), addTouch() and addAppHidden().
   * Read live values with snapshot() and the final result with finish().
   */
  class RideAnalyzer {
    constructor(overrides) {
      this.cfg = Object.assign({}, CONFIG, overrides || {});
      this.fixes = [];            // accepted fixes: {t, lat, lon, kmh, heading, acc}
      this.window = [];           // recent fixes for the dynamics window
      this.events = [];           // {type, t, lat, lon, kmh, value, detail}
      this.lastEventT = {};
      this.totals = {
        distanceM: 0, movingS: 0, stoppedS: 0, gapS: 0,
        overLimitS: 0, severeS: 0, nightS: 0,
        limitS: { posted: 0, "road type": 0, setting: 0 },  // moving time by where the limit came from
        continuousS: 0, longestContinuousS: 0, stopRunS: 0,
        maxKmh: 0, rejectedFixes: 0,
      };
      this.speeding = null;       // open over-limit episode
      this.lastKmh = 0;
      this.motion = { samples: 0, gravity: null, ref: null, offSince: null, inEvent: false,
        anchor: null, stableSince: null };
      this.live = { accelMs2: 0, lateralMs2: 0, rotationDegS: 0, motionAccel: 0 };
    }

    /*
     * fix: {t (ms), lat, lon, speed (m/s or null), heading (deg or null), accuracy (m),
     *       limitKmh (optional road limit), limitSource ("posted" | "road type"), road (optional name)}
     */
    addFix(fix) {
      const c = this.cfg;
      const T = this.totals;
      if (fix.accuracy != null && fix.accuracy > c.maxFixAccuracyM) { T.rejectedFixes++; return; }
      const prev = this.fixes[this.fixes.length - 1];
      let kmh = fix.speed != null && fix.speed >= 0 ? fix.speed * 3.6 : null;
      const limit = fix.limitKmh || c.speedLimitKmh;
      const limitSource = fix.limitKmh ? fix.limitSource || "posted" : "setting";

      if (prev) {
        const dt = (fix.t - prev.t) / 1000;
        if (dt <= 0) return;
        // Without a GPS speed we compute it from position. Over less than a second, position
        // noise gives wild speeds (and fake harsh events), so wait for a later fix.
        if (kmh == null && dt < 0.9) return;
        const d = haversineM(prev, fix);
        if (kmh == null) kmh = (d / dt) * 3.6;
        if ((d / dt) * 3.6 > c.maxPlausibleKmh) { T.rejectedFixes++; return; }

        if (dt > c.maxGapS) {
          T.gapS += dt;
          this.window = [];
        } else {
          T.distanceM += d;
          this._addTime(dt, (kmh + prev.kmh) / 2, fix, limit, limitSource);
        }
      }
      // The very first fix often has no speed. Use 0 for display, but keep it out of
      // the harsh-event window so a ride started while moving does not log a fake harsh start.
      const speedKnown = kmh != null;
      kmh = kmh || 0;

      let heading = fix.heading;
      if ((heading == null || isNaN(heading)) && prev && kmh > c.movingKmh) heading = bearingDeg(prev, fix);
      const f = { t: fix.t, lat: fix.lat, lon: fix.lon, kmh, heading, acc: fix.accuracy,
        limit, limitSource, road: fix.road || null };
      this.fixes.push(f);
      this.lastKmh = kmh;
      T.maxKmh = Math.max(T.maxKmh, kmh);

      this._updateSpeeding(f);
      if (speedKnown) this._detectDynamics(f);
    }

    _addTime(dt, kmh, fix, limit, limitSource) {
      const c = this.cfg;
      const T = this.totals;
      if (kmh >= c.movingKmh) {
        T.movingS += dt;
        T.continuousS += dt;
        T.stopRunS = 0;
        T.longestContinuousS = Math.max(T.longestContinuousS, T.continuousS);
        if (kmh > limit) T.overLimitS += dt;
        if (kmh > limit + c.severeOverKmh) T.severeS += dt;
        T.limitS[limitSource] += dt;
        if (isNight(fix.t, c)) T.nightS += dt;
      } else {
        T.stoppedS += dt;
        T.stopRunS += dt;
        if (T.stopRunS >= c.breakMin * 60) T.continuousS = 0;
      }
    }

    _updateSpeeding(f) {
      const c = this.cfg;
      if (f.kmh > f.limit) {
        if (!this.speeding) this.speeding = { start: f, maxKmh: f.kmh, maxOver: 0 };
        this.speeding.maxKmh = Math.max(this.speeding.maxKmh, f.kmh);
        if (f.kmh - f.limit >= this.speeding.maxOver) { this.speeding.maxOver = f.kmh - f.limit; this.speeding.limit = f.limit; }
        this.speeding.end = f;
      } else {
        this._closeSpeeding();
      }
    }

    _closeSpeeding() {
      const s = this.speeding;
      this.speeding = null;
      if (!s || !s.end) return;
      const dur = (s.end.t - s.start.t) / 1000;
      if (dur < this.cfg.speedingMinS) return;
      this.events.push({
        type: "speeding", t: s.start.t, lat: s.start.lat, lon: s.start.lon, kmh: s.maxKmh,
        value: s.maxKmh, limit: s.limit,
        detail: `${Math.round(s.maxKmh)} km/h peak in a ${s.limit} zone for ${Math.round(dur)} s`,
      });
    }

    // Longitudinal accel = change in GPS speed; lateral accel = speed x turn rate.
    _detectDynamics(f) {
      const c = this.cfg;
      this.window.push(f);
      while (this.window.length && (f.t - this.window[0].t) / 1000 > c.dynamicsWindowS + 1) this.window.shift();
      const old = this.window.find((w) => (f.t - w.t) / 1000 <= c.dynamicsWindowS + 0.5 &&
        (f.t - w.t) / 1000 >= c.dynamicsWindowS - 0.5);
      if (!old) return;
      const dt = (f.t - old.t) / 1000;
      const accel = (f.kmh - old.kmh) / 3.6 / dt;
      const avgMs = (f.kmh + old.kmh) / 2 / 3.6;
      let lateral = 0;
      if (f.heading != null && old.heading != null && Math.min(f.kmh, old.kmh) >= c.dynamicsMinKmh) {
        lateral = Math.abs(avgMs * toRad(headingDiff(old.heading, f.heading)) / dt);
      }
      this.live.accelMs2 = accel;
      this.live.lateralMs2 = lateral;
      f.accel = accel;      // kept for the sensor log export
      f.lateral = lateral;

      if (Math.max(f.kmh, old.kmh) < c.dynamicsMinKmh) return;
      if (accel <= -c.harshBrakeMs2) {
        this._event("braking", f, -accel, `${(-accel).toFixed(1)} m/s² from ${Math.round(old.kmh)} to ${Math.round(f.kmh)} km/h`);
      } else if (accel >= c.harshAccelMs2) {
        this._event("acceleration", f, accel, `${accel.toFixed(1)} m/s² from ${Math.round(old.kmh)} to ${Math.round(f.kmh)} km/h`);
      }
      if (lateral >= c.harshCornerMs2) {
        this._event("cornering", f, lateral, `${lateral.toFixed(1)} m/s² sideways at ${Math.round(f.kmh)} km/h`);
      }
    }

    _event(type, f, value, detail) {
      const last = this.lastEventT[type];
      if (last != null && (f.t - last) / 1000 < this.cfg.eventCooldownS) {
        // Same manoeuvre: keep the strongest reading.
        const e = this.events.filter((x) => x.type === type).pop();
        if (e && value > e.value) Object.assign(e, { value, detail });
        this.lastEventT[type] = f.t;
        return;
      }
      this.lastEventT[type] = f.t;
      this.events.push({ type, t: f.t, lat: f.lat, lon: f.lon, kmh: f.kmh, value, detail });
    }

    /*
     * Motion sample from DeviceMotionEvent:
     * {t, gx, gy, gz (accel incl. gravity, m/s²), ax, ay, az (without gravity), rotation (deg/s magnitude)}
     * The phone sits in a mount, so its gravity direction stays about the same.
     * A large, held change in that direction while moving means the rider took the phone in hand.
     */
    addMotion(s) {
      const c = this.cfg;
      const m = this.motion;
      m.samples++;
      if (s.ax != null) this.live.motionAccel = Math.hypot(s.ax, s.ay, s.az);
      if (s.rotation != null) this.live.rotationDegS = s.rotation;
      if (s.gx == null) return;

      const k = 0.1; // low-pass filter keeps gravity, drops vibration
      m.gravity = m.gravity
        ? { x: m.gravity.x + k * (s.gx - m.gravity.x), y: m.gravity.y + k * (s.gy - m.gravity.y), z: m.gravity.z + k * (s.gz - m.gravity.z) }
        : { x: s.gx, y: s.gy, z: s.gz };
      const g = m.gravity;

      if (!m.anchor || angleBetween(m.anchor, g) > 8) { m.anchor = { ...g }; m.stableSince = s.t; }
      const stableS = (s.t - m.stableSince) / 1000;

      if (this.lastKmh < c.handlingMinKmh) {
        // Stopped: the rider may adjust the mount. Take a new reference when moving again.
        m.ref = null; m.offSince = null; m.inEvent = false;
        return;
      }
      if (!m.ref) { if (stableS >= 2) m.ref = { ...g }; return; }

      const off = angleBetween(m.ref, g);
      if (off >= c.handlingAngleDeg) {
        if (m.offSince == null) m.offSince = s.t;
        if (!m.inEvent && (s.t - m.offSince) / 1000 >= c.handlingHoldS) {
          m.inEvent = true;
          const f = this.fixes[this.fixes.length - 1];
          this._pushPhone(s.t, f, `Phone tilted ${Math.round(off)}° from its mount position`);
        }
      } else if (off < c.handlingAngleDeg / 2) {
        m.offSince = null;
      }
      // After an event, accept the new position once the phone is still again.
      if (m.inEvent && stableS >= 5) { m.ref = { ...g }; m.inEvent = false; m.offSince = null; }
    }

    addTouch(t) {
      if (this.lastKmh < this.cfg.handlingMinKmh) return;
      const last = this.lastEventT.phoneTouch;
      if (last != null && (t - last) / 1000 < this.cfg.touchCooldownS) return;
      this.lastEventT.phoneTouch = t;
      this._pushPhone(t, this.fixes[this.fixes.length - 1], `Screen touched at ${Math.round(this.lastKmh)} km/h`);
    }

    addAppHidden(t) {
      if (this.lastKmh < this.cfg.handlingMinKmh) return;
      this._pushPhone(t, this.fixes[this.fixes.length - 1], `Switched away from the app at ${Math.round(this.lastKmh)} km/h`);
    }

    _pushPhone(t, f, detail) {
      this.events.push({ type: "phone", t, lat: f && f.lat, lon: f && f.lon, kmh: this.lastKmh, value: 1, detail });
    }

    stats() {
      const T = this.totals;
      const count = (type) => this.events.filter((e) => e.type === type).length;
      const first = this.fixes[0];
      const last = this.fixes[this.fixes.length - 1];
      return {
        startT: first ? first.t : null,
        endT: last ? last.t : null,
        distanceKm: T.distanceM / 1000,
        movingMin: T.movingS / 60,
        stoppedMin: T.stoppedS / 60,
        gapMin: T.gapS / 60,
        avgMovingKmh: T.movingS ? (T.distanceM / T.movingS) * 3.6 : 0,
        maxKmh: T.maxKmh,
        pctOverLimit: T.movingS ? (100 * T.overLimitS) / T.movingS : 0,
        pctSevere: T.movingS ? (100 * T.severeS) / T.movingS : 0,
        pctNight: T.movingS ? (100 * T.nightS) / T.movingS : 0,
        longestContinuousMin: T.longestContinuousS / 60,
        speedingEpisodes: count("speeding") + (this.speeding ? 1 : 0),
        harshBrakes: count("braking"),
        harshAccels: count("acceleration"),
        harshCorners: count("cornering"),
        phoneEvents: count("phone"),
        motionAvailable: this.motion.samples > 0,
        rejectedFixes: T.rejectedFixes,
        speedLimitKmh: this.cfg.speedLimitKmh,
        // Share of moving time by where the speed limit came from.
        pctLimitPosted: T.movingS ? (100 * T.limitS.posted) / T.movingS : 0,
        pctLimitRoadType: T.movingS ? (100 * T.limitS["road type"]) / T.movingS : 0,
      };
    }

    snapshot() {
      const s = this.stats();
      const f = this.fixes[this.fixes.length - 1];
      const limit = f ? f.limit : this.cfg.speedLimitKmh;
      return { stats: s, score: scoreRide(s, this.cfg), live: { ...this.live, kmh: this.lastKmh,
        limitKmh: limit, limitSource: f ? f.limitSource : "setting", road: f ? f.road : null,
        overLimit: this.lastKmh > limit } };
    }

    finish() {
      this._closeSpeeding();
      const s = this.stats();
      return { stats: s, score: scoreRide(s, this.cfg), events: this.events.slice().sort((a, b) => a.t - b.t),
        route: this.fixes.map((f) => [f.lat, f.lon, Math.round(f.kmh), f.limit]), config: this.cfg,
        // Per-fix sensor log, for tuning thresholds against real rides.
        log: this.fixes.map((f) => ({ t: f.t, lat: +f.lat.toFixed(6), lon: +f.lon.toFixed(6), kmh: +f.kmh.toFixed(1),
          acc: f.acc == null ? null : Math.round(f.acc), heading: f.heading == null ? null : Math.round(f.heading),
          accel: f.accel == null ? null : +f.accel.toFixed(2), lateral: f.lateral == null ? null : +f.lateral.toFixed(2),
          limit: f.limit, limitSource: f.limitSource, road: f.road })) };
    }
  }

  /*
   * Turn ride totals into component scores (each 0-100) and one weighted score.
   * Event counts are normalised per 10 km (or per hour for phone use),
   * so a long ride is not punished just for being long.
   */
  function scoreRide(s, cfg) {
    cfg = Object.assign({}, CONFIG, cfg || {});
    const per10km = (n) => (10 * n) / Math.max(s.distanceKm, cfg.minScoringKm);
    const perHour = (n) => n / Math.max(s.movingMin / 60, cfg.minScoringHours);
    const overMin = Math.max(0, s.longestContinuousMin - cfg.maxContinuousMin);
    const r1 = (x) => Math.round(x * 10) / 10;

    const roadPct = (s.pctLimitPosted || 0) + (s.pctLimitRoadType || 0);
    const raw = {
      speeding: {
        score: 100 - 2 * s.pctOverLimit - 4 * s.pctSevere,
        measure: roadPct > 0
          ? `${r1(s.pctOverLimit)}% of riding time above the road's limit, ${r1(s.pctSevere)}% more than ${cfg.severeOverKmh} km/h above. ` +
            `Limits: ${Math.round(s.pctLimitPosted)}% posted, ${Math.round(s.pctLimitRoadType)}% typical for the road type, ${Math.max(0, Math.round(100 - roadPct))}% your ${cfg.speedLimitKmh} km/h setting`
          : `${r1(s.pctOverLimit)}% of riding time above ${cfg.speedLimitKmh} km/h, ${r1(s.pctSevere)}% above ${cfg.speedLimitKmh + cfg.severeOverKmh}`,
        rule: "100 − 2 × % time over limit − 4 × % time severely over",
      },
      braking: {
        score: 100 - 15 * per10km(s.harshBrakes),
        measure: `${plural(s.harshBrakes, "harsh brake")} (${r1(per10km(s.harshBrakes))} per 10 km)`,
        rule: `100 − 15 per harsh brake per 10 km (≥ ${cfg.harshBrakeMs2} m/s² slowing)`,
      },
      cornering: {
        score: 100 - 15 * per10km(s.harshCorners),
        measure: `${plural(s.harshCorners, "sharp corner")} (${r1(per10km(s.harshCorners))} per 10 km)`,
        rule: `100 − 15 per sharp corner per 10 km (≥ ${cfg.harshCornerMs2} m/s² sideways)`,
      },
      phone: {
        score: 100 - 15 * perHour(s.phoneEvents),
        measure: `${plural(s.phoneEvents, "time")} (${r1(perHour(s.phoneEvents))} per hour)`,
        rule: `100 − 15 per phone event per riding hour (tilt, touch or app switch above ${cfg.handlingMinKmh} km/h)`,
        available: s.motionAvailable || s.phoneEvents > 0,
      },
      acceleration: {
        score: 100 - 10 * per10km(s.harshAccels),
        measure: `${plural(s.harshAccels, "harsh start")} (${r1(per10km(s.harshAccels))} per 10 km)`,
        rule: `100 − 10 per harsh start per 10 km (≥ ${cfg.harshAccelMs2} m/s² speeding up)`,
      },
      night: {
        score: 100 - 0.5 * s.pctNight,
        measure: `${r1(s.pctNight)}% of riding time between ${cfg.nightStartHour}:00 and 0${cfg.nightEndHour}:00`,
        rule: "100 − 0.5 × % of riding time at night",
      },
      fatigue: {
        score: 100 - (overMin / 30) * 20,
        measure: `Longest stretch without a ${cfg.breakMin}-minute break: ${Math.round(s.longestContinuousMin)} min`,
        rule: `100 − 20 per 30 min beyond ${cfg.maxContinuousMin} min without a break`,
      },
    };

    let wSum = 0;
    let total = 0;
    const components = COMPONENTS.map((c) => {
      const r = raw[c.key];
      const available = r.available !== false;
      const score = Math.round(clamp(r.score, 0, 100));
      if (available) { wSum += c.weight; total += c.weight * score; }
      return { key: c.key, label: c.label, weight: c.weight, score, available, measure: r.measure, rule: r.rule };
    });

    const overall = wSum ? Math.round(total / wSum) : null;
    const band = overall == null ? null : BANDS.find((b) => overall >= b.min);
    return {
      overall, band,
      enoughData: s.distanceKm >= cfg.minRideKm,
      components,
    };
  }

  const api = { CONFIG, COMPONENTS, BANDS, RideAnalyzer, scoreRide, haversineM, bearingDeg };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RideScore = api;
})(typeof window !== "undefined" ? window : globalThis);
