const {
  flushTelemetry,
  getCurrentLogger,
  loggerIsSet,
  setLogger,
  setLoggerIfUnset,
  shutdownTelemetry,
} = require("../index.js");

const makeLogger = () => ({
  error: () => {},
  warn: () => {},
  info: () => {},
  debug: () => {},
  trace: () => {},
});

// The module installs a console logger at load. It does not count as set, so
// a library that embeds Prosody can supply a logger once, and a host logger
// set later still replaces it.
test("only an application logger counts as set", () => {
  expect(loggerIsSet()).toBe(false);

  const embedded = makeLogger();
  expect(setLoggerIfUnset(embedded)).toBe(true);
  expect(loggerIsSet()).toBe(true);
  expect(getCurrentLogger()).toBe(embedded);

  expect(setLoggerIfUnset(makeLogger())).toBe(false);
  expect(getCurrentLogger()).toBe(embedded);

  const host = makeLogger();
  setLogger(host);
  expect(getCurrentLogger()).toBe(host);

  // The telemetry exports stay public functions.
  expect(flushTelemetry).toEqual(expect.any(Function));
  expect(shutdownTelemetry).toEqual(expect.any(Function));
});
