import { chromium } from "playwright";

// Verifies the wire-format version bump in src/board.ts serializeBoard/parseBoard
// (JSON with binary-packed stroke points, "fmt":2) added to push compression
// past 10x: (1) old boards saved before this change - plain JSON `points`
// arrays, no `fmt` field - still load correctly through parseBoard, and
// (2) a board round-tripped through the new serializeBoard/parseBoard comes
// back with the same points (within the pre-existing 0.01 rounding).

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

try {
  await page.goto("http://127.0.0.1:1420", { waitUntil: "networkidle" });

  const results = await page.evaluate(async () => {
    const { serializeBoard, parseBoard, createBoard } = await import("/src/board.ts");

    // 1. Old-format (pre-binary) board: plain points arrays, no "fmt" field.
    const legacyJson = JSON.stringify({
      version: 1,
      id: "legacy-board",
      title: "Legacy board",
      theme: "white",
      grid: true,
      strokes: [
        {
          id: "legacy-stroke",
          color: "#111111",
          width: 3,
          pointerType: "pen",
          points: [
            { x: 10.5, y: 20.25, pressure: 0.4 },
            { x: 15.75, y: 25.1, pressure: 0.6 },
            { x: -100, y: 50, pressure: 1 },
          ],
        },
      ],
      textObjects: [{ id: "t1", x: 1, y: 2, value: "hi", color: "#111111", kind: "text" }],
      imageObjects: [],
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
    const legacyParsed = parseBoard(legacyJson);

    // 2. Round-trip through the new format.
    const board = { ...createBoard(), id: "roundtrip-board" };
    board.strokes = [
      {
        id: "s1",
        color: "#222222",
        width: 4,
        pointerType: "pen",
        points: [
          { x: 0, y: 0, pressure: 0.1 },
          { x: 12.34, y: -56.78, pressure: 0.55 },
          { x: 1000.99, y: -1000.99, pressure: 1 },
          { x: 1000.99, y: -1000.5, pressure: 0 },
        ],
      },
      { id: "s2-empty-ish", color: "auto", width: 1, pointerType: "mouse", points: [{ x: 5, y: 5, pressure: 0.3 }] },
    ];
    const serialized = serializeBoard(board);
    const roundTripped = parseBoard(serialized);

    return {
      legacyStrokeCount: legacyParsed.strokes.length,
      legacyPoints: legacyParsed.strokes[0]?.points,
      legacyTextCount: legacyParsed.textObjects.length,
      serializedHasFmt2: JSON.parse(serialized).fmt === 2,
      serializedStrokesHavePts: JSON.parse(serialized).strokes.every((s) => typeof s.pts === "string"),
      serializedStrokesLackPointsArray: JSON.parse(serialized).strokes.every((s) => !("points" in s)),
      roundTrippedStrokeCount: roundTripped.strokes.length,
      roundTrippedPoints: roundTripped.strokes.map((s) => s.points),
      originalPoints: board.strokes.map((s) => s.points),
    };
  });

  if (results.legacyStrokeCount !== 1 || results.legacyTextCount !== 1) {
    throw new Error(`Old-format board did not load correctly: ${JSON.stringify(results)}`);
  }
  const expectedLegacy = [
    { x: 10.5, y: 20.25, pressure: 0.4 },
    { x: 15.75, y: 25.1, pressure: 0.6 },
    { x: -100, y: 50, pressure: 1 },
  ];
  for (let index = 0; index < expectedLegacy.length; index += 1) {
    const got = results.legacyPoints[index];
    const want = expectedLegacy[index];
    if (Math.abs(got.x - want.x) > 1e-9 || Math.abs(got.y - want.y) > 1e-9 || Math.abs(got.pressure - want.pressure) > 1e-9) {
      throw new Error(`Old-format board point ${index} did not round-trip exactly: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
    }
  }

  if (!results.serializedHasFmt2 || !results.serializedStrokesHavePts || !results.serializedStrokesLackPointsArray) {
    throw new Error(`serializeBoard did not emit the binary wire format: ${JSON.stringify(results)}`);
  }

  if (results.roundTrippedStrokeCount !== results.originalPoints.length) {
    throw new Error(`Round-trip lost a stroke: ${JSON.stringify(results)}`);
  }
  for (let strokeIndex = 0; strokeIndex < results.originalPoints.length; strokeIndex += 1) {
    const original = results.originalPoints[strokeIndex];
    const roundTripped = results.roundTrippedPoints[strokeIndex];
    if (original.length !== roundTripped.length) {
      throw new Error(`Stroke ${strokeIndex} point count changed on round-trip: ${original.length} -> ${roundTripped.length}`);
    }
    for (let pointIndex = 0; pointIndex < original.length; pointIndex += 1) {
      const want = original[pointIndex];
      const got = roundTripped[pointIndex];
      // Binary format quantizes to the same 0.01 unit that roundSerializedNumber
      // already applied to the legacy JSON format, so allow that much slack.
      if (Math.abs(got.x - want.x) > 0.01 || Math.abs(got.y - want.y) > 0.01 || Math.abs(got.pressure - want.pressure) > 0.01) {
        throw new Error(`Stroke ${strokeIndex} point ${pointIndex} did not round-trip: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
      }
    }
  }

  console.log("Format compatibility and round-trip tests passed.");
} finally {
  await browser.close();
}
