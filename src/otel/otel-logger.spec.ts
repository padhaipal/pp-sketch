const mockOtelEmit = jest.fn();
const mockGetLogger = jest.fn(() => ({ emit: mockOtelEmit }));

jest.mock('@opentelemetry/api-logs', () => {
  // Mirror the SeverityNumber enum values the production code compares
  // against (specifically the ERROR threshold for the stack-extraction branch).
  const SeverityNumber = {
    TRACE: 1,
    DEBUG: 5,
    INFO: 9,
    WARN: 13,
    ERROR: 17,
    FATAL: 21,
  };
  return {
    logs: { getLogger: (...args: unknown[]) => mockGetLogger(...args) },
    SeverityNumber,
  };
});

// Silence the ConsoleLogger stdout output during tests. We don't care what
// the parent writes — just that it gets called.
import { ConsoleLogger } from '@nestjs/common';
let superLogSpy: jest.SpyInstance;
let superErrorSpy: jest.SpyInstance;
let superWarnSpy: jest.SpyInstance;
let superDebugSpy: jest.SpyInstance;
let superVerboseSpy: jest.SpyInstance;
let superFatalSpy: jest.SpyInstance;

beforeAll(() => {
  superLogSpy = jest
    .spyOn(ConsoleLogger.prototype, 'log')
    .mockImplementation(() => {});
  superErrorSpy = jest
    .spyOn(ConsoleLogger.prototype, 'error')
    .mockImplementation(() => {});
  superWarnSpy = jest
    .spyOn(ConsoleLogger.prototype, 'warn')
    .mockImplementation(() => {});
  superDebugSpy = jest
    .spyOn(ConsoleLogger.prototype, 'debug')
    .mockImplementation(() => {});
  superVerboseSpy = jest
    .spyOn(ConsoleLogger.prototype, 'verbose')
    .mockImplementation(() => {});
  superFatalSpy = jest
    .spyOn(ConsoleLogger.prototype, 'fatal')
    .mockImplementation(() => {});
});

afterAll(() => {
  superLogSpy.mockRestore();
  superErrorSpy.mockRestore();
  superWarnSpy.mockRestore();
  superDebugSpy.mockRestore();
  superVerboseSpy.mockRestore();
  superFatalSpy.mockRestore();
});

import { OtelLogger } from './otel-logger';

beforeEach(() => {
  mockOtelEmit.mockReset();
  // The spies on ConsoleLogger.prototype persist for the suite — just clear
  // call history between tests so per-test counts stay clean.
  superLogSpy.mockClear();
  superErrorSpy.mockClear();
  superWarnSpy.mockClear();
  superDebugSpy.mockClear();
  superVerboseSpy.mockClear();
  superFatalSpy.mockClear();
});

describe('OtelLogger — severity routing', () => {
  it.each([
    ['log', 'INFO', 9, () => superLogSpy],
    ['warn', 'WARN', 13, () => superWarnSpy],
    ['debug', 'DEBUG', 5, () => superDebugSpy],
    ['verbose', 'TRACE', 1, () => superVerboseSpy],
  ] as const)(
    '%s: forwards to super and emits an OTel log at severity %s',
    (method, severityText, severityNumber, getSpy) => {
      const logger = new OtelLogger();
      (logger as unknown as Record<string, (m: string) => void>)[method](
        'hello',
      );

      expect(getSpy()).toHaveBeenCalledWith('hello');
      expect(mockOtelEmit).toHaveBeenCalledTimes(1);
      const emitArg = mockOtelEmit.mock.calls[0][0];
      expect(emitArg.severityNumber).toBe(severityNumber);
      expect(emitArg.severityText).toBe(severityText);
      expect(emitArg.body).toBe('hello');
    },
  );

  it('error: forwards to super and emits at ERROR (severityNumber=17)', () => {
    const logger = new OtelLogger();
    logger.error('boom');

    expect(superErrorSpy).toHaveBeenCalledWith('boom');
    expect(mockOtelEmit).toHaveBeenCalledTimes(1);
    expect(mockOtelEmit.mock.calls[0][0]).toMatchObject({
      severityNumber: 17,
      severityText: 'ERROR',
      body: 'boom',
    });
  });

  it('fatal: forwards to super and emits at FATAL (severityNumber=21)', () => {
    const logger = new OtelLogger();
    logger.fatal('catastrophe');

    expect(superFatalSpy).toHaveBeenCalledWith('catastrophe');
    expect(mockOtelEmit.mock.calls[0][0]).toMatchObject({
      severityNumber: 21,
      severityText: 'FATAL',
      body: 'catastrophe',
    });
  });
});

