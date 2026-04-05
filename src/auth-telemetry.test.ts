import { describe, it, expect } from 'vitest';

import type { AuthCheckRule, AuthCheckResult, RunTelemetry } from './types.js';

// ── Auth Health Types ──

describe('AuthCheckRule', () => {
  it('should accept a url rule', () => {
    const rule: AuthCheckRule = { url: '/dashboard' };
    expect(rule.url).toBe('/dashboard');
  });

  it('should accept a cookie rule', () => {
    const rule: AuthCheckRule = { cookie: 'session_id' };
    expect(rule.cookie).toBe('session_id');
  });

  it('should accept a selector rule', () => {
    const rule: AuthCheckRule = { selector: '[data-user-id]' };
    expect(rule.selector).toBe('[data-user-id]');
  });

  it('should accept a text rule', () => {
    const rule: AuthCheckRule = { text: 'Welcome back' };
    expect(rule.text).toBe('Welcome back');
  });

  it('should accept a textGone rule', () => {
    const rule: AuthCheckRule = { textGone: 'Sign in' };
    expect(rule.textGone).toBe('Sign in');
  });

  it('should accept a fn rule', () => {
    const rule: AuthCheckRule = { fn: '() => !!document.cookie' };
    expect(rule.fn).toBe('() => !!document.cookie');
  });

  it('should accept multiple rules combined', () => {
    const rule: AuthCheckRule = {
      url: '/dashboard',
      cookie: 'session_id',
      textGone: 'Sign in',
    };
    expect(rule.url).toBe('/dashboard');
    expect(rule.cookie).toBe('session_id');
    expect(rule.textGone).toBe('Sign in');
  });
});

describe('AuthCheckResult', () => {
  it('should represent a fully authenticated result', () => {
    const result: AuthCheckResult = {
      authenticated: true,
      checks: [
        { rule: 'url', passed: true, detail: 'https://app.example.com/dashboard' },
        { rule: 'cookie', passed: true, detail: 'cookie "session_id" present' },
      ],
    };
    expect(result.authenticated).toBe(true);
    expect(result.checks).toHaveLength(2);
    expect(result.checks.every((c) => c.passed)).toBe(true);
  });

  it('should represent a failed auth result', () => {
    const result: AuthCheckResult = {
      authenticated: false,
      checks: [
        { rule: 'url', passed: true, detail: 'https://app.example.com/login' },
        { rule: 'textGone', passed: false, detail: '"Sign in" still present' },
      ],
    };
    expect(result.authenticated).toBe(false);
    expect(result.checks.some((c) => !c.passed)).toBe(true);
  });

  it('should represent an empty rules result as authenticated', () => {
    const result: AuthCheckResult = {
      authenticated: true,
      checks: [],
    };
    expect(result.authenticated).toBe(true);
    expect(result.checks).toHaveLength(0);
  });
});

// ── Run Telemetry Types ──

describe('RunTelemetry', () => {
  it('should represent a launch telemetry envelope', () => {
    const telemetry: RunTelemetry = {
      launchMs: 1823,
      connectMs: 45,
      navMs: 620,
      authOk: true,
      exitReason: 'success',
      cleanupOk: true,
      timestamps: {
        startedAt: '2026-04-05T10:00:00.000Z',
        launchedAt: '2026-04-05T10:00:01.823Z',
        connectedAt: '2026-04-05T10:00:01.868Z',
        navigatedAt: '2026-04-05T10:00:02.488Z',
        stoppedAt: '2026-04-05T10:00:05.000Z',
      },
    };
    expect(telemetry.launchMs).toBe(1823);
    expect(telemetry.connectMs).toBe(45);
    expect(telemetry.navMs).toBe(620);
    expect(telemetry.authOk).toBe(true);
    expect(telemetry.exitReason).toBe('success');
    expect(telemetry.cleanupOk).toBe(true);
    expect(telemetry.timestamps.startedAt).toBeTruthy();
    expect(telemetry.timestamps.launchedAt).toBeTruthy();
    expect(telemetry.timestamps.connectedAt).toBeTruthy();
    expect(telemetry.timestamps.navigatedAt).toBeTruthy();
    expect(telemetry.timestamps.stoppedAt).toBeTruthy();
  });

  it('should represent a connect-only telemetry envelope (no launch)', () => {
    const telemetry: RunTelemetry = {
      connectMs: 120,
      timestamps: {
        startedAt: '2026-04-05T10:00:00.000Z',
        connectedAt: '2026-04-05T10:00:00.120Z',
      },
    };
    expect(telemetry.launchMs).toBeUndefined();
    expect(telemetry.connectMs).toBe(120);
    expect(telemetry.navMs).toBeUndefined();
    expect(telemetry.timestamps.launchedAt).toBeUndefined();
  });

  it('should represent a failed session telemetry', () => {
    const telemetry: RunTelemetry = {
      launchMs: 15000,
      authOk: false,
      exitReason: 'auth_failed',
      cleanupOk: true,
      timestamps: {
        startedAt: '2026-04-05T10:00:00.000Z',
        launchedAt: '2026-04-05T10:00:15.000Z',
        stoppedAt: '2026-04-05T10:00:16.000Z',
      },
    };
    expect(telemetry.authOk).toBe(false);
    expect(telemetry.exitReason).toBe('auth_failed');
    expect(telemetry.cleanupOk).toBe(true);
  });

  it('should represent a cleanup failure', () => {
    const telemetry: RunTelemetry = {
      launchMs: 2000,
      exitReason: 'timeout',
      cleanupOk: false,
      timestamps: {
        startedAt: '2026-04-05T10:00:00.000Z',
        launchedAt: '2026-04-05T10:00:02.000Z',
        stoppedAt: '2026-04-05T10:00:30.000Z',
      },
    };
    expect(telemetry.cleanupOk).toBe(false);
    expect(telemetry.exitReason).toBe('timeout');
  });
});
