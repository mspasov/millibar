import { afterEach, describe, expect, test } from 'bun:test';
import { envNumber, httpBase, wsBase } from './config';

describe('httpBase / wsBase', () => {
  test('bare IPs and hostnames get a scheme prefixed', () => {
    expect(httpBase('10.0.4.20')).toBe('http://10.0.4.20');
    expect(httpBase('busy.bar')).toBe('http://busy.bar');
    expect(wsBase('10.0.4.20')).toBe('ws://10.0.4.20');
  });

  test('full URLs pass through with the trailing slash stripped', () => {
    expect(httpBase('http://busy.bar/')).toBe('http://busy.bar');
    expect(httpBase('https://busy.bar')).toBe('https://busy.bar');
  });

  test('wsBase maps http(s) to ws(s) instead of gluing schemes together', () => {
    // The regression this guards: `ws://http://…` never connects, which
    // silently cost mbar all of its button input under a full-URL addr.
    expect(wsBase('http://10.0.4.20')).toBe('ws://10.0.4.20');
    expect(wsBase('https://busy.bar/')).toBe('wss://busy.bar');
  });
});

describe('envNumber', () => {
  const NAME = 'MBAR_TEST_ENV_NUMBER';
  afterEach(() => {
    delete process.env[NAME];
  });

  test('unset or empty falls back', () => {
    expect(envNumber(NAME, 42)).toBe(42);
    process.env[NAME] = '';
    expect(envNumber(NAME, 42)).toBe(42);
  });

  test('parses a plain number', () => {
    process.env[NAME] = '60000';
    expect(envNumber(NAME, 42)).toBe(60000);
  });

  test('throws on garbage instead of yielding NaN', () => {
    // NaN would reach setTimeout, fire after ~1ms, and hot-loop the poll.
    process.env[NAME] = '5min';
    expect(() => envNumber(NAME, 42)).toThrow('MBAR_TEST_ENV_NUMBER');
  });

  test('throws below the minimum', () => {
    process.env[NAME] = '10';
    expect(() => envNumber(NAME, 42, 1000)).toThrow('>= 1000');
  });
});
