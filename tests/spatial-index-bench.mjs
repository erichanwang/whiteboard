import { chromium } from "playwright";

// Headless throughput benchmark for hit-testing and viewport culling: linear
// scan vs the uniform-grid spatial index, at increasing stroke counts. This
// measures pure hit-test/cull selection cost in a real (headless) browser
// engine, independent of any canvas drawing/painting.

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

try {
  await page.goto("http://127.0.0.1:1420", { waitUntil: "networkidle" });

  const results = await page.evaluate(async () => {
    const { eraseStrokesAt, eraseStrokesAtLinear, queryStrokeIndices, strokeBounds } = await import("/src/board.ts");

    let seed = 7;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const SPREAD = 50_000;
    const makeStrokes = (count) => Array.from({ length: count }, (_, index) => {
      const cx = random() * SPREAD;
      const cy = random() * SPREAD;
      const pointCount = 2 + Math.floor(random() * 6);
      const points = Array.from({ length: pointCount }, () => ({
        x: cx + (random() - 0.5) * 40,
        y: cy + (random() - 0.5) * 40,
        pressure: 0.3 + random() * 0.6,
      }));
      return {
        id: `stroke-${index}`,
        color: "#111111",
        width: 1 + random() * 8,
        pointerType: "pen",
        points,
      };
    });

    const overlaps = (item, visible, padding) => item.x <= visible.x + visible.width + padding
      && item.x + item.width >= visible.x - padding
      && item.y <= visible.y + visible.height + padding
      && item.y + item.height >= visible.y - padding;

    const linearCull = (strokes, visibleBounds) => strokes.filter((stroke) => {
      const bounds = strokeBounds([stroke]);
      return bounds && overlaps(bounds, visibleBounds, stroke.width / 2);
    });

    const spatialCull = (strokes, visibleBounds) => queryStrokeIndices(strokes, visibleBounds, 0)
      .map((index) => strokes[index])
      .filter((stroke) => {
        const bounds = strokeBounds([stroke]);
        return bounds && overlaps(bounds, visibleBounds, stroke.width / 2);
      });

    const WARM_REPEATS = 200;
    const sizes = [1_000, 10_000, 50_000, 100_000];
    const report = [];

    for (const size of sizes) {
      const strokes = makeStrokes(size);

      // Hit-test (point + radius, as in eraseStrokesAt): "warm" reuses the
      // same strokes array across repeats so the index is built once and
      // reused, as happens across repeated erase samples during one gesture.
      let linearHitStart = performance.now();
      for (let i = 0; i < WARM_REPEATS; i += 1) {
        const x = random() * SPREAD;
        const y = random() * SPREAD;
        eraseStrokesAtLinear(strokes, x, y, 10);
      }
      const linearHitMs = performance.now() - linearHitStart;

      let spatialHitStart = performance.now();
      for (let i = 0; i < WARM_REPEATS; i += 1) {
        const x = random() * SPREAD;
        const y = random() * SPREAD;
        eraseStrokesAt(strokes, x, y, 10);
      }
      const spatialHitMs = performance.now() - spatialHitStart;

      // Cold hit-test: fresh array each call, so the index must be rebuilt
      // every time (worst case, e.g. right after an edit changes the array).
      const COLD_TRIALS = 20;
      let coldHitStart = performance.now();
      for (let i = 0; i < COLD_TRIALS; i += 1) {
        const fresh = strokes.slice();
        const x = random() * SPREAD;
        const y = random() * SPREAD;
        eraseStrokesAt(fresh, x, y, 10);
      }
      const coldHitMs = (performance.now() - coldHitStart) / COLD_TRIALS * WARM_REPEATS;

      // Viewport cull (bounds query), same warm/cold split.
      const viewport = () => ({ x: random() * SPREAD, y: random() * SPREAD, width: 1200, height: 800 });

      let linearCullStart = performance.now();
      for (let i = 0; i < WARM_REPEATS; i += 1) linearCull(strokes, viewport());
      const linearCullMs = performance.now() - linearCullStart;

      let spatialCullStart = performance.now();
      for (let i = 0; i < WARM_REPEATS; i += 1) spatialCull(strokes, viewport());
      const spatialCullMs = performance.now() - spatialCullStart;

      let coldCullStart = performance.now();
      for (let i = 0; i < COLD_TRIALS; i += 1) spatialCull(strokes.slice(), viewport());
      const coldCullMs = (performance.now() - coldCullStart) / COLD_TRIALS * WARM_REPEATS;

      report.push({
        size,
        linearHitMs, spatialHitMs, coldHitMs,
        linearCullMs, spatialCullMs, coldCullMs,
        repeats: WARM_REPEATS,
      });
    }

    return report;
  });

  console.log("Spatial index benchmark (headless Chromium, pure hit-test/cull selection, no canvas painting):");
  console.log("size\tlinear-hit(us/op)\tspatial-hit-warm(us/op)\tspatial-hit-cold(us/op)\tspeedup-warm\tlinear-cull(us/op)\tspatial-cull-warm(us/op)\tspatial-cull-cold(us/op)\tspeedup-warm");
  for (const row of results) {
    const linearHitPerOp = (row.linearHitMs / row.repeats) * 1000;
    const spatialHitPerOp = (row.spatialHitMs / row.repeats) * 1000;
    const coldHitPerOp = (row.coldHitMs / row.repeats) * 1000;
    const linearCullPerOp = (row.linearCullMs / row.repeats) * 1000;
    const spatialCullPerOp = (row.spatialCullMs / row.repeats) * 1000;
    const coldCullPerOp = (row.coldCullMs / row.repeats) * 1000;
    console.log(
      `${row.size}\t${linearHitPerOp.toFixed(2)}\t${spatialHitPerOp.toFixed(2)}\t${coldHitPerOp.toFixed(2)}\t`
      + `${(linearHitPerOp / spatialHitPerOp).toFixed(1)}x\t${linearCullPerOp.toFixed(2)}\t${spatialCullPerOp.toFixed(2)}\t${coldCullPerOp.toFixed(2)}\t`
      + `${(linearCullPerOp / spatialCullPerOp).toFixed(1)}x`,
    );
  }
} finally {
  await browser.close();
}
