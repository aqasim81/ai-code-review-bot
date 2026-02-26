import { env } from "@/lib/env";

type LogLevel = "debug" | "info" | "warn" | "error";

interface LogContext {
  [key: string]: unknown;
}

function formatMessage(
  level: LogLevel,
  message: string,
  context?: LogContext,
): string {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  };
  return JSON.stringify(entry);
}

export const logger = {
  debug(message: string, context?: LogContext): void {
    if (env.NODE_ENV !== "production") {
      // biome-ignore lint/suspicious/noConsole: logger is the sanctioned console wrapper
      console.debug(formatMessage("debug", message, context));
    }
  },

  info(message: string, context?: LogContext): void {
    // biome-ignore lint/suspicious/noConsole: logger is the sanctioned console wrapper
    console.info(formatMessage("info", message, context));
  },

  warn(message: string, context?: LogContext): void {
    // biome-ignore lint/suspicious/noConsole: logger is the sanctioned console wrapper
    console.warn(formatMessage("warn", message, context));
  },

  error(message: string, context?: LogContext): void {
    // biome-ignore lint/suspicious/noConsole: logger is the sanctioned console wrapper
    console.error(formatMessage("error", message, context));
  },
};
