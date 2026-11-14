// Baseline numbers for a file: what a later compile is compared against.
// For every tracked number, lower is better.

export const TRACKED = ['instructions', 'fp64Ops', 'localDepotBytes', 'registers'];

/**
 * @param {{functions: Array<any>}} analysis
 * @param {Array<{function: string, registers: number}>} [ptxasFunctions]
 * @returns {Record<string, Record<string, number|null>>} numbers by function symbol
 */
export function snapshot(analysis, ptxasFunctions = []) {
  const registers = new Map(ptxasFunctions.map((f) => [f.function, f.registers]));
  return Object.fromEntries(analysis.functions.map((fn) => [fn.name, {
    instructions: fn.instructions,
    fp64Ops: fn.fp64Ops,
    localDepotBytes: fn.localDepotBytes,
    registers: registers.get(fn.name) ?? null,
  }]));
}

/**
 * @param {Record<string, number|null>|undefined} before
 * @param {Record<string, number|null>} now
 * @returns {Record<string, number>} only the numbers that changed
 */
export function delta(before, now) {
  if (!before) return {};
  const out = {};
  for (const key of TRACKED) {
    if (before[key] == null || now[key] == null) continue;
    if (now[key] !== before[key]) out[key] = now[key] - before[key];
  }
  return out;
}

/** @param {number} n @returns {string} like "−6" or "+2" */
export function signed(n) {
  return n < 0 ? `−${Math.abs(n)}` : `+${n}`;
}
