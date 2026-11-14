# Design direction

The interface follows the unslop method by Damir Sokolovsky
(https://github.com/heydamir/unslop, CC BY 4.0): write a direction from the
product, then fix spacing, colour, copy, type, layout, details and motion.

## Direction

- **Product.** A workbench where a GPU kernel author reads a CUDA, Triton or PTX
  kernel next to its PTX, and Ripple checks its own edits against the compile report.
- **Character.** Exact, dense, unhurried.
- **World.** A printed assembly listing on a lab bench at night.
- **Moments.** (1) The source and PTX listings side by side, with the highlighter
  band on linked lines. (2) The function row in the report: the register figure
  and the instruction mix bar.
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
- In PTX syntax the opcode is plain and the state space (`.global`, `.shared`,
  `.local`) is the one coloured part, because it says where memory goes.
- Motion: colour and background transitions at 140 ms, one easing curve.

All values are in `web/styles/tokens.css`. The Monaco theme in
`web/src/editor.js` repeats the hex values because Monaco needs hex.
