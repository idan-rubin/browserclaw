export { BrowserClaw, CrawlPage } from './browser.js';
export {
  isChromeCdpReady,
  isChromeReachable,
  getChromeWebSocketUrl,
  normalizeCdpHttpBaseForJsonEndpoints,
} from './chrome-launcher.js';
export {
  InvalidBrowserNavigationUrlError,
  withBrowserNavigationPolicy,
  assertBrowserNavigationAllowed,
  assertBrowserNavigationResultAllowed,
  assertBrowserNavigationRedirectChainAllowed,
  requiresInspectableBrowserNavigationRedirects,
  sanitizeUntrustedFileName,
  createPinnedLookup,
  resolvePinnedHostnameWithPolicy,
  writeViaSiblingTempPath,
  assertSafeUploadPaths,
  resolveStrictExistingUploadPaths,
} from './security.js';
export type { BrowserNavigationPolicyOptions, BrowserNavigationRequestLike, LookupFn } from './security.js';
export {
  ensureContextState,
  forceDisconnectPlaywrightConnection,
  // eslint-disable-next-line @typescript-eslint/no-deprecated
  forceDisconnectPlaywrightForTarget,
  withPlaywrightPageCdpSession,
  withPageScopedCdpClient,
  resolvePageByTargetIdOrThrow,
  requireRef,
  requireRefOrSelector,
  resolveInteractionTimeoutMs,
  resolveBoundedDelayMs,
  getRestoredPageForTarget,
  setDialogHandler,
  parseRoleRef,
  BrowserTabNotFoundError,
} from './connection.js';
export { pressAndHoldViaCdp } from './actions/interaction.js';
export type { FrameEvalResult } from './actions/evaluate.js';
export { batchViaPlaywright, executeSingleAction } from './actions/batch.js';
export type { BatchAction, BatchActionResult } from './actions/batch.js';
export { STEALTH_SCRIPT } from './stealth.js';
export { detectChallengeViaPlaywright, waitForChallengeViaPlaywright } from './anti-bot.js';
export type {
  SsrfPolicy,
  LaunchOptions,
  ConnectOptions,
  SnapshotResult,
  SnapshotOptions,
  SnapshotStats,
  UntrustedContentMeta,
  AriaSnapshotResult,
  AriaNode,
  RoleRefInfo,
  RoleRefs,
  BrowserTab,
  FormField,
  ClickOptions,
  TypeOptions,
  WaitOptions,
  ScreenshotOptions,
  ConsoleMessage,
  PageError,
  NetworkRequest,
  CookieData,
  StorageKind,
  ChromeKind,
  ChromeExecutable,
  DownloadResult,
  DialogOptions,
  DialogEvent,
  DialogHandler,
  RequestResult,
  ResponseBodyResult,
  TraceStartOptions,
  ColorScheme,
  GeolocationOptions,
  HttpCredentials,
  ContextState,
  PinnedHostname,
  ChallengeKind,
  ChallengeInfo,
  ChallengeWaitResult,
} from './types.js';
