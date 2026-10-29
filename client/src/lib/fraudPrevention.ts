// HMRC requires fraud prevention data with every Making Tax Digital call.
// For a web app that reaches HMRC through its server (WEB_APP_VIA_SERVER),
// some of it can only come from the browser; this collects it, and the
// server adds the rest (see server/src/fraudPrevention.ts).
// https://developer.service.hmrc.gov.uk/guides/fraud-prevention/connection-method/web-app-via-server/

const DEVICE_KEY = 'crafty-device-id';

function newUuid(): string {
  // crypto.randomUUID needs HTTPS (or localhost); build a version 4 UUID by hand otherwise.
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

let sessionDeviceId: string | null = null;

/** Identifies this browser, kept for good so HMRC sees the same device each time. */
function deviceId(): string {
  try {
    const stored = localStorage.getItem(DEVICE_KEY);
    if (stored) return stored;
    const id = newUuid();
    localStorage.setItem(DEVICE_KEY, id);
    return id;
  } catch {
    // Storage blocked (a private window, say): the same id for as long as the page is open.
    sessionDeviceId ??= newUuid();
    return sessionDeviceId;
  }
}

/** The browser's UTC offset as HMRC wants it, e.g. UTC+01:00. */
function timezone(): string {
  const offset = -new Date().getTimezoneOffset();
  const abs = Math.abs(offset);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `UTC${offset < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

/** Sent to the server as the X-Fraud-Prevention header on calls that reach HMRC. */
export function fraudPreventionData(): string {
  return new URLSearchParams({
    'device-id': deviceId(),
    'user-agent': navigator.userAgent,
    screens: `width=${screen.width}&height=${screen.height}&scaling-factor=${window.devicePixelRatio}&colour-depth=${screen.colorDepth}`,
    'window-size': `width=${window.innerWidth}&height=${window.innerHeight}`,
    timezone: timezone(),
  }).toString();
}
