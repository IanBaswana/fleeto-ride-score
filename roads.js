/*
 * Road speed limits from OpenStreetMap.
 *
 * While riding, the app downloads the roads around the rider from the free
 * Overpass API (no key). It matches each GPS fix to the nearest road and reads
 * that road's limit:
 *   1. "posted": the road's maxspeed tag in OpenStreetMap (maxspeed:motorcycle first).
 *   2. "road type": no tag, so a typical two-wheeler limit for that kind of road.
 *   3. no match (no road nearby, data not loaded yet, offline): the caller uses
 *      the rider's own setting.
 *
 * Only the map area (a box about 1.5 km wide) is sent to Overpass, never the GPS track.
 * The matching code has no browser code, so Node tests can run it with sample data.
 */
(function (root) {
  "use strict";

  // PLACEHOLDER limits for two-wheelers by OpenStreetMap road type, in km/h.
  // Based loosely on the 2018 MoRTH maximums for motorcycles (80 on highways, 60 elsewhere),
  // lowered for city road classes. Replace with city or state notifications later.
  const TYPE_LIMITS = {
    motorway: 80, motorway_link: 60,
    trunk: 80, trunk_link: 50,
    primary: 60, primary_link: 50,
    secondary: 50, secondary_link: 40,
    tertiary: 50, tertiary_link: 40,
    unclassified: 40, road: 40,
    residential: 30, living_street: 20,
  };
  const TYPE_NAMES = {
    motorway: "Expressway", motorway_link: "Expressway ramp", trunk: "Highway", trunk_link: "Highway ramp",
    primary: "Main road", primary_link: "Main road ramp", secondary: "Secondary road", secondary_link: "Secondary road ramp",
    tertiary: "Local main road", tertiary_link: "Local road ramp", unclassified: "Minor road", road: "Road",
    residential: "Residential street", living_street: "Shared street",
  };

  const CELL_DEG = 0.01;       // about 1.1 km; one download per cell
  const PAD_DEG = 0.002;       // download a little beyond the cell so matches near its edge work
  const MATCH_M = 30;          // ignore roads further than this from the fix
  const BEARING_PENALTY_M = 25; // a road at a wrong angle to the direction of travel counts as this much further
  const RETRY_MS = 30000;
  const ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ];

  // "50" -> 50, "30 mph" -> 48, "none"/"signals"/"IN:urban" -> null
  function parseMaxspeed(v) {
    if (!v) return null;
    const m = String(v).trim().match(/^(\d+(?:\.\d+)?)\s*(mph|km\/h|kmh|kph)?$/i);
    if (!m) return null;
    const n = parseFloat(m[1]);
    return m[2] && m[2].toLowerCase() === "mph" ? Math.round(n * 1.609) : n;
  }

  function limitFromTags(tags) {
    const posted = parseMaxspeed(tags["maxspeed:motorcycle"]) ?? parseMaxspeed(tags.maxspeed) ??
      minOrNull(parseMaxspeed(tags["maxspeed:forward"]), parseMaxspeed(tags["maxspeed:backward"]));
    if (posted) return { limitKmh: posted, source: "posted" };
    const typical = TYPE_LIMITS[tags.highway];
    return typical ? { limitKmh: typical, source: "road type" } : null;
  }
  function minOrNull(a, b) {
    if (a == null) return b;
    if (b == null) return a;
    return Math.min(a, b);
  }

  const cellKey = (lat, lon) => `${Math.floor(lat / CELL_DEG)}:${Math.floor(lon / CELL_DEG)}`;

  function cellBox(key) {
    const [i, j] = key.split(":").map(Number);
    return { s: i * CELL_DEG - PAD_DEG, w: j * CELL_DEG - PAD_DEG, n: (i + 1) * CELL_DEG + PAD_DEG, e: (j + 1) * CELL_DEG + PAD_DEG };
  }

  function overpassQuery(b) {
    const types = Object.keys(TYPE_LIMITS).join("|");
    return `[out:json][timeout:25];way["highway"~"^(${types})$"](${b.s},${b.w},${b.n},${b.e});out tags geom;`;
  }

  // Turn an Overpass answer into a flat list of road segments.
  function segmentsFromOverpass(json) {
    const segs = [];
    for (const el of (json && json.elements) || []) {
      if (el.type !== "way" || !el.geometry || !el.tags) continue;
      const limit = limitFromTags(el.tags);
      if (!limit) continue;
      const road = {
        id: el.id,
        name: el.tags.name || el.tags.ref || TYPE_NAMES[el.tags.highway] || "Road",
        highway: el.tags.highway,
        ...limit,
      };
      for (let i = 1; i < el.geometry.length; i++) segs.push({ a: el.geometry[i - 1], b: el.geometry[i], road });
    }
    return segs;
  }

  // Distance (m) from point p to segment ab, and the segment's bearing, on a local flat projection.
  function pointToSegment(p, a, b) {
    const kx = 111320 * Math.cos((p.lat * Math.PI) / 180), ky = 110540;
    const ax = (a.lon - p.lon) * kx, ay = (a.lat - p.lat) * ky;
    const bx = (b.lon - p.lon) * kx, by = (b.lat - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const cx = ax + t * dx, cy = ay + t * dy;
    const bearing = (Math.atan2(dx, dy) * 180) / Math.PI;
    return { dist: Math.hypot(cx, cy), bearing: (bearing + 360) % 360 };
  }

  // Angle between a direction of travel and a road, ignoring the road's direction (0-90).
  function axisDiff(heading, bearing) {
    const d = Math.abs(((heading - bearing + 540) % 360) - 180);
    return Math.min(d, 180 - d);
  }

  /*
   * Find the road for one fix among the loaded segments.
   * prevRoadId: the road of the last fix. Staying on it is preferred, so the limit
   * does not flicker at junctions.
   */
  function matchRoad(segs, fix, prevRoadId) {
    let best = null;
    for (const s of segs) {
      const { dist, bearing } = pointToSegment(fix, s.a, s.b);
      if (dist > MATCH_M) continue;
      let cost = dist;
      if (fix.heading != null && fix.kmh >= 10 && axisDiff(fix.heading, bearing) > 45) cost += BEARING_PENALTY_M;
      if (s.road.id === prevRoadId) cost -= 5;
      if (!best || cost < best.cost) best = { cost, dist, road: s.road };
    }
    return best ? { ...best.road, distM: Math.round(best.dist) } : null;
  }

  /*
   * RoadLimits keeps downloaded cells and answers lookups.
   * lookup() is synchronous and returns null until the rider's cell has loaded.
   * fetchFn is injectable for tests.
   */
  class RoadLimits {
    constructor(fetchFn) {
      this.fetch = fetchFn || ((url, opts) => root.fetch(url, opts));
      this.cells = new Map();   // key -> {state: "loading"|"ready"|"failed", segs, failedAt}
      this.prevRoadId = null;
      this.onStatus = null;     // optional callback(text) for the UI
    }

    // Make sure the cell under (lat, lon) is loaded or loading.
    ensure(lat, lon) {
      const key = cellKey(lat, lon);
      const c = this.cells.get(key);
      if (c && (c.state !== "failed" || Date.now() - c.failedAt < RETRY_MS)) return;
      this._load(key);
    }

    async _load(key) {
      this.cells.set(key, { state: "loading", segs: [] });
      const body = "data=" + encodeURIComponent(overpassQuery(cellBox(key)));
      for (const url of ENDPOINTS) {
        try {
          const res = await this.fetch(url, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } });
          if (!res.ok) throw new Error("HTTP " + res.status);
          const segs = segmentsFromOverpass(await res.json());
          this.cells.set(key, { state: "ready", segs });
          if (this.onStatus) this.onStatus("ready");
          return;
        } catch (e) { /* try the next server */ }
      }
      this.cells.set(key, { state: "failed", segs: [], failedAt: Date.now() });
      if (this.onStatus) this.onStatus("failed");
    }

    // fix: {lat, lon, heading, kmh}. Returns {limitKmh, source, name, highway, distM} or null.
    lookup(fix) {
      this.ensure(fix.lat, fix.lon);
      // Load the cell about 30 s ahead too, so the limit is ready when the rider gets there.
      if (fix.heading != null && fix.kmh > 10) {
        const aheadM = (fix.kmh / 3.6) * 30;
        const r = (fix.heading * Math.PI) / 180;
        this.ensure(fix.lat + (aheadM * Math.cos(r)) / 110540,
          fix.lon + (aheadM * Math.sin(r)) / (111320 * Math.cos((fix.lat * Math.PI) / 180)));
      }
      const c = this.cells.get(cellKey(fix.lat, fix.lon));
      if (!c || c.state !== "ready") return null;
      const m = matchRoad(c.segs, fix, this.prevRoadId);
      this.prevRoadId = m ? m.id : null;
      return m;
    }

    status() {
      const states = [...this.cells.values()].map((c) => c.state);
      if (states.includes("ready")) return "ready";
      if (states.includes("loading")) return "loading";
      if (states.includes("failed")) return "failed";
      return "idle";
    }
  }

  const api = { RoadLimits, TYPE_LIMITS, parseMaxspeed, limitFromTags, segmentsFromOverpass, matchRoad, cellKey, overpassQuery, cellBox };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RoadData = api;
})(typeof window !== "undefined" ? window : globalThis);
