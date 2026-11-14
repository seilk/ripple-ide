// What Ripple can do in the IDE, and what it is told about the session.

import { delta, snapshot } from './baseline.js';
import { summarize } from './ptx-analyze.js';
const MAX_DIAGNOSTICS_FOR_MODEL = 20;
const MAX_RUN_OUTPUT_CHARS = 8000;

/**
 * @param {{
 *   listFiles: () => Promise<Array<{path: string}>>,
 *   readText: (path: string) => Promise<string>,
 *   kernelKindOf: (path: string) => 'cuda'|'ptx'|'triton'|null,
 *   search: (query: string) => Promise<Array<{path: string, line: number, text: string}>>,
 *   confirmRun: (path: string) => Promise<boolean>,
 *   run: (path: string) => Promise<{code: number, output: string, seconds: number}>,
 *   compile: (path: string) => Promise<{res: any, analysis: any}>,
 *   baselineOf: (path: string) => {fns: Record<string, any>}|undefined,
 *   autoApply: () => boolean,
 *   confirmWrite: (path: string, before: string, after: string) => Promise<boolean>,
 *   applyWrite: (path: string, content: string) => Promise<void>,
 *   recordChange: (change: {path: string, before: string, after: string, existed: boolean}) => string,
 * }} ide
 */
export function createRippleTools(ide) {
  /** Ask first, or apply at once and keep the old text so the user can review and undo. */
  async function change(path, before, after, existed) {
    const auto = ide.autoApply();
    if (!auto && !(await ide.confirmWrite(path, before, after))) return null;
    await ide.applyWrite(path, after);
    return auto ? ide.recordChange({ path, before, after, existed }) : '';
  }

  return {
    list_files: () => ide.listFiles(),

    read_file: ({ path }) => {
      if (typeof path !== 'string' || !path) throw new Error('path is required');
      return ide.readText(path);
    },

    search_files: ({ query }) => {
      if (typeof query !== 'string' || query.length < 2) throw new Error('query needs at least 2 characters');
      return ide.search(query);
    },

    run_file: async ({ path }) => {
      if (typeof path !== 'string' || !path) throw new Error('path is required');
      if (!(await ide.confirmRun(path))) return { rejected: true, message: 'The user did not allow this run.' };
      const { code, output, seconds } = await ide.run(path);
      return { exit_code: code, seconds, output: output.slice(-MAX_RUN_OUTPUT_CHARS) };
    },

    compile_kernel: async ({ path }) => {
      const kind = ide.kernelKindOf(path);
      if (kind === null) return { error: 'Not a kernel file. compile_kernel is for .cu and .ptx files.' };
      if (kind === 'triton') return { error: 'Triton files run Python on the runner. Ask the user to press Run.' };
      const { res, analysis } = await ide.compile(path);
      const base = ide.baselineOf(path);
      const now = analysis ? snapshot(analysis, res.ptxas.functions) : {};
      const changes = Object.fromEntries(Object.keys(now).map((symbol) => [symbol, delta(base?.fns[symbol], now[symbol])]));
      return {
        ok: res.ok, backend: res.backend, arch: res.arch, notes: res.notes,
        diagnostics: res.diagnostics.slice(0, MAX_DIAGNOSTICS_FOR_MODEL),
        ...(analysis && res.ok ? summarize(analysis, path, res.ptxas.functions, changes) : { functions: [], lints: [] }),
      };
    },

    edit_file: async ({ path, old_text: oldText, new_text: newText }) => {
      if (typeof path !== 'string' || !path) throw new Error('path is required');
      if (typeof oldText !== 'string' || !oldText || typeof newText !== 'string') throw new Error('old_text and new_text are required');
      const before = await ide.readText(path);
      const first = before.indexOf(oldText);
      if (first === -1) return { error: 'old_text was not found in the file. Read the file and copy the text exactly.' };
      if (before.indexOf(oldText, first + 1) !== -1) return { error: 'old_text occurs more than once. Include more lines around it.' };
      const after = before.slice(0, first) + newText + before.slice(first + oldText.length);
      const changeId = await change(path, before, after, true);
      if (changeId === null) return { rejected: true, message: 'The user rejected this change.' };
      return { edited: path, replaced_chars: oldText.length, new_chars: newText.length, ...(changeId ? { change_id: changeId } : {}) };
    },

    write_file: async ({ path, content }) => {
      if (typeof path !== 'string' || !path) throw new Error('path is required');
      if (typeof content !== 'string') throw new Error('content must be a string');
      const files = await ide.listFiles();
      const existed = files.some((file) => file.path === path);
      const before = existed ? await ide.readText(path) : '';
      const changeId = await change(path, before, content, existed);
      if (changeId === null) return { rejected: true, message: 'The user rejected this change.' };
      return { [existed ? 'written' : 'created']: path, bytes: content.length, ...(changeId ? { change_id: changeId } : {}) };
    },
  };
}

/** @param {{active: string|null, kernel: string|null, toolchain: any, arch: string, canRun: boolean, autoApply: boolean}} session */
export function systemPrompt({ active, kernel, toolchain, arch, canRun, autoApply }) {
  const tc = toolchain || {};
  const lines = [
    'You are Ripple, the coding model inside Ripple IDE. You work on the files of the open project with tools.',
    'Read before you edit. Use search_files to find things. Check your work: run the file or compile the kernel '
      + 'after an edit, and report what the tool showed. Do not claim a result that no tool showed.',
    'When the user asks you to make, build or fix something, do it with the tools: create the file with write_file or '
      + 'change it with edit_file. Do not paste the code into the chat and stop there. Look at the files near it first, '
      + 'so a new file sits in the right folder and matches what is there.',
    'To change an existing file use edit_file: it replaces one exact piece of text and is much faster than write_file, '
      + 'which sends the whole file again. Use write_file for new files only. Explain each change in one line.',
    autoApply
      ? 'Changes are applied at once, with no question to the user. The user can review and undo each one afterwards.'
      : 'The user sees a diff of every change and can reject it.',
    canRun ? 'run_file runs a .py, .js, .mjs or .sh file after the user allows it.' : 'run_file is off on this server.',
    `Active file: ${active || '(none)'}`,
  ];
  if (kernel) {
    lines.push(
      `The active file is a GPU kernel (${kernel}). Work like a kernel engineer: compile it, read the report, then act. `
        + 'After every edit, compile again and read change_vs_baseline. The report counts instructions, loops, memory '
        + 'traffic by state space, double-precision ops, thread-local memory and (with ptxas) registers and spills. '
        + 'It does not measure run time.',
      `Toolchain: frontend=${tc.cuda_frontend || 'none'}, ptxas=${tc.ptxas ? 'yes' : 'no'}, arch=${arch}, runner=${tc.runner || 'local'}`,
      tc.cuda_frontend === 'clang-nvptx' ? 'The PTX is a clang NVPTX preview, not nvcc output. Say so when it matters.' : '',
    );
  }
  return lines.filter(Boolean).join('\n');
}
