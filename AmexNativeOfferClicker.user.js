// ==UserScript==
// @name         Amex Native Offer Clicker - Refresh Safe
// @namespace    https://global.americanexpress.com/
// @version      0.3.1
// @description  Adds Amex Offers by clicking the native Amex UI, with per-card refresh verification.
// @match        https://global.americanexpress.com/*
// @updateURL    https://raw.githubusercontent.com/DemingYan/private/main/AmexNativeOfferClicker.user.js
// @downloadURL  https://raw.githubusercontent.com/DemingYan/private/main/AmexNativeOfferClicker.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const STORE_KEY = "amexNativeOfferClickerState.v1";
  const LOG_KEY = "amexNativeOfferClickerLogs.v1";
  const KEEP_ALIVE_KEY = "amexNativeOfferClickerKeepAlive.v1";
  const ADD_BUTTON_SELECTOR = 'button[title="add to list card"]';
  const CARD_OPTION_SELECTOR = '[role="option"][data-testid^="simple_switcher_product_option_CARD_PRODUCT_"]';
  const CARD_COMBO_SELECTOR = [
    '#simple-switcher-wrapper [role="combobox"]',
    '[role="combobox"][aria-label*="manage your other accounts"]',
    '[data-testid="simple_switcher_wrapper"] [role="combobox"]'
  ].join(",");

  let panel;
  let abortRequested = false;
  let keepAliveTimer = null;
  let lastKeepAliveAt = 0;
  let renderTimer = null;
  let renderQueued = false;
  let pageSummaryCache = {
    card: "Unknown card",
    counters: "",
    plus: 0,
    updatedAt: 0
  };

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
    return loadJson(STORE_KEY, { active: false });
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

  function currentCardText() {
    const switcherText = textOf(document.querySelector(CARD_COMBO_SELECTOR));
    if (switcherText) return switcherText;

    const headerText = textOf(document.querySelector('[data-testid="simple_switcher_wrapper"]'));
    const match = headerText.match(/(?:Business Platinum Card®|Amex EveryDay® Card|Hilton Honors Surpass® Card|Hilton Honors Aspire Card|Marriott Bonvoy Brilliant® American Express® Card|Blue Cash Everyday®).*?••••\d+/);
    return match ? match[0].replace(/\s+/g, " ") : pageSummaryCache.card;
  }

  function getOfferName(button) {
    let root = button;
    for (let i = 0; i < 10 && root; i += 1) {
      const text = root.textContent || "";
      if (text.includes("View Details") && text.length > 30) break;
      root = root.parentElement;
    }
    const lines = (root?.textContent || "")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    return lines.slice(0, 3).join(" | ").replace(/\s+/g, " ").slice(0, 140) || "offer";
  }

  function addButtonCount() {
    return document.querySelectorAll(ADD_BUTTON_SELECTOR).length;
  }

  function countersText() {
    const candidates = Array.from(document.querySelectorAll("button, h2, h3, [aria-label]"))
      .map((node) => `${textOf(node)} ${node.getAttribute?.("aria-label") || ""}`);
    return candidates
      .flatMap((text) => text.match(/Available \(\d+\)|Added to Card \(\d+\)/g) || [])
      .filter((value, index, arr) => arr.indexOf(value) === index)
      .join(", ");
  }

  function refreshPageSummary(force = false) {
    const now = Date.now();
    if (!force && now - pageSummaryCache.updatedAt < 10000) return pageSummaryCache;

    pageSummaryCache = {
      card: currentCardText(),
      counters: countersText(),
      plus: addButtonCount(),
      updatedAt: now
    };
    return pageSummaryCache;
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

  function findSessionButton() {
    const candidates = Array.from(document.querySelectorAll('button, a, [role="button"]'));
    return candidates.find((node) => {
      const text = textOf(node);
      const aria = node.getAttribute?.("aria-label") || "";
      return /stay logged in|stay signed in|continue session|keep me signed in|yes, continue|i'?m still here/i.test(`${text} ${aria}`);
    });
  }

  function dispatchKeepAliveEvents() {
    const x = Math.max(10, Math.floor(window.innerWidth * 0.65));
    const y = Math.max(10, Math.floor(window.innerHeight * 0.28));
    const events = [
      new MouseEvent("mousemove", { bubbles: true, clientX: x, clientY: y }),
      new MouseEvent("mouseover", { bubbles: true, clientX: x, clientY: y }),
      new KeyboardEvent("keydown", { bubbles: true, key: "Shift" }),
      new KeyboardEvent("keyup", { bubbles: true, key: "Shift" })
    ];
    for (const event of events) document.dispatchEvent(event);

    const currentY = window.scrollY;
    window.scrollBy(0, 1);
    window.scrollTo(window.scrollX, currentY);
  }

  function keepAliveTick() {
    const config = getKeepAliveConfig();
    if (!config.enabled) return;

    const sessionButton = findSessionButton();
    if (sessionButton) {
      sessionButton.click();
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

  async function waitForPageReady(timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (document.querySelector(ADD_BUTTON_SELECTOR) || document.querySelector(CARD_COMBO_SELECTOR) || document.querySelector("[data-testid='simple_switcher_wrapper']")) {
        return true;
      }
      await sleep(500);
    }
    return false;
  }

  async function openCardSwitcher() {
    const combo = document.querySelector(CARD_COMBO_SELECTOR);
    if (!combo) {
      throw new Error("Could not find the Amex card switcher. Open an Amex dashboard/offers page first.");
    }
    combo.scrollIntoView({ block: "center" });
    await sleep(250);
    combo.click();
    await sleep(900);
  }

  function parseCardOption(option) {
    const testId = option.getAttribute("data-testid") || "";
    const idFromTestId = testId.replace(/^simple_switcher_product_option_CARD_PRODUCT_/, "");
    const idFromNodeId = (option.id || "").replace(/^combo-/, "");
    const opaqueAccountId = idFromTestId || idFromNodeId;
    return {
      opaqueAccountId,
      label: textOf(option),
      aria: option.getAttribute("aria-label") || ""
    };
  }

  async function discoverCards() {
    await openCardSwitcher();
    const cards = Array.from(document.querySelectorAll(CARD_OPTION_SELECTOR))
      .map(parseCardOption)
      .filter((card) => card.opaqueAccountId && !/CHECKING|ACCOUNT_/i.test(card.opaqueAccountId));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

    const seen = new Set();
    const unique = cards.filter((card) => {
      if (seen.has(card.opaqueAccountId)) return false;
      seen.add(card.opaqueAccountId);
      return true;
    });

    pushLog(`Scanned ${unique.length} card(s): ${unique.map((c) => c.label).join("; ")}`);
    return unique;
  }

  function offersUrl(card) {
    return `https://global.americanexpress.com/offers?opaqueAccountId=${encodeURIComponent(card.opaqueAccountId)}`;
  }

  function navigateToCard(card, phase) {
    const state = getState();
    setState({ ...state, phase, currentCard: card, lastNavigationAt: Date.now() });
    location.assign(offersUrl(card));
  }

  async function clickOneOffer(delayMs) {
    const button = document.querySelector(ADD_BUTTON_SELECTOR);
    if (!button) return false;

    const name = getOfferName(button);
    button.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(350);
    button.click();
    pushLog(`Clicked: ${name}`);
    await sleep(delayMs);
    return true;
  }

  async function clickUntilNoButtons(delayMs, maxClicksPerPage) {
    let clicked = 0;
    while (!abortRequested && addButtonCount() > 0 && clicked < maxClicksPerPage) {
      const before = addButtonCount();
      const ok = await clickOneOffer(delayMs);
      if (!ok) break;
      clicked += 1;

      const after = addButtonCount();
      if (after >= before) {
        await sleep(1500);
      }
    }
    return clicked;
  }

  async function processCurrentPage() {
    const state = getState();
    if (!state.active) return;

    const delayMs = Number(state.delayMs || 3500);
    const maxClicksPerPage = Number(state.maxClicksPerPage || 500);
    const cards = state.cards || [];
    const card = state.currentCard || cards[state.index || 0];
    if (!card) {
      pushLog("No card in queue.");
      setState({ active: false });
      return;
    }

    await waitForPageReady();
    const summary = refreshPageSummary(true);
    pushLog(`${state.phase || "process"}: ${summary.card} | plus=${summary.plus} | ${summary.counters}`);

    if (state.phase === "verify-after-refresh") {
      if (addButtonCount() > 0) {
        pushLog(`Refresh found ${addButtonCount()} more offer(s), continuing.`);
        setState({ ...state, phase: "process" });
        await processCurrentPage();
        return;
      }

      const doneSummary = refreshPageSummary(true);
      pushLog(`Done after refresh: ${doneSummary.card} | ${doneSummary.counters}`);
      const nextIndex = (state.index || 0) + 1;
      if (state.mode === "all" && nextIndex < cards.length) {
        const nextCard = cards[nextIndex];
        setState({ ...state, index: nextIndex, currentCard: nextCard, phase: "open" });
        pushLog(`Moving to next card: ${nextCard.label}`);
        navigateToCard(nextCard, "process");
        return;
      }

      pushLog("All queued card(s) completed.");
      setState({ ...state, active: false, phase: "done" });
      return;
    }

    const clicked = await clickUntilNoButtons(delayMs, maxClicksPerPage);
    pushLog(`Clicked ${clicked} offer(s) on this pass. Reloading to verify.`);

    if (abortRequested) {
      pushLog("Stopped by user.");
      setState({ ...state, active: false, phase: "stopped" });
      return;
    }

    setState({ ...state, phase: "verify-after-refresh" });
    location.reload();
  }

  async function startAllCards() {
    abortRequested = false;
    const cards = await discoverCards();
    if (!cards.length) {
      pushLog("No credit cards found.");
      return;
    }

    const first = cards[0];
    setState({
      active: true,
      mode: "all",
      cards,
      index: 0,
      currentCard: first,
      phase: "process",
      delayMs: Number(panel.querySelector("[data-delay]").value || 3500),
      maxClicksPerPage: Number(panel.querySelector("[data-max]").value || 500),
      startedAt: Date.now()
    });
    pushLog(`Starting all cards from: ${first.label}`);
    navigateToCard(first, "process");
  }

  async function startCurrentCard() {
    abortRequested = false;
    let card = null;
    try {
      const cards = await discoverCards();
      const currentTail = (currentCardText().match(/\d+$/) || [])[0];
      card = cards.find((candidate) => currentTail && candidate.label.includes(currentTail)) || cards[0];
    } catch (error) {
      const params = new URLSearchParams(location.search);
      const opaqueAccountId = params.get("opaqueAccountId");
      if (!opaqueAccountId) throw error;
      card = { opaqueAccountId, label: currentCardText() };
    }

    setState({
      active: true,
      mode: "one",
      cards: [card],
      index: 0,
      currentCard: card,
      phase: "process",
      delayMs: Number(panel.querySelector("[data-delay]").value || 3500),
      maxClicksPerPage: Number(panel.querySelector("[data-max]").value || 500),
      startedAt: Date.now()
    });
    pushLog(`Starting current card: ${card.label}`);
    navigateToCard(card, "process");
  }

  function stopRun() {
    abortRequested = true;
    const state = getState();
    setState({ ...state, active: false, phase: "stopped" });
    pushLog("Stop requested.");
  }

  function makePanel() {
    const el = document.createElement("div");
    el.id = "amex-native-offer-clicker";
    el.innerHTML = `
      <style>
        #amex-native-offer-clicker {
          position: fixed;
          z-index: 2147483647;
          right: 18px;
          top: 92px;
          width: 360px;
          color: #111827;
          background: #fff;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          box-shadow: 0 12px 30px rgba(15, 23, 42, 0.22);
          font-family: Arial, sans-serif;
          font-size: 13px;
        }
        #amex-native-offer-clicker header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 12px;
          border-bottom: 1px solid #e5e7eb;
          font-weight: 700;
        }
        #amex-native-offer-clicker main { padding: 10px 12px; }
        #amex-native-offer-clicker button {
          margin: 4px 4px 4px 0;
          padding: 7px 10px;
          border: 1px solid #0b5cab;
          border-radius: 6px;
          background: #0b5cab;
          color: white;
          cursor: pointer;
          font-size: 12px;
        }
        #amex-native-offer-clicker button.secondary {
          background: #fff;
          color: #0b5cab;
        }
        #amex-native-offer-clicker button.danger {
          border-color: #b91c1c;
          background: #b91c1c;
        }
        #amex-native-offer-clicker label {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          margin-right: 8px;
        }
        #amex-native-offer-clicker input {
          width: 72px;
          padding: 5px;
          border: 1px solid #cbd5e1;
          border-radius: 5px;
        }
        #amex-native-offer-clicker .status {
          margin: 8px 0;
          padding: 8px;
          border-radius: 6px;
          background: #f8fafc;
          border: 1px solid #e5e7eb;
          line-height: 1.35;
        }
        #amex-native-offer-clicker .logs {
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
        <span>Amex Native Offers</span>
        <button class="secondary" data-hide>Hide</button>
      </header>
      <main>
        <div>
          <label>Delay <input data-delay type="number" min="1000" step="500" value="3500"> ms</label>
          <label>Max <input data-max type="number" min="1" step="10" value="500"></label>
          <label>Keep alive <input data-keepalive-min type="number" min="1" step="1" value="4"> min</label>
        </div>
        <div>
          <button type="button" data-scan class="secondary">Scan Cards</button>
          <button type="button" data-current>Add Current Card</button>
          <button type="button" data-all>Add All Cards</button>
          <button type="button" data-stop class="danger">Stop</button>
          <button type="button" data-keepalive class="secondary">Keep Alive On</button>
          <button type="button" data-clear class="secondary">Clear Log</button>
        </div>
        <div class="status" data-status></div>
        <div class="logs" data-logs></div>
      </main>
    `;

    document.body.appendChild(el);
    el.addEventListener("click", (event) => event.stopPropagation());
    el.querySelector("[data-scan]").addEventListener("click", (event) => {
      event.preventDefault();
      discoverCards().catch((error) => pushLog(error.message));
    });
    el.querySelector("[data-current]").addEventListener("click", (event) => {
      event.preventDefault();
      startCurrentCard().catch((error) => pushLog(error.message));
    });
    el.querySelector("[data-all]").addEventListener("click", (event) => {
      event.preventDefault();
      startAllCards().catch((error) => pushLog(error.message));
    });
    el.querySelector("[data-stop]").addEventListener("click", (event) => {
      event.preventDefault();
      stopRun();
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
      tab.textContent = "Amex Offers";
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
    const summary = refreshPageSummary(forceSummary);
    const card = state.currentCard?.label || summary.card;
    const keepAliveMinutes = Math.max(1, Math.round(Number(keepAlive.intervalMs || 240000) / 60000));
    const keepAliveAge = lastKeepAliveAt ? `${Math.round((Date.now() - lastKeepAliveAt) / 1000)}s ago` : "not yet";
    const keepAliveButton = panel.querySelector("[data-keepalive]");
    const keepAliveInput = panel.querySelector("[data-keepalive-min]");
    if (keepAliveButton) keepAliveButton.textContent = keepAlive.enabled ? "Keep Alive On" : "Keep Alive Off";
    if (keepAliveInput && document.activeElement !== keepAliveInput) keepAliveInput.value = String(keepAliveMinutes);
    panel.querySelector("[data-status]").innerHTML = `
      <div><b>Status:</b> ${state.active ? "running" : (state.phase || "idle")}</div>
      <div><b>Card:</b> ${card}</div>
      <div><b>Queue:</b> ${state.cards ? `${(state.index || 0) + 1}/${state.cards.length}` : "none"}</div>
      <div><b>Page:</b> plus=${summary.plus} ${summary.counters}</div>
      <div><b>Keep alive:</b> ${keepAlive.enabled ? `${keepAliveMinutes} min, last ${keepAliveAge}` : "off"}</div>
    `;
    const logBox = panel.querySelector("[data-logs]");
    const nextLogText = logs.join("\n");
    if (logBox.textContent !== nextLogText) {
      logBox.textContent = nextLogText;
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  function boot() {
    if (document.getElementById("amex-native-offer-clicker")) return;
    panel = makePanel();
    scheduleKeepAlive();
    render(true);
    renderTimer = setInterval(() => scheduleRender(false), 5000);

    const state = getState();
    if (state.active) {
      pushLog("Resuming saved run after navigation/refresh.");
      setTimeout(() => processCurrentPage().catch((error) => {
        pushLog(`Error: ${error.message}`);
        setState({ ...getState(), active: false, phase: "error" });
      }), 2500);
    }
  }

  boot();
})();
