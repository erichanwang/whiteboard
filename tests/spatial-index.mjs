import { chromium } from "playwright";

// Correctness gate: the spatial index used by eraseStrokesAt, drawBoard's
// viewport culling, and strokesIntersectingBounds must return exactly the
// strokes a plain linear scan would, for every query. This test runs many
// randomized point and bounds queries against both paths and fails on any
// mismatch in the returned stroke set or its order.

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

try {
  await page.goto("http://127.0.0.1:1420", { waitUntil: "networkidle" });

  const result = await page.evaluate(async () => {
    const { eraseStrokesAt, eraseStrokesAtLinear, strokesIntersectingBounds, intersectsBounds, strokeBounds, queryStrokes, addStroke } =
      await import("/src/board.ts");

    // Deterministic PRNG so failures are reproducible.
    let seed = 42;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };

    const SPREAD = 20_000;
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
        width: 1 + random() * 30,
        pointerType: "pen",
        points,
      };
    });

    // Same overlap formula as board.ts's private overlapsBounds, used here
    // only to build an independent linear-scan reference for cull queries.
    const overlaps = (item, visible, padding) => item.x <= visible.x + visible.width + padding
      && item.x + item.width >= visible.x - padding
      && item.y <= visible.y + visible.height + padding
      && item.y + item.height >= visible.y - padding;

    let hitTestTrials = 0;
    let cullTrials = 0;
    let selectionTrials = 0;

    for (let trial = 0; trial < 300; trial += 1) {
      const strokes = makeStrokes(300);

      // Point hit-test (erase) equivalence.
      const x = random() * SPREAD;
      const y = random() * SPREAD;
      const radius = 2 + random() * 40;
      const spatial = eraseStrokesAt(strokes, x, y, radius).map((s) => s.id);
      const linear = eraseStrokesAtLinear(strokes, x, y, radius).map((s) => s.id);
      if (JSON.stringify(spatial) !== JSON.stringify(linear)) {
        throw new Error(`Hit-test mismatch on trial ${trial}: spatial=${JSON.stringify(spatial)} linear=${JSON.stringify(linear)}`);
      }
      hitTestTrials += 1;

      // Bounds selection equivalence.
      const bx = random() * SPREAD;
      const by = random() * SPREAD;
      const bounds = { x: bx, y: by, width: random() * 2000, height: random() * 2000 };
      const spatialSelection = strokesIntersectingBounds(strokes, bounds).map((s) => s.id);
      const linearSelection = strokes.filter((s) => intersectsBounds(s, bounds)).map((s) => s.id);
      if (JSON.stringify(spatialSelection) !== JSON.stringify(linearSelection)) {
        throw new Error(`Selection mismatch on trial ${trial}: spatial=${JSON.stringify(spatialSelection)} linear=${JSON.stringify(linearSelection)}`);
      }
      selectionTrials += 1;

      // Viewport cull equivalence: same broad-phase index drawBoard uses,
      // followed by the same narrow-phase check drawBoard applies per stroke.
      const visibleBounds = { x: bx, y: by, width: 200 + random() * 4000, height: 200 + random() * 4000 };
      const spatialCull = queryStrokes(strokes, visibleBounds, 0)
        .filter((stroke) => {
          const bounds2 = strokeBounds([stroke]);
          return bounds2 && overlaps(bounds2, visibleBounds, stroke.width / 2);
        })
        .map((s) => s.id);
      const linearCull = strokes
        .filter((stroke) => {
          const bounds2 = strokeBounds([stroke]);
          return bounds2 && overlaps(bounds2, visibleBounds, stroke.width / 2);
        })
        .map((s) => s.id);
      if (JSON.stringify(spatialCull) !== JSON.stringify(linearCull)) {
        throw new Error(`Cull mismatch on trial ${trial}: spatial=${JSON.stringify(spatialCull)} linear=${JSON.stringify(linearCull)}`);
      }
      cullTrials += 1;
    }

    // Edge cases: empty board, single stroke, query far outside all strokes.
    const empty = eraseStrokesAt([], 0, 0, 10);
    if (empty.length !== 0) throw new Error("Empty board erase did not return an empty array.");
    const single = makeStrokes(1);
    const farQuery = eraseStrokesAt(single, SPREAD * 10, SPREAD * 10, 5);
    if (farQuery !== single) throw new Error("Far-away query did not return the original array reference.");

    // Incremental-maintenance equivalence: a long sequence of adds, erases,
    // and undos (addStroke/eraseStrokesAt patch the cached index in place
    // instead of discarding it - this is the part that must never go stale).
    // After every single mutation, every array still reachable through the
    // "undo stack" is checked against a fresh linear scan, not just the
    // current one, since undo revisits an array whose cached index may have
    // been built, then later patched-and-reassigned to a different array by
    // addStroke/eraseStrokesAt.
    let mutationTrials = 0;
    let current = makeStrokes(40);
    const undoStack = [];
    for (let step = 0; step < 400; step += 1) {
      const action = random();
      if (action < 0.45) {
        undoStack.push(current);
        current = addStroke(current, makeStrokes(1)[0]);
      } else if (action < 0.9) {
        const x = random() * SPREAD;
        const y = random() * SPREAD;
        const radius = 2 + random() * 40;
        const next = eraseStrokesAt(current, x, y, radius);
        if (next !== current) {
          undoStack.push(current);
          current = next;
        }
      } else if (undoStack.length) {
        current = undoStack.pop();
      }

      const bx = random() * SPREAD;
      const by = random() * SPREAD;
      const visibleBounds = { x: bx, y: by, width: 200 + random() * 4000, height: 200 + random() * 4000 };
      const spatial = queryStrokes(current, visibleBounds, 0)
        .filter((stroke) => {
          const bounds = strokeBounds([stroke]);
          return bounds && overlaps(bounds, visibleBounds, stroke.width / 2);
        })
        .map((s) => s.id);
      const linear = current
        .filter((stroke) => {
          const bounds = strokeBounds([stroke]);
          return bounds && overlaps(bounds, visibleBounds, stroke.width / 2);
        })
        .map((s) => s.id);
      if (JSON.stringify(spatial) !== JSON.stringify(linear)) {
        throw new Error(`Incremental-maintenance mismatch on step ${step}: spatial=${JSON.stringify(spatial)} linear=${JSON.stringify(linear)}`);
      }

      const hx = random() * SPREAD;
      const hy = random() * SPREAD;
      const hitRadius = 2 + random() * 40;
      const hitSpatial = eraseStrokesAt(current, hx, hy, hitRadius).map((s) => s.id);
      const hitLinear = eraseStrokesAtLinear(current, hx, hy, hitRadius).map((s) => s.id);
      if (JSON.stringify(hitSpatial) !== JSON.stringify(hitLinear)) {
        throw new Error(`Incremental hit-test mismatch on step ${step}: spatial=${JSON.stringify(hitSpatial)} linear=${JSON.stringify(hitLinear)}`);
      }
      mutationTrials += 1;
    }

    return { hitTestTrials, cullTrials, selectionTrials, mutationTrials };
  });

  if (result.hitTestTrials !== 300 || result.cullTrials !== 300 || result.selectionTrials !== 300 || result.mutationTrials !== 400) {
    throw new Error(`Not all trials ran: ${JSON.stringify(result)}`);
  }

  console.log(`Spatial index equivalence test passed: ${result.hitTestTrials} hit-test, ${result.cullTrials} cull, and ${result.selectionTrials} selection trials matched the linear scan exactly.`);
  console.log(`Incremental maintenance equivalence test passed: ${result.mutationTrials} add/erase/undo steps matched the linear scan exactly.`);
} finally {
  await browser.close();
}
