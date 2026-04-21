import { ConsoleLogger } from '@nestjs/common';
import { logs, SeverityNumber } from '@opentelemetry/api-logs';

export class OtelLogger extends ConsoleLogger {
  private readonly otelLogger = logs.getLogger('pp-sketch');

  override log(message: any, ...optionalParams: any[]): void {
    super.log(message, ...optionalParams);
    this.emitOtelLog({
      severityNumber: SeverityNumber.INFO,
      severityText: 'INFO',
      message,
      optionalParams,
    });
  }

  override error(message: any, ...optionalParams: any[]): void {
    super.error(message, ...optionalParams);
    this.emitOtelLog({
      severityNumber: SeverityNumber.ERROR,
      severityText: 'ERROR',
      message,
      optionalParams,
    });
  }

  override warn(message: any, ...optionalParams: any[]): void {
    super.warn(message, ...optionalParams);
    this.emitOtelLog({
      severityNumber: SeverityNumber.WARN,
      severityText: 'WARN',
      message,
      optionalParams,
    });
  }

  override debug(message: any, ...optionalParams: any[]): void {
    super.debug(message, ...optionalParams);
    this.emitOtelLog({
      severityNumber: SeverityNumber.DEBUG,
      severityText: 'DEBUG',
      message,
      optionalParams,
    });
  }

  override verbose(message: any, ...optionalParams: any[]): void {
    super.verbose(message, ...optionalParams);
    this.emitOtelLog({
      severityNumber: SeverityNumber.TRACE,
      severityText: 'TRACE',
      message,
      optionalParams,
    });
  }

  override fatal(message: any, ...optionalParams: any[]): void {
    super.fatal(message, ...optionalParams);
    this.emitOtelLog({
      severityNumber: SeverityNumber.FATAL,
      severityText: 'FATAL',
      message,
      optionalParams,
    });
  }

  private emitOtelLog(opts: {
    severityNumber: SeverityNumber;
    severityText: string;
    message: unknown;
    optionalParams: unknown[];
  }): void {
    const lastParam = opts.optionalParams[opts.optionalParams.length - 1];
    const logContext =
      opts.optionalParams.length > 0 && typeof lastParam === 'string'
        ? lastParam
        : undefined;

    const firstParam = opts.optionalParams[0];
    const stack =
      opts.severityNumber >= SeverityNumber.ERROR &&
      opts.optionalParams.length >= 2 &&
      typeof firstParam === 'string'
        ? firstParam
        : undefined;

    this.otelLogger.emit({
      severityNumber: opts.severityNumber,
      severityText: opts.severityText,
      body:
        typeof opts.message === 'string'
          ? opts.message
          : JSON.stringify(opts.message),
      attributes: {
        ...(logContext !== undefined ? { 'log.context': logContext } : {}),
        ...(stack !== undefined ? { 'exception.stacktrace': stack } : {}),
      },
    });
  }
}
