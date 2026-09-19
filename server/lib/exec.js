import { execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";
import path from "node:path";

/**
 * Run an executable with an argument array. There is no shell, so user input can
 * never be interpreted as a command. Resolves with { stdout, stderr }.
 * Rejects with an Error carrying `.notFound` (executable missing) or `.timedOut`.
 */
export function run(file, args, { timeoutMs, maxBuffer = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, killSignal: "SIGKILL", maxBuffer, shell: false, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve({ stdout, stderr });
        error.stderr = stderr;
        error.notFound = error.code === "ENOENT";
        error.timedOut = Boolean(error.killed) && error.signal === "SIGKILL" && timeoutMs !== undefined;
        reject(error);
      },
    );
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
