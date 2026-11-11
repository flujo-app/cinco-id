/**
 * Turns a problem that stopped the computer from starting into a few plain sentences for the
 * error window, so nobody is left with a program that runs without showing anything.
 */
export function explainStartProblem(error, { dataDir = null } = {}) {
  const message = String(error?.message ?? error ?? 'unknown problem');
  if (/could not be read/.test(message) && /harness\.config\.json|\.json/.test(message)) {
    return `The settings file could not be read, so CINCO ID did not start.\n\n${message}\n\n`
      + 'Fix the file, or rename or delete it to start again with the Setup window.';
  }
  if (error?.code === 'EACCES' || error?.code === 'EPERM') {
    return `CINCO ID may not write to its data folder${dataDir ? ` (${dataDir})` : ''}, so it did not start.\n\n${message}`;
  }
  if (error?.code === 'EADDRINUSE') {
    return `No free port could be found for CINCO ID's screen, so it did not start.\n\n${message}`;
  }
  return `Something went wrong while CINCO ID was starting, so it stopped.\n\n${message}`;
}
