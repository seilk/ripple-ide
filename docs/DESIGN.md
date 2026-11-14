# Design direction

The interface follows the unslop method by Damir Sokolovsky
(https://github.com/heydamir/unslop, CC BY 4.0): write a direction from the
product, then fix spacing, colour, copy, type, layout, details and motion.

## Direction

- **Product.** An editor where Ripple writes beside you: ghost text while you type,
  and an agent that edits, runs and checks. Kernel authors also read a kernel
  next to its PTX.
- **Character.** Exact, dense, unhurried.
- **World.** A printed assembly listing on a lab bench at night.
- **Moments.** (1) The code itself: the listing, the ghost text, the diff.
  (2) For kernels, the source and PTX side by side with the highlighter band,
  and the function row in the report.
- **Signature.** The highlighter band. It is the only place the accent colour
  fills an area.

## Rules that follow

- Graphite surfaces, three text roles, one accent (`--accent`, highlighter amber).
  The accent marks linked lines, keyboard focus, flagged figures and the memory
  share of the instruction mix. Nothing else.
- Severity uses shape, not hue: a filled dot is a warning, a hollow dot is a note.
  Red is for compiler errors and rejected edits only.
- IBM Plex Sans for the interface and IBM Plex Mono for code, figures and line
  references. Weights 400 and 500. Sentence case. No italics.
- Spacing on a 4 px grid. Rows are 28 px, controls have an 8 px radius.
- Kernel controls (toolchain, arch, flags, report tabs, live compile) show only
  when a kernel file is open, so an ordinary file gets a quiet top bar.
- A toggle is quiet text with a small square: filled when on, hollow when off.
- In PTX syntax the opcode is plain and the state space (`.global`, `.shared`,
  `.local`) is the one coloured part, because it says where memory goes.
- Motion: colour and background transitions at 140 ms, one easing curve.

All values are in `web/styles/tokens.css`. The Monaco theme in
`web/src/editor.js` repeats the hex values because Monaco needs hex.
