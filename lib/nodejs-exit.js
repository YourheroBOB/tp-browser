// Decide the process exit code for `tp-browser nodejs` without talking to the daemon.

export function resolveNodeJsExitCode({ scriptExitCode, threw } = {}) {
  if (threw) return 1;
  if (typeof scriptExitCode === 'number' && Number.isInteger(scriptExitCode)) return scriptExitCode;
  return 0;
}
