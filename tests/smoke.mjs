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

  const strokesBeforeKeyboardUndo = Number(await canvas.getAttribute("data-stroke-count"));
  await page.keyboard.press("Control+z");
  await page.waitForFunction((expected) => Number(document.querySelector("canvas")?.dataset.strokeCount) === expected, strokesBeforeKeyboardUndo - 1);
  await page.keyboard.press("Control+y");
  await page.waitForFunction((expected) => Number(document.querySelector("canvas")?.dataset.strokeCount) === expected, strokesBeforeKeyboardUndo);
  await page.keyboard.press("Control+z");
  await page.waitForFunction((expected) => Number(document.querySelector("canvas")?.dataset.strokeCount) === expected, strokesBeforeKeyboardUndo - 1);
  await page.getByRole("button", { name: "Hide grid" }).click();
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(50);
  if (Number(await canvas.getAttribute("data-stroke-count")) !== strokesBeforeKeyboardUndo - 1) throw new Error("Redo was not cleared after a newer board change.");
  await page.getByRole("button", { name: "Show grid" }).click();

  await page.getByRole("button", { name: "Blackboard" }).click();
  if (!(await page.locator("main").getAttribute("class"))?.includes("theme-black")) {
    throw new Error("Blackboard theme did not activate.");
  }
  await page.getByRole("button", { name: "Ink color #356f9f" }).click();
  await page.getByRole("button", { name: "New board" }).click();
  if (!(await page.locator("main").getAttribute("class"))?.includes("theme-black")) throw new Error("New board did not keep the blackboard theme.");
  if ((await page.getByRole("button", { name: "Pen (P)" }).getAttribute("aria-pressed")) !== "true") throw new Error("New board did not keep the pen tool.");
  if ((await page.getByRole("button", { name: "Ink color #356f9f" }).getAttribute("aria-pressed")) !== "true") throw new Error("New board did not keep the pen color.");
  if (!(await page.getByRole("button", { name: "Hide grid" }).isVisible())) throw new Error("New board did not keep the grid setting.");
  await page.locator(".tool-group").hover();
  await page.mouse.wheel(0, 40);
  await page.waitForFunction(() => document.querySelector('[aria-label="Eraser (E)"]')?.getAttribute("aria-pressed") === "true");
  await page.mouse.wheel(0, -40);
  await page.waitForFunction(() => document.querySelector('[aria-label="Pen (P)"]')?.getAttribute("aria-pressed") === "true");

  await page.getByRole("button", { name: "Recognition settings" }).click();
  await page.getByRole("dialog", { name: "Model recognition" }).waitFor();
  const blackboardSelectStyle = await page.getByLabel("Sample type").evaluate((element) => {
    const style = getComputedStyle(element);
    return { color: style.color, background: style.backgroundColor, colorScheme: style.colorScheme };
  });
  if (blackboardSelectStyle.colorScheme !== "dark" || blackboardSelectStyle.color !== "rgb(241, 242, 239)" || blackboardSelectStyle.background !== "rgb(32, 35, 36)") {
    throw new Error(`Blackboard dropdown colors are incorrect: ${JSON.stringify(blackboardSelectStyle)}`);
  }
  if (await page.locator(".tool-dock").evaluate((element) => getComputedStyle(element).boxShadow) !== "none") throw new Error("Tool dock still has an excessive shadow.");
  if (!(await page.getByRole("button", { name: "Use my handwriting" }).isDisabled())) throw new Error("Experimental handwriting should remain locked before five samples per lowercase letter.");
  await page.getByLabel("Middle mouse key").focus();
  await page.keyboard.press("Shift");
  await page.getByLabel("Left mouse key").focus();
  await page.keyboard.press("a");
  await page.keyboard.press("b");
  await page.getByRole("button", { name: "Close settings" }).click();

  const viewXBeforeBoundPan = Number(await canvas.getAttribute("data-view-x"));
  await page.mouse.move(box.x + 450, box.y + 300);
  await page.keyboard.down("Shift");
  await page.mouse.move(box.x + 485, box.y + 300, { steps: 4 });
  await page.keyboard.up("Shift");
  if (Number(await canvas.getAttribute("data-view-x")) === viewXBeforeBoundPan) throw new Error("Bound pan key did not act like a mouse button.");

  const strokesBeforeBoundLeft = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).strokes.length);
  await page.mouse.move(box.x + 520, box.y + 330);
  await page.keyboard.down("a");
  await page.mouse.move(box.x + 590, box.y + 390, { steps: 8 });
  await page.keyboard.up("a");
  const strokesAfterBoundLeft = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).strokes.length);
  if (strokesAfterBoundLeft !== strokesBeforeBoundLeft + 1) throw new Error("Bound left-mouse key did not use the current pen tool.");

  await page.mouse.move(box.x + 500, box.y + 310);
  await page.keyboard.down("x");
  await page.mouse.move(box.x + 610, box.y + 410, { steps: 6 });
  await page.keyboard.up("x");
  if (Number(await canvas.getAttribute("data-selected-count")) < 1) throw new Error("Bound right-mouse key did not select ink.");

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
  const restoredBindings = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.input.v1")));
  if (!restoredBindings.leftKeys.includes("a") || !restoredBindings.leftKeys.includes("b") || !restoredBindings.middleKeys.includes("Shift") || !restoredBindings.rightKeys.includes("x")) {
    throw new Error(`Mouse-key bindings did not persist: ${JSON.stringify(restoredBindings)}`);
  }
  if (!(await page.locator("main").getAttribute("class"))?.includes("theme-black")) throw new Error("Blackboard preference did not persist after restart.");
  if ((await page.getByRole("button", { name: "Ink color #356f9f" }).getAttribute("aria-pressed")) !== "true") throw new Error("Pen color preference did not persist after restart.");
  await page.getByRole("button", { name: "Handwriting practice" }).click();
  const restoredPractice = page.getByRole("complementary", { name: "Handwriting practice" });
  await restoredPractice.getByLabel("Exercise").selectOption("digits");
  if (!(await restoredPractice.getByRole("button", { name: "0: 1 samples" }).isVisible())) {
    throw new Error("Practice sample did not persist after reload.");
  }
  await restoredPractice.getByRole("button", { name: "Close practice" }).click();

  const strokesBeforePad = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).strokes.length);
  await page.getByRole("button", { name: "Lock cursor (M)" }).click();
  await page.getByText("Cursor locked - hold left click to draw, press M or Esc to release").waitFor();
  await page.mouse.move(box.x + 400, box.y + 300);
  await page.mouse.move(box.x + 430, box.y + 330, { steps: 4 });
  if (await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).strokes.length) !== strokesBeforePad) throw new Error("Locked cursor drew without a left click.");
  await page.mouse.down();
  await page.mouse.move(box.x + 470, box.y + 360, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("m");
  await page.getByText("Cursor locked - hold left click to draw, press M or Esc to release").waitFor({ state: "detached" });
  const strokesAfterPad = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).strokes.length);
  if (strokesAfterPad !== strokesBeforePad + 1) throw new Error("Locked cursor did not add one left-click stroke.");

  await page.getByRole("button", { name: "Save to Board Library" }).click();

  await page.getByRole("button", { name: "Text (T)" }).click();
  await page.mouse.click(box.x + 520, box.y + 210);
  const textEditor = page.getByRole("dialog", { name: "Add text" });
  await textEditor.getByLabel("Text content").fill("Typed note");
  await textEditor.getByRole("button", { name: "Insert text" }).click();
  const textCount = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects.length);
  if (textCount !== 1) throw new Error("Text tool did not add a text box.");

  await page.mouse.move(box.x + 500, box.y + 190);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(box.x + 620, box.y + 260, { steps: 5 });
  await page.mouse.up({ button: "right" });
  const transformBox = page.locator(".selection-transform-box");
  const transformBounds = await transformBox.boundingBox();
  if (!transformBounds) throw new Error("Selected text did not show transform controls.");
  await page.mouse.move(transformBounds.x + transformBounds.width / 2, transformBounds.y + transformBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(transformBounds.x + transformBounds.width / 2 + 30, transformBounds.y + transformBounds.height / 2 + 20, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const movedText = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects[0]);
  if (!(movedText.x > 520 && movedText.y > 210)) throw new Error("Dragging the selection did not move text.");
  const resizeHandle = page.getByRole("button", { name: "Resize selection" });
  const resizeBounds = await resizeHandle.boundingBox();
  if (!resizeBounds) throw new Error("Selection resize handle did not render.");
  await page.mouse.move(resizeBounds.x + 4, resizeBounds.y + 4);
  await page.mouse.down();
  await page.mouse.move(resizeBounds.x + 44, resizeBounds.y + 34, { steps: 4 });
  await page.mouse.up();
  await page.waitForTimeout(300);
  const resizedText = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects[0]);
  if (!(resizedText.fontSize > 20)) throw new Error("Resizing the selection did not scale text.");
  await page.getByRole("button", { name: "Delete selection (Delete)" }).click();
  if (await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects.length) !== 0) throw new Error("Delete selection button did not remove selected text.");
  await page.getByRole("button", { name: "Undo (Ctrl+Z)" }).click();
  if (await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects.length) !== 1) throw new Error("Undo button did not restore deleted text.");
  await page.getByRole("button", { name: "Redo (Ctrl+Y)" }).click();
  if (await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects.length) !== 0) throw new Error("Redo button did not reapply text deletion.");

  await page.getByRole("button", { name: "Insert LaTeX" }).click();
  const latexEditor = page.getByRole("dialog", { name: "Add LaTeX" });
  await latexEditor.getByLabel("LaTeX source").fill(String.raw`x^2 + y^2`);
  await latexEditor.getByLabel("LaTeX preview").waitFor();
  await latexEditor.getByRole("button", { name: "Insert LaTeX" }).click();
  const latexKind = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects.at(-1)?.kind);
  if (latexKind !== "latex") throw new Error("LaTeX insertion did not persist a LaTeX text object.");
  await page.locator(".latex-board-object .katex").waitFor();

  await page.getByRole("button", { name: "Clear screen" }).click();
  const clearMenu = page.getByRole("dialog", { name: "Clear content" });
  await clearMenu.getByRole("button", { name: "Clear visible screen" }).click();
  if (await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects.length) !== 0) throw new Error("Visible-screen clearing did not remove visible text.");
  await page.getByRole("button", { name: "Undo (Ctrl+Z)" }).click();
  if (await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")).textObjects.length) !== 1) throw new Error("Visible-screen clearing was not undoable.");

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
    const glyphCanvas = document.createElement("canvas");
    glyphCanvas.width = 8;
    glyphCanvas.height = 8;
    const glyphContext = glyphCanvas.getContext("2d");
    glyphContext.fillStyle = "#ffffff";
    glyphContext.fillRect(0, 0, 8, 8);
    glyphContext.fillStyle = "#000000";
    glyphContext.fillRect(2, 1, 4, 6);
    const glyphImage = glyphCanvas.toDataURL("image/png").split(",")[1];
    const recognitionSettings = JSON.parse(localStorage.getItem("whiteboard.recognition.v1"));
    for (const letter of "abcdefghijklmnopqrstuvwxyz") {
      for (let copy = 0; copy < 5; copy += 1) recognitionSettings.samples.push({
        id: crypto.randomUUID(), label: letter, image: glyphImage, exercise: "lowercase", mode: "text", createdAt: new Date().toISOString(),
      });
    }
    localStorage.setItem("whiteboard.recognition.v1", JSON.stringify(recognitionSettings));
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
  const restoredBox = await restoredCanvas.boundingBox();
  if (!restoredBox) throw new Error("Restored canvas did not render.");
  await page.mouse.move(restoredBox.x + 290, restoredBox.y + 290);
  await page.mouse.down({ button: "right" });
  await page.mouse.move(restoredBox.x + 360, restoredBox.y + 360, { steps: 5 });
  await page.mouse.up({ button: "right" });
  await page.keyboard.press("Delete");
  if (Number(await restoredCanvas.getAttribute("data-image-count")) !== 0) throw new Error("Delete key did not remove the selected image.");

  await page.getByRole("button", { name: "Clear screen" }).click();
  const entireBoardClear = page.getByRole("dialog", { name: "Clear content" });
  await entireBoardClear.getByRole("button", { name: "Entire board" }).click();
  await entireBoardClear.getByRole("button", { name: "Clear entire board" }).click();
  const clearedBoard = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.document.v1")));
  if (clearedBoard.strokes.length || clearedBoard.textObjects.length || clearedBoard.imageObjects.length) throw new Error("Entire-board clearing left content behind.");
  await page.getByRole("button", { name: "Undo (Ctrl+Z)" }).click();

  await page.getByRole("button", { name: "Board Library", exact: true }).click();
  await page.getByRole("dialog", { name: "Board Library" }).waitFor();
  await page.getByText("available in the installed Tauri app").waitFor();
  await page.getByRole("button", { name: "Close Board Library" }).click();

  await page.getByRole("button", { name: "Recognition settings" }).click();
  const handwritingToggle = page.getByRole("button", { name: "Use my handwriting" });
  if (await handwritingToggle.isDisabled()) throw new Error("Experimental handwriting did not unlock after five guided samples per lowercase letter.");
  await handwritingToggle.click();
  await page.getByRole("button", { name: "Close settings" }).click();
  await page.getByRole("button", { name: "Text (T)" }).click();
  await page.mouse.click(restoredBox.x + 420, restoredBox.y + 180);
  const handwritingEditor = page.getByRole("dialog", { name: "Add text" });
  await handwritingEditor.getByLabel("Text content").fill("abc");
  await handwritingEditor.getByRole("button", { name: "Insert text" }).click();
  await page.locator(".handwriting-glyph").first().waitFor();
  if (await page.locator(".handwriting-glyph").count() < 3) throw new Error("Experimental handwriting renderer did not use sampled lowercase glyphs.");

  await page.evaluate(() => {
    window.__TAURI_INTERNALS__ = {
      invoke: async (command) => command === "recognize_with_nvidia" ? "abc" : [],
    };
  });
  const feedbackBefore = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.recognition.v1")));
  await page.getByRole("button", { name: "Recognize" }).click();
  const recognitionPanel = page.getByRole("complementary", { name: "Recognition results" });
  await recognitionPanel.getByLabel("Correct the recognized text").waitFor();
  await page.locator(".recognition-highlight").waitFor();
  await recognitionPanel.getByRole("button", { name: "Looks correct" }).click();
  await recognitionPanel.getByText("Verified visual reference saved").waitFor();
  const positiveFeedback = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.recognition.v1")));
  if (positiveFeedback.samples.length !== feedbackBefore.samples.length + 1 || positiveFeedback.corrections.length !== feedbackBefore.corrections.length) throw new Error("Positive recognition feedback did not save exactly one visual sample.");
  await recognitionPanel.getByRole("button", { name: "Text", exact: true }).click();
  await recognitionPanel.getByLabel("Correct the recognized text").fill("abd");
  await recognitionPanel.getByRole("button", { name: "Save correction" }).click();
  await recognitionPanel.getByText("Correction and visual reference saved").waitFor();
  const correctedFeedback = await page.evaluate(() => JSON.parse(localStorage.getItem("whiteboard.recognition.v1")));
  if (correctedFeedback.samples.length !== positiveFeedback.samples.length + 1 || correctedFeedback.corrections.length !== positiveFeedback.corrections.length + 1) throw new Error("Corrected recognition did not save one sample and one correction.");
  await recognitionPanel.getByRole("button", { name: "Close recognition" }).click();
  if (await page.locator(".recognition-highlight").count()) throw new Error("Recognition highlight remained after closing the panel.");

  await page.setViewportSize({ width: 720, height: 600 });
  if (await page.locator(".save-state").isVisible()) throw new Error("Save status should be hidden before it can overlap narrow top-bar controls.");
  const horizontalOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  if (horizontalOverflow) throw new Error("The app overflows horizontally at the minimum window width.");

  console.log("Smoke test passed: timestamp naming, drawing/autosave, wheel tool cycling and canvas zoom, persistent key bindings and board defaults, undo/redo, move/resize/delete selection controls, visible/entire-board clearing, native text and LaTeX editors, left-click cursor lock, experimental sampled handwriting, embedded images, recognition highlight/positive/corrected feedback, library fallback, and narrow top-bar layout.");
} finally {
  await browser.close();
}
