// ==UserScript==
// @name         Citi Merchant Offer Clicker
// @namespace    https://online.citi.com/
// @version      0.1.0
// @description  Adds Citi Merchant Offers for the currently selected card by clicking native one-click enroll controls slowly.
// @match        https://online.citi.com/US/nga/products-offers/merchantoffers*
// @updateURL    https://raw.githubusercontent.com/wtxcn/private/main/CitiOfferClicker.user.js
// @downloadURL  https://raw.githubusercontent.com/wtxcn/private/main/CitiOfferClicker.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "0.1.0";
  const STORE_KEY = "citiOfferClickerState.v1";
  const LOG_KEY = "citiOfferClickerLogs.v1";
  const KEEP_ALIVE_KEY = "citiOfferClickerKeepAlive.v1";

  let panel;
  let abortRequested = false;
  let renderQueued = false;
  let processInFlight = false;
  let keepAliveTimer = null;
  let lastKeepAliveAt = 0;

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function loadJson(key, fallback) {
    try {
      return JSON.parse(localStorage.getItem(key) || "") || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function saveJson(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  function getState() {
    return loadJson(STORE_KEY, { active: false, phase: "idle" });
  }

  function setState(next) {
    saveJson(STORE_KEY, next);
    scheduleRender();
  }

  function getLogs() {
    return loadJson(LOG_KEY, []);
  }

  function pushLog(message) {
    const stamp = new Date().toLocaleTimeString();
    const logs = getLogs();
    logs.push(`[${stamp}] ${message}`);
    saveJson(LOG_KEY, logs.slice(-250));
    scheduleRender();
  }

  function clearLogs(event) {
    event?.preventDefault();
    event?.stopPropagation();
    saveJson(LOG_KEY, []);
    panel?.querySelector("[data-logs]")?.replaceChildren();
    scheduleRender(true);
  }

  function getKeepAliveConfig() {
    return loadJson(KEEP_ALIVE_KEY, { enabled: true, intervalMs: 240000 });
  }

  function setKeepAliveConfig(next) {
    saveJson(KEEP_ALIVE_KEY, next);
    scheduleKeepAlive();
    scheduleRender(true);
  }

  function textOf(node) {
    return (node?.innerText || node?.textContent || "").trim().replace(/\s+/g, " ");
  }

  function getLabel(node) {
    return [
      textOf(node),
      node.getAttribute("aria-label") || "",
      node.getAttribute("title") || "",
      node.getAttribute("id") || "",
      node.value || ""
    ].join(" ").replace(/\s+/g, " ").trim();
  }

  function isVisible(node) {
    if (!node?.getBoundingClientRect) return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function isEnabled(node) {
    return !node.disabled && node.getAttribute("aria-disabled") !== "true";
  }

  function isOwnPanel(node) {
    return Boolean(node?.closest?.("#citi-offer-clicker"));
  }

  function getSearchRoots() {
    const roots = [document];
    const seen = new Set(roots);

    Array.from(document.querySelectorAll("*")).forEach((node) => {
      if (node.shadowRoot && !seen.has(node.shadowRoot)) {
        seen.add(node.shadowRoot);
        roots.push(node.shadowRoot);
      }
    });

    Array.from(document.querySelectorAll("iframe")).forEach((frame) => {
      try {
        const doc = frame.contentDocument;
        if (doc && !seen.has(doc)) {
          seen.add(doc);
          roots.push(doc);
        }
      } catch (_) {
        // Cross-origin frames cannot be inspected by this userscript.
      }
    });

    return roots;
  }

  function allCandidates(selector) {
    return getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll(selector)));
  }

  function pageLabel() {
    const title = document.title || "";
    const h1 = textOf(document.querySelector("h1"));
    const h2 = textOf(document.querySelector("h2"));
    return [h1, h2, title].filter(Boolean).join(" | ").slice(0, 180);
  }

  function selectedCardLabel() {
    const selector = document.querySelector("#card-selector-cds-dropdown, [role='combobox']");
    return textOf(selector).slice(0, 140) || "selected card";
  }

  function isLoggedOutOrTimedOut() {
    const body = textOf(document.body).slice(0, 2500);
    return /sign on|sign in|session (has )?timed out|for your security|log in|login/i.test(body)
      && /citi|citibank/i.test(`${body} ${location.hostname}`);
  }

  function offerKey(button) {
    const id = button.id || "";
    const idMatch = id.match(/^(.+?)-(?:Featured|Shopping|Dining|LifeStyleOffers|Health[^-]*|Travel|Entertainment|Other)-oneclick$/i)
      || id.match(/^(.+?)-oneclick$/i);
    if (idMatch) return idMatch[1];

    return getOfferName(button).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  }

  function getOfferName(button) {
    const directLabel = [
      button.getAttribute("aria-label") || "",
      button.getAttribute("title") || ""
    ].find((item) => /Enroll in Offer for/i.test(item)) || getLabel(button);
    const match = directLabel.match(/Enroll in Offer for\s+(.+)$/i);
    if (match) return match[1].trim().slice(0, 140);

    const tile = button.closest?.("cds-tile, .mo-offer-tile-container, .cds-tile, .tile-content, .mo-tile-content, .lifestyle-tile-content");
    return textOf(tile).replace(/\s+/g, " ").trim().slice(0, 140) || "offer";
  }

  function isEnrollButton(node) {
    if (!node || isOwnPanel(node) || !isVisible(node) || !isEnabled(node)) return false;
    const label = getLabel(node);
    const id = node.id || "";
    if (/(enrolled|activated|added|remove|removed|details|learn|filter|more filters)/i.test(label)) return false;
    return /-oneclick$/i.test(id) || /Enroll in Offer for/i.test(label);
  }

  function getSkippedKeys() {
    const state = getState();
    return new Set(Array.isArray(state.skippedKeys) ? state.skippedKeys : []);
  }

  function saveSkippedKeys(keys) {
    setState({ ...getState(), skippedKeys: Array.from(keys).slice(-1000) });
  }

  function getEnrollButtons() {
    const skipped = getSkippedKeys();
    const seen = new Set();
    return allCandidates("button, [role='button'], input[type='button'], input[type='submit']")
      .filter(isEnrollButton)
      .filter((button) => {
        const key = offerKey(button);
        if (!key || skipped.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  function humanClick(node) {
    if (!node) return false;
    node.scrollIntoView({ block: "center", inline: "center" });
    node.focus?.({ preventScroll: true });

    const rect = node.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    const base = {
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y
    };

    ["pointerover", "mouseover", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
      const EventClass = type.startsWith("pointer") && typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent;
      node.dispatchEvent(new EventClass(type, { ...base, button: 0, buttons: type.endsWith("down") ? 1 : 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    });
    node.click?.();
    return true;
  }

  async function waitForOffers(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (getEnrollButtons().length > 0 || /merchant offers/i.test(pageLabel())) return true;
      await sleep(500);
    }
    return false;
  }

  function findSessionButton() {
    return Array.from(document.querySelectorAll("button, a, [role='button']")).find((node) => {
      const label = getLabel(node);
      return /stay signed in|continue session|keep me signed in|yes, continue|i'?m still here/i.test(label);
    });
  }

  function dispatchKeepAliveEvents() {
    const x = Math.max(10, Math.floor(window.innerWidth * 0.6));
    const y = Math.max(10, Math.floor(window.innerHeight * 0.25));
    document.dispatchEvent(new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }));
    document.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Shift" }));
    document.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: "Shift" }));
  }

  function keepAliveTick() {
    const config = getKeepAliveConfig();
    if (!config.enabled) return;

    const sessionButton = findSessionButton();
    if (sessionButton) {
      humanClick(sessionButton);
      pushLog("Clicked session keep-alive prompt.");
    } else {
      dispatchKeepAliveEvents();
      pushLog("Sent keep-alive activity.");
    }
    lastKeepAliveAt = Date.now();
    scheduleRender(true);
  }

  function scheduleKeepAlive() {
    if (keepAliveTimer) {
      clearInterval(keepAliveTimer);
      keepAliveTimer = null;
    }

    const config = getKeepAliveConfig();
    if (!config.enabled) return;

    const intervalMs = Math.max(60000, Number(config.intervalMs || 240000));
    keepAliveTimer = setInterval(keepAliveTick, intervalMs);
  }

  async function clickOneOffer(delayMs) {
    const button = getEnrollButtons()[0];
    if (!button) return false;

    const name = getOfferName(button);
    const key = offerKey(button);
    const skipped = getSkippedKeys();
    skipped.add(key);
    saveSkippedKeys(skipped);

    const clicked = humanClick(button);
    if (!clicked) return false;

    pushLog(`Clicked: ${name}`);
    await sleep(delayMs);
    return true;
  }

  async function scrollForMore() {
    const beforeY = window.scrollY;
    const beforeHeight = document.body.scrollHeight;
    window.scrollBy({ top: Math.floor(window.innerHeight * 0.85), behavior: "smooth" });
    await sleep(1500);
    return window.scrollY !== beforeY || document.body.scrollHeight !== beforeHeight;
  }

  async function processOffers() {
    if (processInFlight) return;
    processInFlight = true;

    try {
      const state = getState();
      if (!state.active) return;

      await waitForOffers();

      if (isLoggedOutOrTimedOut()) {
        pushLog("Citi session is logged out or timed out. Sign in, open Merchant Offers, then run again.");
        setState({ ...state, active: false, phase: "timed-out" });
        return;
      }

      const delayMs = Number(state.delayMs || 5000);
      const maxClicks = Number(state.maxClicks || 300);
      let clicked = Number(state.clicked || 0);
      let noMoreRounds = 0;

      pushLog(`Start pass: ${selectedCardLabel()} | addable=${getEnrollButtons().length}`);

      while (!abortRequested && clicked < maxClicks && noMoreRounds < 3) {
        const before = getEnrollButtons().length;
        let roundClicked = 0;

        while (!abortRequested && clicked < maxClicks && getEnrollButtons().length > 0) {
          const ok = await clickOneOffer(delayMs);
          if (!ok) break;
          clicked += 1;
          roundClicked += 1;
          setState({ ...getState(), clicked, phase: "running" });
        }

        const moved = await scrollForMore();
        const after = getEnrollButtons().length;
        pushLog(`Pass progress: clicked=${clicked}, addable=${after}`);

        if (roundClicked === 0 && after === 0 && (!moved || before === 0)) noMoreRounds += 1;
        else noMoreRounds = 0;
      }

      if (abortRequested) {
        pushLog("Stopped by user.");
        setState({ ...getState(), active: false, phase: "stopped" });
        return;
      }

      pushLog(`Done. Clicked ${clicked} offer(s) for ${selectedCardLabel()}.`);
      setState({ ...getState(), active: false, phase: "done", clicked });
    } catch (error) {
      pushLog(`Error: ${error.message}`);
      setState({ ...getState(), active: false, phase: "error" });
    } finally {
      processInFlight = false;
    }
  }

  function startRun() {
    abortRequested = false;
    setState({
      active: true,
      phase: "starting",
      delayMs: Number(panel.querySelector("[data-delay]").value || 5000),
      maxClicks: Number(panel.querySelector("[data-max]").value || 300),
      clicked: 0,
      skippedKeys: [],
      startedAt: Date.now()
    });
    pushLog(`Starting Citi Merchant Offers run v${VERSION}.`);
    processOffers();
  }

  function stopRun() {
    abortRequested = true;
    setState({ ...getState(), active: false, phase: "stopped" });
    pushLog("Stop requested.");
  }

  function debugScan() {
    const buttons = getEnrollButtons();
    pushLog(`Debug scan: addable=${buttons.length}, page="${pageLabel()}", card="${selectedCardLabel()}", timedOut=${isLoggedOutOrTimedOut()}`);
    buttons.slice(0, 20).forEach((button, index) => {
      pushLog(`#${index + 1}: ${getOfferName(button)} | key=${offerKey(button)}`);
    });
    if (buttons.length > 20) pushLog(`...and ${buttons.length - 20} more.`);
  }

  function scheduleRender(force = false) {
    if (!panel) return;
    if (force) {
      render(true);
      return;
    }
    if (renderQueued) return;
    renderQueued = true;
    window.setTimeout(() => {
      renderQueued = false;
      render(false);
    }, 250);
  }

  function makePanel() {
    const el = document.createElement("div");
    el.id = "citi-offer-clicker";
    el.innerHTML = `
      <style>
        #citi-offer-clicker {
          position: fixed;
          z-index: 2147483647;
          right: 18px;
          top: 92px;
          width: 370px;
          color: #111827;
          background: #fff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          box-shadow: 0 12px 30px rgba(15, 23, 42, 0.22);
          font-family: Arial, sans-serif;
          font-size: 13px;
        }
        #citi-offer-clicker header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 12px;
          border-bottom: 1px solid #e5e7eb;
          font-weight: 700;
        }
        #citi-offer-clicker main { padding: 10px 12px; }
        #citi-offer-clicker button {
          margin: 4px 4px 4px 0;
          padding: 7px 10px;
          border: 1px solid #0b5cab;
          border-radius: 6px;
          background: #0b5cab;
          color: white;
          cursor: pointer;
          font-size: 12px;
        }
        #citi-offer-clicker button.secondary {
          background: #fff;
          color: #0b5cab;
        }
        #citi-offer-clicker button.danger {
          border-color: #b91c1c;
          background: #b91c1c;
        }
        #citi-offer-clicker label {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          margin-right: 8px;
        }
        #citi-offer-clicker input {
          width: 72px;
          padding: 5px;
          border: 1px solid #cbd5e1;
          border-radius: 5px;
        }
        #citi-offer-clicker .status {
          margin: 8px 0;
          padding: 8px;
          border-radius: 6px;
          background: #f8fafc;
          border: 1px solid #e5e7eb;
          line-height: 1.35;
        }
        #citi-offer-clicker .logs {
          height: 180px;
          overflow: auto;
          white-space: pre-wrap;
          background: #0f172a;
          color: #e5e7eb;
          padding: 8px;
          border-radius: 6px;
          font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 11px;
        }
      </style>
      <header>
        <span>Citi Offers</span>
        <button type="button" class="secondary" data-hide>Hide</button>
      </header>
      <main>
        <div>
          <label>Delay <input data-delay type="number" min="1000" step="500" value="5000"> ms</label>
          <label>Max <input data-max type="number" min="1" step="10" value="300"></label>
          <label>Keep alive <input data-keepalive-min type="number" min="1" step="1" value="4"> min</label>
        </div>
        <div>
          <button type="button" data-start>Add Offers</button>
          <button type="button" data-stop class="danger">Stop</button>
          <button type="button" data-debug class="secondary">Debug Scan</button>
          <button type="button" data-keepalive class="secondary">Keep Alive On</button>
          <button type="button" data-clear class="secondary">Clear Log</button>
        </div>
        <div class="status" data-status></div>
        <div class="logs" data-logs></div>
      </main>
    `;

    document.body.appendChild(el);
    el.addEventListener("click", (event) => event.stopPropagation());
    el.querySelector("[data-start]").addEventListener("click", (event) => {
      event.preventDefault();
      startRun();
    });
    el.querySelector("[data-stop]").addEventListener("click", (event) => {
      event.preventDefault();
      stopRun();
    });
    el.querySelector("[data-debug]").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      debugScan();
    });
    el.querySelector("[data-keepalive]").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const current = getKeepAliveConfig();
      const minutes = Number(el.querySelector("[data-keepalive-min]").value || 4);
      setKeepAliveConfig({ enabled: !current.enabled, intervalMs: Math.max(1, minutes) * 60000 });
      pushLog(`Keep alive ${!current.enabled ? "enabled" : "disabled"}.`);
    });
    el.querySelector("[data-keepalive-min]").addEventListener("change", (event) => {
      const current = getKeepAliveConfig();
      const minutes = Number(event.target.value || 4);
      setKeepAliveConfig({ ...current, intervalMs: Math.max(1, minutes) * 60000 });
      pushLog(`Keep alive interval set to ${Math.max(1, minutes)} minute(s).`);
    });
    el.querySelector("[data-clear]").addEventListener("click", clearLogs);
    el.querySelector("[data-hide]").addEventListener("click", () => {
      el.style.display = "none";
      const tab = document.createElement("button");
      tab.textContent = "Citi Offers";
      tab.style.cssText = "position:fixed;right:18px;top:92px;z-index:2147483647;padding:8px 10px;border-radius:6px;border:1px solid #0b5cab;background:#0b5cab;color:#fff;cursor:pointer";
      tab.addEventListener("click", () => {
        tab.remove();
        el.style.display = "block";
      });
      document.body.appendChild(tab);
    });

    return el;
  }

  function render(forceSummary = false) {
    if (!panel) return;
    const state = getState();
    const keepAlive = getKeepAliveConfig();
    const logs = getLogs();
    const addable = forceSummary ? getEnrollButtons().length : getEnrollButtons().length;
    const keepAliveMinutes = Math.max(1, Math.round(Number(keepAlive.intervalMs || 240000) / 60000));
    const keepAliveAge = lastKeepAliveAt ? `${Math.round((Date.now() - lastKeepAliveAt) / 1000)}s ago` : "not yet";
    const keepAliveButton = panel.querySelector("[data-keepalive]");
    const keepAliveInput = panel.querySelector("[data-keepalive-min]");
    if (keepAliveButton) keepAliveButton.textContent = keepAlive.enabled ? "Keep Alive On" : "Keep Alive Off";
    if (keepAliveInput && document.activeElement !== keepAliveInput) keepAliveInput.value = String(keepAliveMinutes);

    panel.querySelector("[data-status]").innerHTML = `
      <div><b>Status:</b> ${state.active ? "running" : (state.phase || "idle")}</div>
      <div><b>Version:</b> ${VERSION}</div>
      <div><b>Card:</b> ${selectedCardLabel()}</div>
      <div><b>Addable:</b> ${addable}</div>
      <div><b>Clicked:</b> ${Number(state.clicked || 0)}</div>
      <div><b>Keep alive:</b> ${keepAlive.enabled ? `${keepAliveMinutes} min, last ${keepAliveAge}` : "off"}</div>
      ${isLoggedOutOrTimedOut() ? "<div><b>Action:</b> Sign in again and open Merchant Offers.</div>" : ""}
    `;

    const logBox = panel.querySelector("[data-logs]");
    const nextLogText = logs.join("\n");
    if (logBox.textContent !== nextLogText) {
      logBox.textContent = nextLogText;
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  function boot() {
    if (document.getElementById("citi-offer-clicker")) return;
    panel = makePanel();
    scheduleKeepAlive();
    render(true);
    setInterval(() => scheduleRender(false), 5000);

    const state = getState();
    if (state.active) {
      pushLog("Resuming saved run after navigation/refresh.");
      window.setTimeout(() => processOffers(), 2500);
    }
  }

  boot();
})();
