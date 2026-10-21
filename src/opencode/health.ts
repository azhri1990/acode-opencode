import {
  HEALTH_CHECK_URL,
  HEALTH_CONFIG_URL,
  HEALTH_CHECK_TIMEOUT,
  HEALTH_CRASH_CONFIRM_ATTEMPTS,
  HEALTH_CRASH_RETRY_INTERVAL,
  HEALTH_RESPONSE_TYPE,
  HEALTH_STATUS_SUCCESS_MIN,
  HEALTH_STATUS_SUCCESS_MAX,
  HEALTH_STATUS_UNAUTHORIZED,
  HEALTH_WATCHDOG_MARGIN,
  MILLISECONDS_PER_SECOND,
} from '../config/health';
import { createLogger } from '../logger';
import { buildBasicAuthHeader } from './auth';

const log = createLogger('health');

// Options for one probe run.
export interface HealthProbeOptions {
  // Password of the plugin-managed V2 server, when known. Lets the probe read
  // the API answer instead of stopping at the 401 challenge.
  password?: string | null;
}

// Minimal shape of the Cordova Advanced HTTP plugin we depend on.
interface CordovaHttpResponse {
  status?: number;
  data?: unknown;
}

interface CordovaHttpRequestOptions {
  method: string;
  timeout: number;
  responseType: string;
  headers?: Record<string, string>;
}

interface CordovaHttp {
  sendRequest: (
    url: string,
    options: CordovaHttpRequestOptions,
    success: (response?: CordovaHttpResponse) => void,
    failure: (err?: CordovaHttpResponse) => void,
  ) => void;
}

// Verdict of a single probe.
// - `up`          the answer identifies a running OpenCode server
// - `inconclusive` something answered, but not in a way that identifies OpenCode
// - `down`        nothing is listening (or the request never completed)
type ProbeVerdict = 'up' | 'inconclusive' | 'down';

// Resolve the Cordova Advanced HTTP plugin from the global window, if present.
// It runs on the native network stack, so WebView CORS does NOT apply and a
// loopback probe to 127.0.0.1:4123 actually resolves (a plain `fetch` hangs
// forever in this WebView). Returns undefined when the plugin is absent — e.g. a
// browser test environment — in which case we cannot probe at all.
function getCordovaHttp(): CordovaHttp | undefined {
  return (window as unknown as { cordova?: { plugin?: { http?: CordovaHttp } } }).cordova?.plugin
    ?.http;
}

/**
 * Returns the response body as text, or null when the native plugin did not
 * hand one over. A null body means the answer cannot be inspected, so the
 * probe falls back to trusting the status code alone.
 */
function readBody(response?: CordovaHttpResponse): string | null {
  const data = response?.data;
  if (typeof data === 'string') {
    return data;
  }
  if (data === undefined || data === null) {
    return null;
  }
  try {
    return JSON.stringify(data);
  } catch {
    return null;
  }
}

