const path = require('path');

/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  transform: {
    '^.+\\.ts$': 'ts-jest',
  },
  collectCoverageFrom: ['**/*.ts', '!**/node_modules/**', '!**/dist/**', '!**/coverage/**'],
  coverageDirectory: 'coverage',
  coverageReporters: ['text', 'lcov', 'html'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  verbose: true,
  clearMocks: true,
  testTimeout: 10000,
  moduleNameMapper: {
    '^@ainx/logger$': path.resolve(__dirname, 'packages/logger/index.ts'),
    '^@ainx/shared-utils$': path.resolve(__dirname, 'packages/shared-utils/index.ts'),
    '^@ainx/crypto-utils$': path.resolve(__dirname, 'packages/crypto-utils/src/index.ts'),
    '^@ainx/did-utils$': path.resolve(__dirname, 'packages/did-utils/src/index.ts'),
  },
};
