// Uses an installed Chrome/Chromium/Edge runtime to load Microsoft's
// /authorize page so its DetectBrowserCapabilities JS interstitial runs
// and we land on a real ConvergedSignIn page from which we can extract
// canary / ctx / flowToken to drive the rest of the silent-login flow over
// plain HTTP.
//
// This is the only piece of the auth flow that needs a real JS engine.
import { setTimeout as sleep } from "node:timers/promises";
import { CdpClient } from "./cdpClient.mjs";
import { startBrowserRuntime } from "./platform/browserRuntime.mjs";

/**
 * Drive a disposable headless browser through Microsoft's OAuth initiation
 * redirect to Microsoft's ConvergedSignIn page. Capturing Levnet's cookies
 * here is critical: Levnet's later ?code= callback validates server-side
 * state set during this initiation. Without it, Levnet ignores the code and
 * just re-renders its own login form.
 *
 * @param {string} startUrl A Levnet URL (e.g. https://levnet.jct.ac.il/Login/Login.aspx)
 * @returns {Promise<{ html: string, cookies: Array, finalUrl: string }>}
 */
export async function primeViaLevnetLogin(startUrl, { port = pickPort(), timeoutMs = 45000 } = {}) {
  const runtime = await startBrowserRuntime({ port });
  const client = new CdpClient({ wsUrl: runtime.meta.webSocketDebuggerUrl });
  try {
    await client.connect();
    await client.createPageTarget("about:blank");
    await client.navigate(startUrl, { timeoutMs });
    // Poll until the browser reaches a
    // tokenized Microsoft sign-in page.
    const deadline = Date.now() + timeoutMs;
    let lastInfo = null;
    while (Date.now() < deadline) {
      const info = await client.eval(`(() => ({
        pageId: document.querySelector('meta[name="PageID"]')?.getAttribute('content') || null,
        hasFormToken: !!document.querySelector('input[name="flowToken"]'),
        url: location.href,
      }))()`);
      lastInfo = info;
      if (
        info.url.includes("login.microsoftonline.com") &&
        info.hasFormToken &&
        info.pageId &&
        info.pageId !== "DetectBrowserCapabilities"
      ) break;
      await sleep(400);
    }
    if (!lastInfo?.hasFormToken) {
      throw new Error(`Browser primer did not reach a tokenized MS page (pageId=${lastInfo?.pageId}, url=${lastInfo?.url})`);
    }

    const html = await client.eval(`document.documentElement.outerHTML`);
    const finalUrl = await client.eval(`location.href`);
    const cookies = await client.getCookies([
      "https://login.microsoftonline.com/",
      "https://levnet.jct.ac.il/",
    ]);
    return { html, cookies, finalUrl };
  } finally {
    client.close();
    await runtime.cleanup();
  }
}

// Backwards-compatible name retained for any external callers.
export const primeAuthorizePage = primeViaLevnetLogin;

/**
 * Add CDP-format cookies to a CookieJar instance so subsequent jarRequest()
 * calls send them on outbound requests.
 */
export function primeCookieJar(jar, cdpCookies) {
  for (const c of cdpCookies) {
    let domain = (c.domain || "").toLowerCase();
    const hostOnly = !domain.startsWith(".");
    if (domain.startsWith(".")) domain = domain.slice(1);
    const expiresMs = c.expires && c.expires > 0 ? Math.floor(c.expires * 1000) : null;
    const key = `${domain}|${c.path || "/"}|${c.name}|${hostOnly ? "h" : "d"}`;
    jar.cookies.set(key, {
      name: c.name,
      value: c.value,
      domain,
      hostOnly,
      path: c.path || "/",
      expiresMs,
      secure: !!c.secure,
      expired: false,
    });
  }
}

let portCounter = 0;
function pickPort() {
  // Pick a high port deterministically per process to avoid clashing with
  // anything else; rotate so back-to-back calls don't reuse a bound port.
  portCounter = (portCounter + 1) % 100;
  return 9300 + portCounter;
}
