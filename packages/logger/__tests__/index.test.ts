import { Logger } from '../index';

// Mock console.log to capture log output
const mockConsoleLog = jest.spyOn(console, 'log').mockImplementation();

describe('Logger', () => {
  let logger: Logger;

  beforeEach(() => {
    logger = new Logger('test-service');
    mockConsoleLog.mockClear();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('debug', () => {
    it('should log debug message with correct level', () => {
      logger.debug('Debug message');

      expect(mockConsoleLog).toHaveBeenCalledTimes(1);
      const logEntry = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(logEntry.level).toBe('DEBUG');
      expect(logEntry.message).toBe('Debug message');
      expect(logEntry.service).toBe('test-service');
    });

    it('should include context in debug log', () => {
      const context = { userId: '123', action: 'test' };
      logger.debug('Debug message', context);

      const logEntry = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(logEntry.context).toEqual(context);
    });
  });

  describe('info', () => {
    it('should log info message with correct level', () => {
      logger.info('Info message');

      const logEntry = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(logEntry.level).toBe('INFO');
      expect(logEntry.message).toBe('Info message');
    });

    it('should include timestamp', () => {
      const before = new Date().toISOString();
      logger.info('Info message');
      const after = new Date().toISOString();

      const logEntry = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(logEntry.timestamp).toBeGreaterThanOrEqual(before);
      expect(logEntry.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('warn', () => {
    it('should log warn message with correct level', () => {
      logger.warn('Warning message');

      const logEntry = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(logEntry.level).toBe('WARN');
      expect(logEntry.message).toBe('Warning message');
    });
  });

  describe('error', () => {
    it('should log error message with correct level', () => {
      logger.error('Error message');

      const logEntry = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(logEntry.level).toBe('ERROR');
      expect(logEntry.message).toBe('Error message');
    });

    it('should include error context', () => {
      const error = new Error('Test error');
      logger.error('Error occurred', { error: error.message });

      const logEntry = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(logEntry.context.error).toBe('Test error');
    });
  });

  describe('log entry structure', () => {
    it('should have all required fields', () => {
      logger.info('Test message');

      const logEntry = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(logEntry).toHaveProperty('timestamp');
      expect(logEntry).toHaveProperty('level');
      expect(logEntry).toHaveProperty('service');
      expect(logEntry).toHaveProperty('message');
    });

    it('should have correct service name', () => {
      const customLogger = new Logger('custom-service');
      customLogger.info('Test message');

      const logEntry = JSON.parse(mockConsoleLog.mock.calls[0][0]);
      expect(logEntry.service).toBe('custom-service');
    });
  });
});
