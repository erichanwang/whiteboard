# Pointer Recovery Design

Middle-button pan must never block later pen input, including release outside the canvas or window. Reuse one cleanup path for pointer up, pointer cancel, and lost pointer capture. Add one browser regression that pans, loses capture, then draws.

Resume files remain read-only. No dependencies or unrelated refactors.
