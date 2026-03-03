/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/__tests__/**/*.test.ts'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx', 'json', 'node'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts'
  ],
  coverageDirectory: 'coverage',
  coverageThreshold: {
    global: {
      statements: 45,
      branches: 38,
      functions: 45,
      lines: 45,
    },
  },
  moduleNameMapper: {
    '^hydrooj$': '<rootDir>/src/__tests__/__mocks__/hydrooj.ts'
  }
};
