/**
 * The logger interface and the logger setters.
 * @module lib/logging
 */

/**
 * JavaScript logger interface for use with Prosody client.
 *
 * Each logging method receives a message string and optional metadata object.
 */
export interface Logger {
  /** Logs error-level messages. */
  error: (
    message: string | undefined | null,
    metadata?: Record<string, unknown>,
  ) => void;
  /** Logs warning-level messages. */
  warn: (
    message: string | undefined | null,
    metadata?: Record<string, unknown>,
  ) => void;
  /** Logs info-level messages. */
  info: (
    message: string | undefined | null,
    metadata?: Record<string, unknown>,
  ) => void;
  /** Logs debug-level messages. */
  debug: (
    message: string | undefined | null,
    metadata?: Record<string, unknown>,
  ) => void;
  /** Logs trace-level messages. */
  trace: (
    message: string | undefined | null,
    metadata?: Record<string, unknown>,
  ) => void;
}

/**
 * Sets a new JavaScript logger for the Prosody client.
 *
 * This function configures the logging system to use the provided JavaScript logger
 * for all log output. The logger must implement all required log levels.
 *
 * @param logger - The JavaScript logger object with error, warn, info, debug, and trace methods.
 * @throws Error if creating the new JavaScript logger fails.
 */
export function setLogger(logger: Logger): void;

/**
 * Sets a JavaScript logger only if no logger is currently configured.
 *
 * This function is useful for providing a default logger without overriding
 * an existing one that may have been set earlier.
 *
 * @param logger - The JavaScript logger object with error, warn, info, debug, and trace methods.
 * @returns True if the logger was set (no previous logger existed), false if a logger was already configured.
 * @throws Error if creating the new JavaScript logger fails.
 */
export function setLoggerIfUnset(logger: Logger): boolean;

/**
 * Gets the current configured logger.
 *
 * @returns The current logger instance, or null/undefined if no logger is configured.
 */
export function getCurrentLogger(): Logger | null | undefined;
