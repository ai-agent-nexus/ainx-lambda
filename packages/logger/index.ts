export interface LogContext {
  [key: string]: unknown;
}

export interface LogEntry {
  timestamp: string;
  level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';
  service: string;
  message: string;
  context?: LogContext;
}

export class Logger {
  private service: string;

  constructor(service: string) {
    this.service = service;
  }

  private log(level: LogEntry['level'], message: string, context?: LogContext): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      service: this.service,
      message,
      context,
    };

    // In production, you might want to send this to CloudWatch or another logging service
    console.log(JSON.stringify(entry));
  }

  debug(message: string, context?: LogContext): void {
    this.log('DEBUG', message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('INFO', message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('WARN', message, context);
  }

  error(message: string, context?: LogContext): void {
    this.log('ERROR', message, context);
  }
}
