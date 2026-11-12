export function verifyApplicationTitle(config, version) {
  const windows = config.app?.windows;
  const main = Array.isArray(windows) ? windows.filter(window => window.label === "main") : [];
  const expected = `D1 Manager ${version}`;
  if (main.length !== 1 || main[0].title !== expected) {
    throw new Error(`main window title must be ${JSON.stringify(expected)}`);
  }
  return expected;
}
