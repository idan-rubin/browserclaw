/**
 * Comprehensive browser stealth evasions.
 *
 * Injected via `addInitScript()` (runs before any page JS) and via
 * `page.evaluate()` for already-loaded pages. Each patch is wrapped
 * in try/catch so a single failure never breaks the rest.
 *
 * Covers: navigator.webdriver, plugins, languages, window.chrome,
 * Permissions API, WebGL fingerprint, Notification.permission,
 * navigator.connection, console toString, headless-mode quirks,
 * hardwareConcurrency, and deviceMemory.
 */

export const STEALTH_SCRIPT = `(function() {
  'use strict';
  function p(fn) { try { fn(); } catch(_) {} }

  // ── 1. navigator.webdriver → undefined ──
  p(function() {
    Object.defineProperty(navigator, 'webdriver', { get: function() { return undefined; }, configurable: true });
  });

  // ── 2. navigator.plugins + mimeTypes (only if empty — Chrome 92+ populates them natively) ──
  p(function() {
    if (navigator.plugins && navigator.plugins.length > 0) return;

    function FakePlugin(name, fn, desc, mimes) {
      this.name = name; this.filename = fn; this.description = desc; this.length = mimes.length;
      for (var i = 0; i < mimes.length; i++) { this[i] = mimes[i]; mimes[i].enabledPlugin = this; }
    }
    FakePlugin.prototype.item = function(i) { return this[i] || null; };
    FakePlugin.prototype.namedItem = function(n) {
      for (var i = 0; i < this.length; i++) if (this[i].type === n) return this[i];
      return null;
    };

    function M(type, suf, desc) { this.type = type; this.suffixes = suf; this.description = desc; }

    var m1 = new M('application/pdf', 'pdf', 'Portable Document Format');
    var m2 = new M('application/x-google-chrome-pdf', 'pdf', 'Portable Document Format');
    var m3 = new M('application/x-nacl', '', 'Native Client Executable');
    var m4 = new M('application/x-pnacl', '', 'Portable Native Client Executable');

    var plugins = [
      new FakePlugin('Chrome PDF Plugin', 'internal-pdf-viewer', 'Portable Document Format', [m1]),
      new FakePlugin('Chrome PDF Viewer', 'mhjfbmdgcfjbbpaeojofohoefgiehjai', '', [m2]),
      new FakePlugin('Native Client', 'internal-nacl-plugin', '', [m3, m4]),
    ];

    function makeIterable(arr, items) {
      arr.length = items.length;
      for (var i = 0; i < items.length; i++) arr[i] = items[i];
      arr[Symbol.iterator] = function() {
        var idx = 0;
        return { next: function() {
          return idx < items.length ? { value: items[idx++], done: false } : { done: true };
        }};
      };
    }

    var pa = { item: function(i) { return plugins[i] || null; },
      namedItem: function(n) { for (var i = 0; i < plugins.length; i++) if (plugins[i].name === n) return plugins[i]; return null; },
      refresh: function() {} };
    makeIterable(pa, plugins);
    Object.defineProperty(navigator, 'plugins', { get: function() { return pa; } });

    var allMimes = [m1, m2, m3, m4];
    var ma = { item: function(i) { return allMimes[i] || null; },
      namedItem: function(n) { for (var i = 0; i < allMimes.length; i++) if (allMimes[i].type === n) return allMimes[i]; return null; } };
    makeIterable(ma, allMimes);
    Object.defineProperty(navigator, 'mimeTypes', { get: function() { return ma; } });
  });

  // ── 3. navigator.languages (cached + frozen so identity check passes) ──
  p(function() {
    if (!navigator.languages || navigator.languages.length === 0) {
      var langs = Object.freeze(['en-US', 'en']);
      Object.defineProperty(navigator, 'languages', { get: function() { return langs; } });
    }
  });

  // ── 4. window.chrome ──
  p(function() {
    if (window.chrome && window.chrome.runtime && window.chrome.runtime.connect) return;

    var chrome = window.chrome || {};
    var noop = function() {};
    var evtStub = { addListener: noop, removeListener: noop, hasListeners: function() { return false; } };
    chrome.runtime = chrome.runtime || {};
    chrome.runtime.onMessage = chrome.runtime.onMessage || evtStub;
    chrome.runtime.onConnect = chrome.runtime.onConnect || evtStub;
    chrome.runtime.sendMessage = chrome.runtime.sendMessage || noop;
    chrome.runtime.connect = chrome.runtime.connect || function() {
      return { onMessage: { addListener: noop }, postMessage: noop, disconnect: noop };
    };
    if (chrome.runtime.id === undefined) chrome.runtime.id = undefined;
    if (!chrome.loadTimes) chrome.loadTimes = function() { return {}; };
    if (!chrome.csi) chrome.csi = function() { return {}; };
    if (!chrome.app) {
      chrome.app = {
        isInstalled: false,
        InstallState: { INSTALLED: 'installed', NOT_INSTALLED: 'not_installed', DISABLED: 'disabled' },
        RunningState: { CANNOT_RUN: 'cannot_run', READY_TO_RUN: 'ready_to_run', RUNNING: 'running' },
        getDetails: function() { return null; },
        getIsInstalled: function() { return false; },
        runningState: function() { return 'cannot_run'; },
      };
    }

    if (!window.chrome) {
      Object.defineProperty(window, 'chrome', { value: chrome, writable: false, enumerable: true, configurable: false });
    }
  });

  // ── 5. Permissions API consistency ──
  p(function() {
    var orig = navigator.permissions.query.bind(navigator.permissions);
    function q(params) {
      if (params.name === 'notifications') {
        return Promise.resolve({
          state: typeof Notification !== 'undefined' ? Notification.permission : 'prompt',
          name: 'notifications', onchange: null,
          addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return true; },
        });
      }
      return orig(params);
    }
    q.toString = function() { return 'function query() { [native code] }'; };
    navigator.permissions.query = q;
  });

  // ── 6. WebGL vendor / renderer ──
  p(function() {
    var h = {
      apply: function(target, self, args) {
        var param = args[0];
        if (param === 0x9245) return 'Intel Inc.';
        if (param === 0x9246) return 'Intel Iris OpenGL Engine';
        return Reflect.apply(target, self, args);
      }
    };
    if (typeof WebGLRenderingContext !== 'undefined')
      WebGLRenderingContext.prototype.getParameter = new Proxy(WebGLRenderingContext.prototype.getParameter, h);
    if (typeof WebGL2RenderingContext !== 'undefined')
      WebGL2RenderingContext.prototype.getParameter = new Proxy(WebGL2RenderingContext.prototype.getParameter, h);
  });

  // ── 7. Notification.permission ──
  p(function() {
    if (typeof Notification !== 'undefined' && Notification.permission === 'denied') {
      Object.defineProperty(Notification, 'permission', { get: function() { return 'default'; }, configurable: true });
    }
  });

  // ── 8. navigator.connection (cached so identity check passes) ──
  p(function() {
    if (navigator.connection) return;
    var conn = {
      effectiveType: '4g', rtt: 50, downlink: 10, saveData: false, onchange: null,
      addEventListener: function(){}, removeEventListener: function(){}, dispatchEvent: function(){ return true; },
    };
    Object.defineProperty(navigator, 'connection', { get: function() { return conn; } });
  });

  // ── 9. Iframe contentWindow.chrome ──
  // Handled by patch 4 — chrome object is now on window, propagates to iframes on same origin.

  // ── 10. console method toString ──
  p(function() {
    ['log','info','warn','error','debug','table','trace'].forEach(function(n) {
      if (console[n]) {
        console[n].toString = function() { return 'function ' + n + '() { [native code] }'; };
      }
    });
  });

  // ── 11. Headless-mode window / screen fixes ──
  p(function() {
    if (window.outerWidth === 0)
      Object.defineProperty(window, 'outerWidth', { get: function() { return window.innerWidth || 1920; } });
    if (window.outerHeight === 0)
      Object.defineProperty(window, 'outerHeight', { get: function() { return (window.innerHeight || 1080) + 85; } });
  });

  p(function() {
    if (screen.colorDepth === 0) {
      Object.defineProperty(screen, 'colorDepth', { get: function() { return 24; } });
      Object.defineProperty(screen, 'pixelDepth', { get: function() { return 24; } });
    }
  });

  // ── 12. navigator.hardwareConcurrency ──
  p(function() {
    if (!navigator.hardwareConcurrency)
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: function() { return 4; } });
  });

  // ── 13. navigator.deviceMemory ──
  p(function() {
    if (!navigator.deviceMemory)
      Object.defineProperty(navigator, 'deviceMemory', { get: function() { return 8; } });
  });
})()`;
