import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";


/**
 * Minimal CDP client that talks JSON over a WebSocket to a CDP-compatible
 * Chromium-compatible browser. One client connection, one target,
 * one session. Good enough for scripted form-driving.
 */
export class CdpClient {
  constructor({ wsUrl }) {
    this.wsUrl = wsUrl;
    this.ws = null;
    this.id = 0;
    this.pending = new Map();
    this.events = [];
    this.eventListeners = [];
    this.sessionId = null;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl, { perMessageDeflate: false });
      this.ws.once("open", resolve);
      this.ws.once("error", reject);
    });
    this.ws.on("message", (data) => this._onMessage(data));
    this.ws.on("close", () => {
      for (const { reject } of this.pending.values()) {
        reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
    });
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.id != null && this.pending.has(msg.id)) {
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(`CDP error ${msg.error.code}: ${msg.error.message}`));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      this.events.push(msg);
      for (const cb of this.eventListeners) cb(msg);
    }
  }

  send(method, params = {}, { sessionId = this.sessionId } = {}) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
    });
  }

  onEvent(cb) {
    this.eventListeners.push(cb);
    return () => {
      const i = this.eventListeners.indexOf(cb);
      if (i >= 0) this.eventListeners.splice(i, 1);
    };
  }

  async waitForEvent(method, { predicate = () => true, timeoutMs = 15000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    // Drain past events first.
    for (const ev of this.events) {
      if (ev.method === method && predicate(ev.params)) return ev.params;
    }
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Timed out waiting for ${method}`));
      }, Math.max(50, deadline - Date.now()));
      const cleanup = this.onEvent((ev) => {
        if (ev.method === method && predicate(ev.params)) {
          clearTimeout(timer);
          cleanup();
          resolve(ev.params);
        }
      });
    });
  }

  async createPageTarget(url = "about:blank") {
    const { targetId } = await this.send("Target.createTarget", { url });
    const { sessionId } = await this.send("Target.attachToTarget", { targetId, flatten: true });
    this.sessionId = sessionId;
    await this.send("Page.enable");
    await this.send("Runtime.enable");
    await this.send("Network.enable");
    return { targetId, sessionId };
  }

  async navigate(url, { timeoutMs = 25000 } = {}) {
    await this.send("Page.navigate", { url });
    try {
      await this.waitForEvent("Page.loadEventFired", { timeoutMs });
    } catch {
      // Some CDP runtimes do not fire loadEventFired reliably; fall back to a delay.
      await sleep(2000);
    }
    await sleep(500);
  }

  async eval(expression, { awaitPromise = false, returnByValue = true } = {}) {
    const r = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise,
      returnByValue,
      includeCommandLineAPI: false,
    });
    if (r.exceptionDetails) {
      throw new Error(`Runtime exception: ${r.exceptionDetails.text || JSON.stringify(r.exceptionDetails)}`);
    }
    return r.result?.value;
  }

  async waitForSelector(selector, { timeoutMs = 15000, intervalMs = 200 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = await this.eval(`!!document.querySelector(${JSON.stringify(selector)})`);
      if (found) return true;
      await sleep(intervalMs);
    }
    throw new Error(`Selector not found within ${timeoutMs}ms: ${selector}`);
  }

  async typeInto(selector, value) {
    const ok = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, ${JSON.stringify(value)});
      // Fire the full event sequence Knockout's textInput binding needs.
      ['input', 'change', 'keyup', 'blur'].forEach((type) => {
        el.dispatchEvent(new Event(type, { bubbles: true }));
      });
      return true;
    })()`);
    if (!ok) throw new Error(`Could not type into ${selector}`);
  }

  async typeRealKeystrokes(selector, value) {
    // Focus the element first.
    const focused = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.focus();
      return true;
    })()`);
    if (!focused) throw new Error(`Could not focus ${selector}`);
    for (const ch of value) {
      try {
        await this.send("Input.dispatchKeyEvent", {
          type: "keyDown",
          text: ch,
          unmodifiedText: ch,
          key: ch,
        });
        await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
      } catch (e) {
        // Some CDP runtimes may not implement Input.dispatchKeyEvent; fall back to
        // setting the value programmatically.
        return false;
      }
    }
    return true;
  }

  async click(selector) {
    const ok = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.click();
      return true;
    })()`);
    if (!ok) throw new Error(`Could not click ${selector}`);
  }

  async getCookies(urls = []) {
    const r = await this.send("Network.getCookies", urls.length ? { urls } : {});
    return r.cookies || [];
  }

  async pageInfo() {
    return await this.eval(`(() => {
      // Use aria-hidden plus parent traversal because layout-based visibility
      // checks can be unreliable in headless runtimes.
      const isActive = (el) => {
        if (!el) return false;
        let cur = el;
        while (cur && cur !== document.body) {
          if (cur.getAttribute && cur.getAttribute('aria-hidden') === 'true') return false;
          const cs = el.ownerDocument.defaultView.getComputedStyle(cur);
          if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return false;
          cur = cur.parentElement;
        }
        return true;
      };
      const liveError = [...document.querySelectorAll('#usernameError, #passwordError, [role="alert"]')]
        .map((el) => ({ el, text: (el.textContent || '').trim() }))
        .find((x) => x.text && isActive(x.el));
      const submitBtn = document.getElementById('idSIButton9');
      return {
        url: location.href,
        title: document.title,
        pageId: document.querySelector('meta[name="PageID"]')?.getAttribute('content') || null,
        submitText: submitBtn?.value || submitBtn?.textContent || null,
        emailActive: isActive(document.getElementById('i0116')),
        passwordActive: isActive(document.getElementById('i0118')),
        otpActive: isActive(document.getElementById('idTxtBx_SAOTCC_OTC')),
        kmsiActive: isActive(document.getElementById('KmsiCheckboxField')) || isActive(document.querySelector('input[name="DontShowAgain"]')),
        hasError: !!liveError,
        errorText: liveError?.text || '',
      };
    })()`);
  }

  close() {
    try { this.ws?.close(); } catch {}
  }
}