describe('OtelLogger — body serialization', () => {
  it('stringifies non-string message bodies via JSON.stringify', () => {
    const logger = new OtelLogger();
    logger.log({ event: 'shipped', count: 3 });
    expect(mockOtelEmit.mock.calls[0][0].body).toBe(
      JSON.stringify({ event: 'shipped', count: 3 }),
    );
  });

  it('passes string message bodies through verbatim', () => {
    const logger = new OtelLogger();
    logger.log('plain string');
    expect(mockOtelEmit.mock.calls[0][0].body).toBe('plain string');
  });
});

describe('OtelLogger — log.context attribute (NestJS convention)', () => {
  it('sets log.context when the trailing param is a string', () => {
    const logger = new OtelLogger();
    logger.log('app started', 'Bootstrap');
    expect(mockOtelEmit.mock.calls[0][0].attributes['log.context']).toBe(
      'Bootstrap',
    );
  });

  it('omits log.context when the trailing param is not a string', () => {
    const logger = new OtelLogger();
    logger.log('app started', { extra: 1 });
    expect(
      mockOtelEmit.mock.calls[0][0].attributes['log.context'],
    ).toBeUndefined();
  });

  it('omits log.context when there are no optional params', () => {
    const logger = new OtelLogger();
    logger.log('just a message');
    expect(
      mockOtelEmit.mock.calls[0][0].attributes['log.context'],
    ).toBeUndefined();
  });
});

describe('OtelLogger — exception.stacktrace attribute (Nest-style error call)', () => {
  it('attaches the first param as exception.stacktrace on error() with 2+ params, first a string', () => {
    const logger = new OtelLogger();
    const stack = 'Error: boom\n  at someFn (file.ts:1:1)';
    logger.error('boom message', stack, 'AppContext');

    const attrs = mockOtelEmit.mock.calls[0][0].attributes;
    expect(attrs['exception.stacktrace']).toBe(stack);
    expect(attrs['log.context']).toBe('AppContext');
  });

  it('attaches stacktrace on fatal() too (severity >= ERROR threshold)', () => {
    const logger = new OtelLogger();
    logger.fatal('msg', 'stack-string', 'ctx');
    expect(
      mockOtelEmit.mock.calls[0][0].attributes['exception.stacktrace'],
    ).toBe('stack-string');
  });

  it('does NOT attach stacktrace on warn() (below ERROR threshold)', () => {
    const logger = new OtelLogger();
    logger.warn('msg', 'looks-like-stack', 'ctx');
    expect(
      mockOtelEmit.mock.calls[0][0].attributes['exception.stacktrace'],
    ).toBeUndefined();
  });

  it('does NOT attach stacktrace on error() with only one optional param (Nest convention says 2+ for stack)', () => {
    const logger = new OtelLogger();
    logger.error('msg', 'looks-like-context-only');
    expect(
      mockOtelEmit.mock.calls[0][0].attributes['exception.stacktrace'],
    ).toBeUndefined();
  });

  it('does NOT attach stacktrace when the first optional param is not a string', () => {
    const logger = new OtelLogger();
    logger.error('msg', { not: 'a string' }, 'ctx');
    expect(
      mockOtelEmit.mock.calls[0][0].attributes['exception.stacktrace'],
    ).toBeUndefined();
  });
});
