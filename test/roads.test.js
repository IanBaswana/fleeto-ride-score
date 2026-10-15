// Run: node test/roads.test.js
// Checks speed-limit parsing, road matching and the Overpass loader with sample road data.
const assert = require("assert");
const { RoadLimits, parseMaxspeed, matchRoad, segmentsFromOverpass } = require("../app/roads.js");

assert.strictEqual(parseMaxspeed("40"), 40);
assert.strictEqual(parseMaxspeed("30 mph"), 48);
assert.strictEqual(parseMaxspeed("none"), null);
assert.strictEqual(parseMaxspeed("IN:urban"), null);

// Sample area near Sector 18, Noida (made-up roads):
//  - "Test Posted Road" runs north, maxspeed 30
//  - "Test Cross Street" runs east through the middle, secondary, no maxspeed (typical 50)
//  - "Test Bike Road" runs north 300 m east, maxspeed 60 but maxspeed:motorcycle 40
const lat0 = 28.5700, lon0 = 77.3200;
const sample = { elements: [
  { type: "way", id: 1, tags: { highway: "primary", name: "Test Posted Road", maxspeed: "30" },
    geometry: [{ lat: lat0 - 0.004, lon: lon0 }, { lat: lat0 + 0.004, lon: lon0 }] },
  { type: "way", id: 2, tags: { highway: "secondary", name: "Test Cross Street" },
    geometry: [{ lat: lat0, lon: lon0 - 0.004 }, { lat: lat0, lon: lon0 + 0.004 }] },
  { type: "way", id: 3, tags: { highway: "trunk", name: "Test Bike Road", maxspeed: "60", "maxspeed:motorcycle": "40" },
    geometry: [{ lat: lat0 - 0.004, lon: lon0 + 0.003 }, { lat: lat0 + 0.004, lon: lon0 + 0.003 }] },
  { type: "way", id: 4, tags: { highway: "footway" }, geometry: [{ lat: lat0, lon: lon0 }, { lat: lat0 + 0.001, lon: lon0 }] },
] };
const segs = segmentsFromOverpass(sample);
assert.ok(segs.every((s) => s.road.highway !== "footway"), "footways are ignored");

const m1 = matchRoad(segs, { lat: lat0 + 0.002, lon: lon0 + 0.00005, heading: 0, kmh: 30 });
assert.strictEqual(m1.name, "Test Posted Road"); assert.strictEqual(m1.limitKmh, 30); assert.strictEqual(m1.source, "posted");

// At the junction, heading east: the cross street wins because it matches the direction of travel.
const m2 = matchRoad(segs, { lat: lat0 + 0.00003, lon: lon0 + 0.00008, heading: 90, kmh: 30 });
assert.strictEqual(m2.name, "Test Cross Street"); assert.strictEqual(m2.limitKmh, 50); assert.strictEqual(m2.source, "road type");

// Same spot heading north: the posted road wins.
assert.strictEqual(matchRoad(segs, { lat: lat0 + 0.00003, lon: lon0 + 0.00008, heading: 0, kmh: 30 }).name, "Test Posted Road");

const m3 = matchRoad(segs, { lat: lat0 + 0.002, lon: lon0 + 0.003, heading: 180, kmh: 40 });
assert.strictEqual(m3.limitKmh, 40, "maxspeed:motorcycle is used before maxspeed");

assert.strictEqual(matchRoad(segs, { lat: lat0 + 0.002, lon: lon0 + 0.0015, heading: 0, kmh: 30 }), null, "no road within 30 m");

(async () => {
  let calls = 0;
  const roads = new RoadLimits(async () => { calls++; return { ok: true, json: async () => sample }; });
  const fix = { lat: lat0 + 0.002, lon: lon0, heading: 0, kmh: 30 };
  assert.strictEqual(roads.lookup(fix), null, "null until the area has loaded");
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(roads.lookup(fix).name, "Test Posted Road");
  roads.lookup(fix);
  assert.ok(calls <= 2, "areas are downloaded once (current + ahead), got " + calls);

  const offline = new RoadLimits(async () => { throw new Error("offline"); });
  offline.lookup(fix);
  await new Promise((r) => setTimeout(r, 10));
  assert.strictEqual(offline.status(), "failed");
  assert.strictEqual(offline.lookup(fix), null);
  console.log("PASS");
})();
