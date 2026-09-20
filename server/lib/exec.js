import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

/**
 * Run an executable with an argument array. There is no shell, so user input can
 * never be interpreted as a command. Resolves with { stdout, stderr }.
 * Aborting `signal` kills the process. Rejects with an Error carrying `.notFound`
 * (executable missing), `.timedOut` or `.aborted`.
 */
export function run(file, args, { timeoutMs, signal, input, env, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      { timeout: timeoutMs, signal, killSignal: "SIGKILL", maxBuffer, shell: false, windowsHide: true, ...(env ? { env: { ...process.env, ...env } } : {}) },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr });
        error.stdout = stdout;
        error.stderr = stderr;
        error.notFound = error.code === "ENOENT";
        error.aborted = signal?.aborted === true;
        error.timedOut = !error.aborted && Boolean(error.killed) && error.signal === "SIGKILL" && timeoutMs !== undefined;
        reject(error);
      },
    );
    // `input` (for example a voice profile) goes to the child's stdin: never on the command line, where it would show up in `ps`.
    if (input !== undefined) child.stdin?.end(input);
  });
}

async function isExecutable(file) {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** True when `name` is an executable path or is found on PATH. Never runs the program. */
export async function executableExists(name) {
  if (name.includes(path.sep)) return isExecutable(name);
  const dirs = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    if (await isExecutable(path.join(dir, name))) return true;
  }
  return false;
}

export async function fileExists(file) {
  try {
    await access(file, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}