function isJsonBody(body: string): boolean {
  const trimmed = body.trim();
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

/**
 * Turns one HTTP answer into a verdict.
 *
 * OpenCode answers its API with JSON; every unknown path falls back to the
 * SPA shell (HTML). A JSON body — or the 401 challenge the auth-walled V2 API
 * answers with — therefore identifies OpenCode, while an HTML body means
 * "something else answered on this port".
 */
function classify(
  status: number | undefined,
  body: string | null,
  successCallback: boolean,
): ProbeVerdict {
  // A success callback without a status still means the server answered —
  // the native plugin only reports failures through the failure callback.
  const code =
    typeof status === 'number' ? status : successCallback ? HEALTH_STATUS_SUCCESS_MIN : 0;
  if (code <= 0) {
    // Connection refused / native transport error — nothing is listening.
    return 'down';
  }
  if (code === HEALTH_STATUS_UNAUTHORIZED) {
    // The V2 API answered and demands auth — that is an OpenCode server.
    return 'up';
  }
  if (code >= HEALTH_STATUS_SUCCESS_MIN && code <= HEALTH_STATUS_SUCCESS_MAX) {
    if (body === null) {
      // No body to inspect — trust the status code.
      return 'up';
    }
    return isJsonBody(body) ? 'up' : 'inconclusive';
  }
  return 'inconclusive';
}

/**
 * Builds the native request options for one probe. The timeout is handed to
 * the native plugin in seconds, the watchdog in ms.
 */
function buildRequestOptions(headers?: Record<string, string>): CordovaHttpRequestOptions {
  return {
    method: 'GET',
    timeout: HEALTH_CHECK_TIMEOUT / MILLISECONDS_PER_SECOND,
    responseType: HEALTH_RESPONSE_TYPE,
    headers,
  };
}

/**
 * Sends one probe and resolves its verdict. Never rejects: the request is
 * bounded by the plugin's own timeout and an independent watchdog, and a
 * synchronous throw is turned into a `down` verdict.
 */
function probeOnce(
  http: CordovaHttp,
  url: string,
  headers?: Record<string, string>,
): Promise<ProbeVerdict> {
  return new Promise<ProbeVerdict>((resolve) => {
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout> | undefined;

    function settle(verdict: ProbeVerdict): void {
      if (settled) return;
      settled = true;
      if (watchdog) clearTimeout(watchdog);
      resolve(verdict);
    }

    watchdog = setTimeout(() => {
      log.debug(`probeOnce: ${url} timed out — down`);
      settle('down');
    }, HEALTH_CHECK_TIMEOUT + HEALTH_WATCHDOG_MARGIN);

    try {
      http.sendRequest(
        url,
        buildRequestOptions(headers),
        (response) => settle(classify(response?.status, readBody(response), true)),
        (error) => settle(classify(error?.status, readBody(error), false)),
      );
    } catch {
      // A synchronous throw from sendRequest must not break the "never rejects"
      // contract — treat it as down rather than propagating an exception.
      log.debug(`probeOnce: ${url} threw — down`);
      settle('down');
    }
  });
}

/**
 * Probes the running OpenCode server and reports whether it is up.
 *
 * The server API moved between versions, so the probe walks the known API
 * surfaces in order and accepts the first answer that identifies OpenCode:
 *
 * 1. `/api/config` — the V2 API root. Answers JSON when the request carries
 *    valid basic auth (the plugin holds the password for servers it started)
 *    and `401` when it does not. V1 has no `/api/*` routes and answers this
 *    path with the SPA shell, so the probe moves on.
 * 2. `/global/health` — the V1 health route. Answers JSON
 *    (`{"healthy":true,...}`); V2 answers it with the SPA shell.
 *
 * A body that is not JSON means the answer came from the SPA fallback, so the
 * probe does not treat it as OpenCode — that is what keeps a foreign HTTP
 * server on port 4123 from being mistaken for the OpenCode server.
 *
 * The promise never rejects: a slow request is bounded by an independent
 * watchdog so a missing/failed native callback can never hang the caller.
 * Returns `false` immediately when the plugin is absent. There is no `fetch`
 * fallback: a plain `fetch` to loopback hangs in this WebView.
 */
export async function isServerUp(options: HealthProbeOptions = {}): Promise<boolean> {
  const http = getCordovaHttp();
  if (!http) {
    log.warn('isServerUp: cordova.plugin.http unavailable — cannot probe');
    return false;
  }

  const authHeaders = options.password
    ? { Authorization: buildBasicAuthHeader(options.password) }
    : undefined;

  const probes: { url: string; headers?: Record<string, string> }[] = [
    { url: HEALTH_CONFIG_URL, headers: authHeaders },
    { url: HEALTH_CHECK_URL },
  ];

  for (const probe of probes) {
    const verdict = await probeOnce(http, probe.url, probe.headers);
    log.debug(`isServerUp: ${probe.url} -> ${verdict}`);
    if (verdict === 'up') {
      return true;
    }
    if (verdict === 'down') {
      return false;
    }
  }

  log.debug('isServerUp: no probe identified an OpenCode server — down');
  return false;
}

/**
 * Confirms a Ready-state crash by probing up to
 * HEALTH_CRASH_CONFIRM_ATTEMPTS times. Returns true only when every probe
 * reports down; a single up means the earlier miss was transient.
 *
 * Never rejects (each probe is bounded by isServerUp's own watchdog).
 */
export async function isServerDownConfirmed(options: HealthProbeOptions = {}): Promise<boolean> {
  for (let attempt = 1; attempt <= HEALTH_CRASH_CONFIRM_ATTEMPTS; attempt++) {
    const up = await isServerUp(options);
    if (up) {
      log.info(`isServerDownConfirmed: up on attempt ${attempt}, not down`);
      return false;
    }
    log.info(`isServerDownConfirmed: down on attempt ${attempt}`);
    if (attempt < HEALTH_CRASH_CONFIRM_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, HEALTH_CRASH_RETRY_INTERVAL));
    }
  }
  return true;
}
