import { chromium } from "playwright";

const browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

try {
  await page.goto("http://127.0.0.1:1420", { waitUntil: "networkidle" });
  await page.evaluate(() => localStorage.clear());
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("Starting Whiteboard").waitFor({ state: "detached" });

  await page.getByText("Start drawing").waitFor();
  const initialTitle = await page.getByLabel("Board title").inputValue();
  if (!/^Whiteboard \d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/.test(initialTitle)) {
    throw new Error(`Default board title does not contain the local date and time: ${initialTitle}`);
  }
  const canvas = page.locator("canvas");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("Canvas did not render.");

  await page.mouse.move(box.x + 180, box.y + 180);
  await page.mouse.down();
  await page.mouse.move(box.x + 230, box.y + 220, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const strokeCount = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).strokes.length);
  if (strokeCount !== 1) throw new Error(`Expected 1 saved stroke, found ${strokeCount}.`);

  const initialScale = Number(await canvas.getAttribute("data-scale"));
  const viewXBeforeWheel = Number(await canvas.getAttribute("data-view-x"));
  const viewYBeforeWheel = Number(await canvas.getAttribute("data-view-y"));
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -80);
  await page.waitForTimeout(50);
  const zoomedScale = Number(await canvas.getAttribute("data-scale"));
  if (!(zoomedScale > initialScale)) throw new Error("Wheel did not zoom at the cursor.");
  if (Number(await canvas.getAttribute("data-view-x")) === viewXBeforeWheel || Number(await canvas.getAttribute("data-view-y")) === viewYBeforeWheel) {
    throw new Error("Cursor-centered wheel zoom did not preserve its focal point.");
  }

  const viewXBeforePan = Number(await canvas.getAttribute("data-view-x"));
  await page.mouse.move(box.x + 420, box.y + 280);
  await page.mouse.down({ button: "middle" });
  await page.mouse.move(box.x + 470, box.y + 310, { steps: 4 });
  await page.mouse.up({ button: "middle" });
  const viewXAfterPan = Number(await canvas.getAttribute("data-view-x"));
  if (viewXAfterPan === viewXBeforePan) throw new Error("Middle-button drag did not pan the board.");

  await page.getByRole("button", { name: "Reset zoom to 100%" }).click();
  await page.mouse.move(box.x + 165, box.y + 165);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + 245, box.y + 235, { steps: 5 });
  await page.mouse.up({ button: "right" });
  if (Number(await canvas.getAttribute("data-selected-count")) < 1) throw new Error("Right-button drag did not select ink.");

  const gridButton = page.getByRole("button", { name: "Hide grid" });
  await gridButton.click();
  if ((await page.getByRole("button", { name: "Show grid" }).getAttribute("aria-pressed")) !== "false") {
    throw new Error("Grid toggle did not update its persisted state.");
  }
  await page.getByRole("button", { name: "Show grid" }).click();

  await page.keyboard.press("Control+z");
  await page.waitForTimeout(100);
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(100);

  await page.getByRole("button", { name: "Blackboard" }).click();
  if (!(await page.locator("main").getAttribute("class"))?.includes("theme-black")) {
    throw new Error("Blackboard theme did not activate.");
  }

  await page.getByRole("button", { name: "Recognition settings" }).click();
  await page.getByRole("dialog", { name: "Model recognition" }).waitFor();
  await page.getByLabel("Pan action key").focus();
  await page.keyboard.press("Shift");
  await page.getByRole("button", { name: "Close settings" }).click();

  const viewXBeforeBoundPan = Number(await canvas.getAttribute("data-view-x"));
  await page.mouse.move(box.x + 450, box.y + 300);
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + 485, box.y + 300, { steps: 4 });
  await page.keyboard.up("Shift");
  if (Number(await canvas.getAttribute("data-view-x")) === viewXBeforeBoundPan) throw new Error("Bound pan key did not act like a mouse button.");

  await page.getByRole("button", { name: "Handwriting practice" }).click();
  const practice = page.getByRole("complementary", { name: "Handwriting practice" });
  await practice.waitFor();
  await practice.getByLabel("Exercise").selectOption("digits");
  await practice.getByText("0", { exact: true }).first().waitFor();
  const practicePad = practice.getByLabel("Write 0 here");
  const practiceBox = await practicePad.boundingBox();
  if (!practiceBox) throw new Error("Practice writing pad did not render.");
  await page.mouse.move(practiceBox.x + 80, practiceBox.y + 45);
  await page.mouse.down();
  await page.mouse.move(practiceBox.x + 120, practiceBox.y + 130, { steps: 8 });
  await page.mouse.move(practiceBox.x + 70, practiceBox.y + 130, { steps: 5 });
  await page.mouse.move(practiceBox.x + 80, practiceBox.y + 45, { steps: 8 });
  await page.mouse.up();
  if (Number(await practicePad.getAttribute("data-stroke-count")) !== 1) throw new Error("Practice pad did not capture the stroke.");
  await practice.getByRole("button", { name: "Save sample and next" }).click();
  const sampleCount = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.recognition.v1")).samples.length);
  if (sampleCount !== 1) throw new Error(`Expected 1 practice sample, found ${sampleCount}.`);
  await practice.getByRole("button", { name: "Close practice" }).click();

  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("Starting Whiteboard").waitFor({ state: "detached" });
  await page.getByRole("button", { name: "Handwriting practice" }).click();
  const restoredPractice = page.getByRole("complementary", { name: "Handwriting practice" });
  await restoredPractice.getByLabel("Exercise").selectOption("digits");
  if (!(await restoredPractice.getByRole("button", { name: "0: 1 samples" }).isVisible())) {
    throw new Error("Practice sample did not persist after reload.");
  }
  await restoredPractice.getByRole("button", { name: "Close practice" }).click();

  const strokesBeforePad = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).strokes.length);
  await page.getByRole("button", { name: "Trackpad Pad" }).click();
  await page.getByRole("button", { name: "Click-free writing" }).click();
  const pad = page.getByRole("application", { name: "Mapped writing pad" });
  const padBox = await pad.boundingBox();
  if (!padBox) throw new Error("Mapped writing pad did not render.");
  await page.mouse.move(padBox.x + 40, padBox.y + 40);
  await page.mouse.move(padBox.x + 110, padBox.y + 90, { steps: 8 });
  await page.mouse.move(padBox.x + padBox.width + 10, padBox.y + 90);
  await page.waitForTimeout(50);
  const strokesAfterPad = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).strokes.length);
  if (strokesAfterPad !== strokesBeforePad + 1) throw new Error("Mapped writing pad did not add one stroke.");
  await page.getByRole("button", { name: "Close Trackpad Pad" }).click();

  await page.getByRole("button", { name: "Text (T)" }).click();
  page.once("dialog", (dialog) => dialog.accept("Typed note"));
  await page.mouse.click(box.x + 520, box.y + 210);
  const textCount = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects.length);
  if (textCount !== 1) throw new Error("Text tool did not add a text box.");

  page.once("dialog", (dialog) => dialog.accept(String.raw`x^2 + y^2`));
  await page.getByRole("button", { name: "Insert LaTeX" }).click();
  const latexKind = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects.at(-1)?.kind);
  if (latexKind !== "latex") throw new Error("LaTeX insertion did not persist a LaTeX text object.");
  await page.locator(".latex-board-object .katex").waitFor();

  await page.evaluate(() => {
    const source = document.createElement("canvas");
    source.width = 1;
    source.height = 1;
    const sourceContext = source.getContext("2d");
    sourceContext.fillStyle = "#0000ff";
    sourceContext.fillRect(0, 0, 1, 1);
    const board = JSON.parse(localStorage.getItem("whiteboard.document.v1"));
    board.imageObjects.push({
      id: crypto.randomUUID(),
      x: 300,
      y: 300,
      width: 50,
      height: 50,
      dataUrl: source.toDataURL("image/png"),
    });
    localStorage.setItem("whiteboard.document.v1", JSON.stringify(board));
  });
  await page.reload({ waitUntil: "networkidle" });
  await page.getByLabel("Starting Whiteboard").waitFor({ state: "detached" });
  const restoredCanvas = page.locator("canvas").first();
  if (Number(await restoredCanvas.getAttribute("data-image-count")) !== 1) throw new Error("Embedded image did not survive board reload.");
  await page.waitForTimeout(100);
  const imagePixelIsBlue = await restoredCanvas.evaluate((element) => {
    const canvas = element;
    const context = canvas.getContext("2d");
    const dpr = window.devicePixelRatio || 1;
    const pixel = context.getImageData(320 * dpr, 320 * dpr, 1, 1).data;
    return pixel[2] > 200 && pixel[0] < 60;
  });
  if (!imagePixelIsBlue) throw new Error("Embedded image was not rendered on the canvas.");

  await page.getByRole("button", { name: "Board Library" }).click();
  await page.getByRole("dialog", { name: "Board Library" }).waitFor();
  await page.getByText("available in the installed Tauri app").waitFor();
  await page.getByRole("button", { name: "Close Board Library" }).click();

  await page.getByRole("button", { name: "Recognize" }).click();
  await page.getByRole("complementary", { name: "Recognition results" }).waitFor();
  await page.getByText("Recognition unavailable").waitFor();

  await page.setViewportSize({ width: 720, height: 600 });
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (horizontalOverflow) throw new Error("The app overflows horizontally at the minimum window width.");

  console.log("Smoke test passed: timestamp naming, draw/autosave, wheel zoom, mouse and bound-key pan/select, grid, self-contained practice persistence, click-free mapped pad, text and LaTeX objects, embedded images, library fallback, theme, settings, recognition failure, and minimum-width layout.");
} finally {
  await browser.close();
}
