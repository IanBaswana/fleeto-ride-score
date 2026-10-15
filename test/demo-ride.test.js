// Run: node test/demo-ride.test.js
// Feeds the demo ride through the analyzer and checks that each planted event is found once.
const assert = require("assert");
const { RideAnalyzer } = require("../app/scoring.js");
const { generateDemoRide } = require("../app/sim.js");

// Fixed daytime start, so the night component does not depend on when the test runs.
const start = new Date(2026, 9, 15, 11, 0, 0).getTime();
const { fixes, motion } = generateDemoRide(start);
const a = new RideAnalyzer();
let m = 0;
for (const f of fixes) {
  while (m < motion.length && motion[m].t <= f.t) a.addMotion(motion[m++]);
  a.addFix(f);
}
const r = a.finish();
console.log(JSON.stringify(r.stats, null, 1));
console.log(r.events.map((e) => `${e.type}: ${e.detail}`).join("\n"));
console.log("score", r.score.overall, r.score.band.label);
r.score.components.forEach((c) => console.log(`  ${c.label}: ${c.score}  (${c.measure})`));

assert.strictEqual(r.stats.harshBrakes, 1, "one harsh brake");
assert.strictEqual(r.stats.harshAccels, 1, "one harsh start");
assert.strictEqual(r.stats.harshCorners, 1, "one sharp corner");
assert.strictEqual(r.stats.speedingEpisodes, 1, "one speeding episode");
assert.strictEqual(r.stats.phoneEvents, 1, "one phone event");
assert.ok(r.stats.distanceKm > 5 && r.stats.distanceKm < 9, "distance about 7 km");
assert.ok(r.score.overall > 40 && r.score.overall < 95, "score in a sensible range");
console.log("PASS");
