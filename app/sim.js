/*
 * Demo ride generator. It makes a synthetic 15-minute city ride with known
 * events in it, so you can see the app work (and test the scoring) without
 * riding. It produces the same fix and motion shapes as the real sensors.
 */
(function (root) {
  "use strict";

  // Each step: hold or change speed (km/h) and turn (deg/s) for some seconds.
  // Comments name the event the step should trigger.
  // Synthetic roads, so the demo shows limits changing like a real ride with road data.
  const MARKET = { road: "Sector 18 Market Road", limitKmh: 40, limitSource: "road type" };
  const MAIN = { road: "Sector 18 Road", limitKmh: 50, limitSource: "posted" };
  const FLYOVER = { road: "Sector 16A Flyover", limitKmh: 60, limitSource: "posted" };
  const LINK = { road: "Film City Road", limitKmh: 50, limitSource: "road type" };

  const SCRIPT = [
    { s: 20, kmh: 0, ...MARKET },
    { s: 12, kmh: 28, ...MARKET },
    { s: 60, kmh: 32, ...MARKET },
    { s: 6, kmh: 32, turn: 15, ...MARKET },    // gentle right turn, no event
    { s: 90, kmh: 40, ...MAIN },
    { s: 3, kmh: 5, ...MAIN },                 // harsh brake (about 3.2 m/s²)
    { s: 15, kmh: 5, ...MAIN },
    { s: 20, kmh: 30, ...MAIN },
    { s: 120, kmh: 42, ...MAIN },
    { s: 3, kmh: 32, turn: -30, ...MAIN },     // sharp left corner (about 4.5 m/s² sideways)
    { s: 60, kmh: 40, ...MAIN },
    { s: 40, kmh: 0, ...MAIN },                // traffic signal
    { s: 30, kmh: 0, ...MAIN },
    { s: 3, kmh: 30, ...MAIN },                // harsh start (about 2.8 m/s²)
    { s: 30, kmh: 45, ...MAIN },
    { s: 10, kmh: 62, ...FLYOVER },
    { s: 40, kmh: 64, ...FLYOVER },            // speeding episode on the flyover (limit 60)
    { s: 10, kmh: 44, ...FLYOVER },
    { s: 60, kmh: 40, phoneAt: 20, ...LINK },  // phone taken from the mount for 6 s
    { s: 8, kmh: 30, turn: 10, ...LINK },
    { s: 100, kmh: 35, ...LINK },
    { s: 4, kmh: 12, ...LINK },                // firm but normal stop, no event
    { s: 15, kmh: 0, ...LINK },
  ];

  function generateDemoRide(startMs) {
    const t0 = startMs || Date.now() - 15 * 60 * 1000;
    let rng = 7;
    const rand = () => ((rng = (rng * 16807) % 2147483647) / 2147483647) - 0.5;

    let lat = 28.5355, lon = 77.391; // Sector 18, Noida
    let heading = 70, kmh = 0, t = 0;
    const fixes = [], motion = [];

    for (const step of SCRIPT) {
      const startKmh = kmh;
      for (let i = 1; i <= step.s; i++) {
        // Speed changes linearly from the previous speed to the target over the step.
        kmh = startKmh + ((step.kmh - startKmh) * i) / step.s;
        heading = (heading + (step.turn || 0) + 360) % 360;
        const ms = kmh / 3.6;
        lat += (ms * Math.cos((heading * Math.PI) / 180)) / 111320;
        lon += (ms * Math.sin((heading * Math.PI) / 180)) / (111320 * Math.cos((lat * Math.PI) / 180));
        t += 1000;
        const noisyKmh = Math.max(0, kmh + rand() * 0.8);
        fixes.push({ t: t0 + t, lat, lon, speed: noisyKmh / 3.6, heading: kmh > 3 ? heading : null, accuracy: 6 + Math.abs(rand()) * 6,
          limitKmh: step.limitKmh, limitSource: step.limitSource, road: step.road });

        // Ten motion samples per second. Mounted phone: gravity mostly on the y axis.
        const inHand = step.phoneAt != null && i >= step.phoneAt && i < step.phoneAt + 6;
        for (let j = 0; j < 10; j++) {
          const vib = kmh > 3 ? 0.6 : 0.05;
          const g = inHand ? { x: 1.2, y: 4.0, z: 8.8 } : { x: 0.3, y: 9.3, z: 2.9 };
          motion.push({
            t: t0 + t - 1000 + j * 100,
            gx: g.x + rand() * vib, gy: g.y + rand() * vib, gz: g.z + rand() * vib,
            ax: rand() * vib, ay: rand() * vib, az: rand() * vib,
            rotation: Math.abs((step.turn || 0)) + Math.abs(rand() * 4),
          });
        }
      }
    }
    return { fixes, motion };
  }

  const api = { generateDemoRide };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.RideSim = api;
})(typeof window !== "undefined" ? window : globalThis);
