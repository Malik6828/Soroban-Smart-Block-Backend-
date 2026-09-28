/**
 * Structured logger for SDK generation pipeline.
 * Provides consistent, structured logging with correlation IDs and context.
 */

type LogLevel = 'info' | 'warn' | 'error' | 'debug';
const IS_PROD = process.env.NODE_ENV === 'production';

interface LogEntry {
  level: LogLevel;
  message: string;
  timestamp: string;
  component: string;
  correlation_id?: string;
  operation?: string;
  duration_ms?: number;
  [key: string]: unknown;
}

class SDKLogger {
  private correlationId: string;
  private component: string;

  constructor(component: string) {
    this.component = component;
    this.correlationId = this.generateCorrelationId();
  }

  private generateCorrelationId(): string {
    return `sdk-gen-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  private log(level: LogLevel, message: string, meta?: Record<string, unknown>): void {
    const entry: LogEntry = {
      level,
      message,
      timestamp: new Date().toISOString(),
      component: this.component,
      correlation_id: this.correlationId,
      ...meta,
    };

    const line = IS_PROD ? JSON.stringify(entry) : this.prettyPrint(entry);

    if (level === 'error') {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }

  private prettyPrint(e: LogEntry): string {
    const { level, timestamp, component, correlation_id, message, ...rest } = e;
    const extras = Object.keys(rest).length ? ' ' + JSON.stringify(rest) : '';
    return `[${String(timestamp).slice(11, 23)}] ${String(level).toUpperCase().padEnd(5)} [${component}] ${message}${extras}`;
  }

  info(message: string, meta?: Record<string, unknown>): void {
    this.log('info', message, meta);
  }

  warn(message: string, meta?: Record<string, unknown>): void {
    this.log('warn', message, meta);
  }

  error(message: string, meta?: Record<string, unknown>): void {
    this.log('error', message, meta);
  }

  debug(message: string, meta?: Record<string, unknown>): void {
    this.log('debug', message, meta);
  }

  getCorrelationId(): string {
    return this.correlationId;
  }
}

// Singleton instance for the SDK generator
export const logger = new SDKLogger('sdk-generator');
