import { afterEach, describe, expect, test } from 'bun:test';
import { apiPath, envFlag, envNumber, httpBase, isProxyAddr, wsBase } from './config';

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

describe('cloud proxy addressing', () => {
  test('recognises the proxy hosts, with or without a scheme', () => {
    expect(isProxyAddr('api.busy.app')).toBe(true);
    expect(isProxyAddr('https://api.busy.app')).toBe(true);
    expect(isProxyAddr('https://api.busy.app/')).toBe(true);
    expect(isProxyAddr('api.dev.busy.app')).toBe(true);
    expect(isProxyAddr('10.0.4.20')).toBe(false);
    expect(isProxyAddr('busy.bar')).toBe(false);
    // Lookalikes must not match — 'napi.busy.app' is somebody else's host.
    expect(isProxyAddr('napi.busy.app')).toBe(false);
  });

  test('the proxy defaults to https; a 301 would drop POST bodies', () => {
    expect(httpBase('api.busy.app')).toBe('https://api.busy.app');
    expect(wsBase('api.busy.app')).toBe('wss://api.busy.app');
    // An explicit scheme is still respected.
    expect(httpBase('http://api.busy.app')).toBe('http://api.busy.app');
  });

  test('apiPath rewrites /api/… to /busybar/… only for proxy routes', () => {
    expect(apiPath('api.busy.app', '/api/version')).toBe('/busybar/version');
    expect(apiPath('api.busy.app', '/api/display/draw?application_name=x')).toBe(
      '/busybar/display/draw?application_name=x'
    );
    expect(apiPath('10.0.4.20', '/api/version')).toBe('/api/version');
    // Only a leading /api segment is a device-API path.
    expect(apiPath('api.busy.app', '/apiary')).toBe('/apiary');
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

describe('envFlag', () => {
  const NAME = 'MBAR_TEST_ENV_FLAG';
  afterEach(() => {
    delete process.env[NAME];
  });

  test('unset or empty falls back', () => {
    expect(envFlag(NAME, true)).toBe(true);
    expect(envFlag(NAME, false)).toBe(false);
    process.env[NAME] = '';
    expect(envFlag(NAME, true)).toBe(true);
  });

  test('accepts 1/0, true/false, on/off, any case', () => {
    for (const value of ['1', 'true', 'on', 'TRUE', 'On']) {
      process.env[NAME] = value;
      expect(envFlag(NAME, false)).toBe(true);
    }
    for (const value of ['0', 'false', 'off', 'FALSE', 'Off']) {
      process.env[NAME] = value;
      expect(envFlag(NAME, true)).toBe(false);
    }
  });

  test('throws on garbage instead of silently falling back', () => {
    // A typo'd 'flase' quietly meaning "on" would look applied and not be.
    process.env[NAME] = 'flase';
    expect(() => envFlag(NAME, true)).toThrow('MBAR_TEST_ENV_FLAG');
  });
});
