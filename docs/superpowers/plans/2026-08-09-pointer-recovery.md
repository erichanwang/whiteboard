# Pointer Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore drawing after middle-button pan loses pointer capture.

**Architecture:** Route pointer up, cancel, and lost capture through existing input-state cleanup. Cover real canvas behavior with Playwright.

**Tech Stack:** React, TypeScript, Playwright

## Global Constraints

- No resume edits.
- No new dependencies.
- Preserve middle-button pan.

---

### Task 1: Pointer recovery

**Files:**
- Modify: `tests/smoke.mjs`
- Modify: `src/App.tsx`

**Interfaces:**
- Consumes: canvas Pointer Events
- Produces: recovered pen input after lost capture

- [ ] Add failing middle-pan/lost-capture/draw regression.
- [ ] Run regression; confirm expected failure.
- [ ] Add minimal shared cleanup and lost-capture handler.
- [ ] Run regression, full browser tests, and build.
