// ==UserScript==
// @name         Chase Native Offer Clicker - Refresh Safe
// @namespace    https://www.chase.com/
// @version      0.2.0
// @description  Adds Chase Offers by clicking native Chase offer tiles slowly, with all-card queue support.
// @match        https://*.chase.com/*
// @match        https://chase.com/*
// @updateURL    https://raw.githubusercontent.com/wtxcn/private/main/ChaseOfferClicker.user.js
// @downloadURL  https://raw.githubusercontent.com/wtxcn/private/main/ChaseOfferClicker.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const STORE_KEY = "chaseOfferClickerState.v1";
  const LOG_KEY = "chaseOfferClickerLogs.v1";
  const KEEP_ALIVE_KEY = "chaseOfferClickerKeepAlive.v1";
  const ACCOUNT_IDS_KEY = "chaseOfferClickerAccountIds.v1";

  let panel;
  let abortRequested = false;
  let renderQueued = false;
  let keepAliveTimer = null;
  let lastKeepAliveAt = 0;
  let pageSummaryCache = {
    addable: 0,
    page: "",
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

  function getAccountIds() {
    return loadJson(ACCOUNT_IDS_KEY, []);
  }

  function setAccountIds(ids) {
    saveJson(ACCOUNT_IDS_KEY, Array.from(new Set(ids.filter(Boolean))));
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
      node.getAttribute("alt") || "",
      node.getAttribute("data-testid") || "",
      node.getAttribute("data-test-id") || "",
      node.getAttribute("id") || "",
      node.value || ""
    ].join(" ").replace(/\s+/g, " ").trim();
  }

  function isVisible(node) {
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function isEnabled(node) {
    return !node.disabled && node.getAttribute("aria-disabled") !== "true";
  }

  function nearbyText(node) {
    let root = node;
    for (let i = 0; i < 8 && root; i += 1) {
      const text = root.textContent || "";
      if (text.length > 40 && /(offer|cash back|earn|\$|%|expires|merchant|restaurant|shopping|deal|coupon|redeem|activated|added)/i.test(text)) break;
      root = root.parentElement;
    }
    return (root?.textContent || node.textContent || "").replace(/\s+/g, " ").trim().slice(0, 260);
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

  function getCurrentAccountId() {
    const match = location.href.match(/[?&]accountId=(\d+)/);
    return match ? match[1] : "";
  }

  function offerHubUrl(accountId) {
    return `https://secure.chase.com/web/auth/dashboard#/dashboard/merchantOffers/offerCategoriesPage?accountId=${encodeURIComponent(accountId)}&offerCategoryName=ALL`;
  }

  function isOffersHubPage() {
    return /\/merchantOffers\/offerCategoriesPage/i.test(location.hash || location.href);
  }

  function isOverviewPage() {
    return /\/dashboard\/overview/i.test(location.hash || location.href);
  }

  function extractAccountIdsFromPage() {
    const ids = [];
    const current = getCurrentAccountId();
    if (current) ids.push(current);

    const html = document.documentElement.innerHTML || "";
    Array.from(html.matchAll(/accountId[^0-9]{0,30}(\d{4,})/gi)).forEach((match) => ids.push(match[1]));

    return Array.from(new Set(ids));
  }

  function scanAccounts() {
    const ids = extractAccountIdsFromPage();
    if (ids.length > 0) {
      setAccountIds(ids);
      pushLog(`Scanned ${ids.length} account candidate(s): ${ids.map((id) => `...${id.slice(-4)}`).join(", ")}`);
    } else {
      pushLog("No accountId candidates found. Open Chase account overview or an Offers page, then scan again.");
    }
    return ids;
  }

  function isOfferTile(node) {
    return node?.getAttribute?.("data-testid") === "commerce-tile";
  }

  function isAddOfferControl(node) {
    if (!isVisible(node) || !isEnabled(node)) return false;
    if (node.closest?.("#chase-offer-clicker")) return false;
    if (isOfferTile(node)) {
      if (!isOffersHubPage()) return false;
      if (!node.closest('[data-testid="categoryOffersSectionContainer"], #content, #app-container, main')) return false;
      const tileLabel = `${node.getAttribute("aria-label") || ""} ${textOf(node)}`;
      return /\bAdd offer\b/i.test(tileLabel) && !/(Success Added|Added to card|Activated|offer activated|offer added)/i.test(tileLabel);
    }

    const label = getLabel(node);
    const context = nearbyText(node);
    const haystack = `${label} ${context}`;

    if (/(added|activated|saved|remove|removed|view|details|learn|filter|sort|search|make payment|pay|transfer|download|log out|sign out|shop now|continue)/i.test(label)) return false;
    if (/(offer added|offer activated|already added|already activated)/i.test(haystack)) return false;

    const labelLooksAddable = /(add to card|add offer|add this offer|activate offer|activate this offer|clip offer|save offer|activate now)/i.test(label)
      || (/(^|\s)(add|activate|clip|save)(\s|$)/i.test(label) && /(offer|deal|coupon|merchant|card)/i.test(haystack));
    if (!labelLooksAddable) return false;

    return /(offer|cash back|earn|\$|%|expires|merchant|restaurant|shopping|grocery|travel|gas|deal|coupon|redeem)/i.test(context);
  }

  function getAddButtons() {
    if (isOffersHubPage()) {
      return Array.from(document.querySelectorAll('[data-testid="commerce-tile"]')).filter(isAddOfferControl);
    }

    const selector = 'button, [role="button"], input[type="button"], input[type="submit"], a[role="button"]';
    return getSearchRoots()
      .flatMap((root) => Array.from(root.querySelectorAll(selector)))
      .filter(isAddOfferControl);
  }

  function getOfferName(button) {
    const tileLabel = button.getAttribute?.("aria-label") || "";
    const text = isOfferTile(button) ? tileLabel || textOf(button) : nearbyText(button);
    return text
      .replace(/^\d+\s+of\s+\d+\s+/i, "")
      .replace(/\b(add to card|add offer|activate offer|activate|clip offer|save offer|success added)\b/ig, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 140) || "offer";
  }

  function pageLabel() {
    const title = document.title || "";
    const h1 = textOf(document.querySelector("h1"));
    const h2 = textOf(document.querySelector("h2"));
    return [h1, h2, title].filter(Boolean).join(" | ").slice(0, 160);
  }

  function isLoggedOutOrTimedOut() {
    const pageText = textOf(document.body).slice(0, 2000);
    return /your session timed out|session timed out|sign in to chase|log on to chase|secure message center sign in/i.test(pageText)
      || (/\/logon|\/login/i.test(location.href) && /chase/i.test(location.hostname));
  }

  function debugScan() {
    const selector = isOffersHubPage()
      ? '[data-testid="commerce-tile"]'
      : 'button, [role="button"], input[type="button"], input[type="submit"], a[role="button"], [data-testid="commerce-tile"]';
    const candidates = (isOffersHubPage() ? [document] : getSearchRoots())
      .flatMap((root) => Array.from(root.querySelectorAll(selector)))
      .filter((node) => isVisible(node))
      .map((node) => ({
        label: getLabel(node).slice(0, 90) || "(no label)",
        context: nearbyText(node).slice(0, 130),
        addable: isAddOfferControl(node)
      }))
      .filter((item) => item.addable || /(offer|cash back|activate|add|deal|coupon|\$|%)/i.test(`${item.label} ${item.context}`))
      .slice(0, 20);

    pushLog(`Debug scan: addable=${getAddButtons().length}, candidates=${candidates.length}, timedOut=${isLoggedOutOrTimedOut()}, hub=${isOffersHubPage()}`);
    candidates.forEach((item, index) => {
      pushLog(`#${index + 1} ${item.addable ? "ADD" : "skip"} | ${item.label} | ${item.context}`);
    });
  }

  function refreshPageSummary(force = false) {
    const now = Date.now();
    if (!force && now - pageSummaryCache.updatedAt < 10000) return pageSummaryCache;

    pageSummaryCache = {
      addable: getAddButtons().length,
      page: isLoggedOutOrTimedOut() ? `Logged out / timed out | ${pageLabel()}` : pageLabel(),
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
      const label = `${textOf(node)} ${node.getAttribute?.("aria-label") || ""}`;
      return /stay signed in|stay logged in|continue session|keep me signed in|yes, continue|i'?m still here/i.test(label);
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
      if (getAddButtons().length > 0 || /chase offers|offers/i.test(pageLabel())) return true;
      await sleep(500);
    }
    return false;
  }

  function currentQueueAccount(state) {
    const queue = Array.isArray(state.accountIds) ? state.accountIds : [];
    return queue[state.queueIndex || 0] || state.accountId || getCurrentAccountId();
  }

  function navigateToAccountHub(accountId, nextState = {}) {
    if (!accountId) return false;
    const url = offerHubUrl(accountId);
    setState({ ...getState(), ...nextState, accountId, hubUrl: url, phase: nextState.phase || "navigate-hub" });
    if (location.href !== url) {
      pushLog(`Opening Offers Hub for account ...${accountId.slice(-4)}.`);
      location.assign(url);
      return true;
    }
    return false;
  }

  function ensureOnHubForState(state) {
    const accountId = currentQueueAccount(state);
    if (!accountId) return false;
    if (!isOffersHubPage() || getCurrentAccountId() !== accountId || !/offerCategoryName=ALL/i.test(location.href)) {
      navigateToAccountHub(accountId, { ...state, phase: "process" });
      return false;
    }
    return true;
  }

  async function clickOneOffer(delayMs) {
    const buttons = getAddButtons();
    const button = buttons[0];
    if (!button) return false;

    const name = getOfferName(button);
    const hubUrl = isOffersHubPage() ? location.href : "";
    button.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(400);
    button.click();
    pushLog(`Clicked: ${name}`);
    await sleep(delayMs);

    if (hubUrl && location.href !== hubUrl) {
      pushLog("Returned to Offers Hub after Chase opened the offer detail page.");
      location.assign(hubUrl);
    }

    return true;
  }

  async function clickLoadedOffers(delayMs, maxClicks) {
    let clicked = 0;
    while (!abortRequested && getAddButtons().length > 0 && clicked < maxClicks) {
      const before = getAddButtons().length;
      const ok = await clickOneOffer(delayMs);
      if (!ok) break;
      clicked += 1;

      if (getAddButtons().length >= before) await sleep(1500);
    }
    return clicked;
  }

  async function scrollForMore() {
    const beforeY = window.scrollY;
    const beforeHeight = document.body.scrollHeight;
    window.scrollBy({ top: Math.floor(window.innerHeight * 0.8), behavior: "smooth" });
    await sleep(1800);
    return window.scrollY !== beforeY || document.body.scrollHeight !== beforeHeight;
  }

  async function processCurrentPage() {
    const state = getState();
    if (!state.active) return;

    await waitForPageReady();

    if (isLoggedOutOrTimedOut()) {
      pushLog("Chase session is logged out or timed out. Sign in, open Chase Offers, then run again.");
      setState({ ...state, active: false, phase: "timed-out" });
      return;
    }

    if (!ensureOnHubForState(state)) return;

    const delayMs = Number(state.delayMs || 5000);
    const maxClicks = Number(state.maxClicksPerPass || 200);
    let totalClicked = 0;
    let noMoreRounds = 0;

    pushLog(`Start pass: account ...${String(currentQueueAccount(state)).slice(-4)} | addable=${getAddButtons().length}`);

    while (!abortRequested && totalClicked < maxClicks && noMoreRounds < 3) {
      const clicked = await clickLoadedOffers(delayMs, maxClicks - totalClicked);
      totalClicked += clicked;

      if (!isOffersHubPage()) return;

      const moved = await scrollForMore();
      const addable = getAddButtons().length;
      pushLog(`Pass progress: clicked=${totalClicked}, addable=${addable}`);

      if (clicked === 0 && addable === 0 && !moved) noMoreRounds += 1;
      else noMoreRounds = 0;
    }

    if (abortRequested) {
      pushLog("Stopped by user.");
      setState({ ...state, active: false, phase: "stopped" });
      return;
    }

    pushLog(`Clicked ${totalClicked} offer(s) for account ...${String(currentQueueAccount(state)).slice(-4)}. Reloading to verify.`);
    setState({ ...state, phase: "verify-after-refresh", accountId: currentQueueAccount(state) });
    location.reload();
  }

  function finishCurrentAccount(state, reason) {
    const queue = Array.isArray(state.accountIds) ? state.accountIds : [];
    const accountId = currentQueueAccount(state);
    if (reason) pushLog(reason);

    if (state.allCards && queue.length > 0 && (state.queueIndex || 0) < queue.length - 1) {
      const nextIndex = (state.queueIndex || 0) + 1;
      const nextAccountId = queue[nextIndex];
      pushLog(`Moving to next account ${nextIndex + 1}/${queue.length}: ...${nextAccountId.slice(-4)}.`);
      setState({ ...state, phase: "process", queueIndex: nextIndex, accountId: nextAccountId });
      location.assign(offerHubUrl(nextAccountId));
      return;
    }

    pushLog(`Done: no addable offers found${accountId ? ` for account ...${accountId.slice(-4)}` : ""}.`);
    setState({ ...state, active: false, phase: "done" });
  }

  async function resumeAfterRefresh() {
    const state = getState();
    if (!state.active) return;

    if (state.phase === "scan-accounts") {
      await sleep(2000);
      let accountIds = scanAccounts();
      if (accountIds.length <= 1) {
        const cached = getAccountIds();
        if (cached.length > accountIds.length) accountIds = cached;
      }

      if (accountIds.length === 0) {
        pushLog("No accounts found on overview. Stopping.");
        setState({ ...state, active: false, phase: "no-accounts" });
        return;
      }

      pushLog(`Starting queue after scan: ${accountIds.length} account candidate(s).`);
      setState({ ...state, phase: "process", allCards: true, accountIds, queueIndex: 0, accountId: accountIds[0], hubUrl: offerHubUrl(accountIds[0]) });
      location.assign(offerHubUrl(accountIds[0]));
      return;
    }

    await waitForPageReady();

    if (!ensureOnHubForState(state)) return;

    if (state.phase === "verify-after-refresh") {
      window.scrollTo(0, 0);
      await sleep(1500);
      const addable = getAddButtons().length;
      if (addable > 0) {
        pushLog(`Refresh found ${addable} more offer(s), continuing.`);
        setState({ ...state, phase: "process" });
        await processCurrentPage();
        return;
      }

      finishCurrentAccount(state, "Done after refresh: no addable offers found.");
      return;
    }

    await processCurrentPage();
  }

  function startRun(options = {}) {
    abortRequested = false;
    let accountIds = [];
    if (options.allCards) {
      accountIds = getAccountIds();
      if (accountIds.length === 0) accountIds = scanAccounts();
      if (accountIds.length <= 1 && !isOverviewPage()) {
        setState({
          active: true,
          phase: "scan-accounts",
          delayMs: Number(panel.querySelector("[data-delay]").value || 5000),
          maxClicksPerPass: Number(panel.querySelector("[data-max]").value || 200),
          allCards: true,
          accountIds,
          queueIndex: 0,
          startedAt: Date.now()
        });
        pushLog("Opening overview to scan all card account IDs.");
        location.assign("https://secure.chase.com/web/auth/dashboard#/dashboard/overview");
        return;
      }
    }

    const accountId = options.allCards
      ? accountIds[0]
      : getCurrentAccountId() || currentQueueAccount(getState());

    if (!accountId) {
      pushLog("No accountId found. Open Chase Offers or account overview, then scan cards.");
      return;
    }

    setState({
      active: true,
      phase: "process",
      delayMs: Number(panel.querySelector("[data-delay]").value || 5000),
      maxClicksPerPass: Number(panel.querySelector("[data-max]").value || 200),
      allCards: Boolean(options.allCards),
      accountIds: options.allCards ? accountIds : [accountId],
      queueIndex: 0,
      accountId,
      hubUrl: offerHubUrl(accountId),
      startedAt: Date.now()
    });
    pushLog(options.allCards ? `Starting Chase Offers run for ${accountIds.length} account candidate(s).` : "Starting Chase Offers run for current account.");
    if (!isOffersHubPage() || getCurrentAccountId() !== accountId || !/offerCategoryName=ALL/i.test(location.href)) {
      location.assign(offerHubUrl(accountId));
      return;
    }
    resumeAfterRefresh().catch((error) => {
      pushLog(`Error: ${error.message}`);
      setState({ ...getState(), active: false, phase: "error" });
    });
  }

  function stopRun() {
    abortRequested = true;
    const state = getState();
    setState({ ...state, active: false, phase: "stopped" });
    pushLog("Stop requested.");
  }

  function makePanel() {
    const el = document.createElement("div");
    el.id = "chase-offer-clicker";
    el.innerHTML = `
      <style>
        #chase-offer-clicker {
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
        #chase-offer-clicker header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 12px;
          border-bottom: 1px solid #e5e7eb;
          font-weight: 700;
        }
        #chase-offer-clicker main { padding: 10px 12px; }
        #chase-offer-clicker button {
          margin: 4px 4px 4px 0;
          padding: 7px 10px;
          border: 1px solid #0b5cab;
          border-radius: 6px;
          background: #0b5cab;
          color: white;
          cursor: pointer;
          font-size: 12px;
        }
        #chase-offer-clicker button.secondary {
          background: #fff;
          color: #0b5cab;
        }
        #chase-offer-clicker button.danger {
          border-color: #b91c1c;
          background: #b91c1c;
        }
        #chase-offer-clicker label {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          margin-right: 8px;
        }
        #chase-offer-clicker input {
          width: 72px;
          padding: 5px;
          border: 1px solid #cbd5e1;
          border-radius: 5px;
        }
        #chase-offer-clicker .status {
          margin: 8px 0;
          padding: 8px;
          border-radius: 6px;
          background: #f8fafc;
          border: 1px solid #e5e7eb;
          line-height: 1.35;
        }
        #chase-offer-clicker .logs {
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
        <span>Chase Offers</span>
        <button type="button" class="secondary" data-hide>Hide</button>
      </header>
      <main>
        <div>
          <label>Delay <input data-delay type="number" min="1000" step="500" value="5000"> ms</label>
          <label>Max <input data-max type="number" min="1" step="10" value="200"></label>
          <label>Keep alive <input data-keepalive-min type="number" min="1" step="1" value="4"> min</label>
        </div>
        <div>
          <button type="button" data-start>Add Loaded Offers</button>
          <button type="button" data-scan class="secondary">Scan Cards</button>
          <button type="button" data-start-all>Add All Cards</button>
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
      startRun({ allCards: false });
    });
    el.querySelector("[data-scan]").addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      scanAccounts();
    });
    el.querySelector("[data-start-all]").addEventListener("click", (event) => {
      event.preventDefault();
      startRun({ allCards: true });
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
      tab.textContent = "Chase Offers";
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
    const accountIds = getAccountIds();
    const queue = Array.isArray(state.accountIds) ? state.accountIds : [];
    const queueText = state.allCards && queue.length > 0
      ? `${Math.min((state.queueIndex || 0) + 1, queue.length)}/${queue.length} (...${String(currentQueueAccount(state) || "").slice(-4)})`
      : "current";
    const keepAliveMinutes = Math.max(1, Math.round(Number(keepAlive.intervalMs || 240000) / 60000));
    const keepAliveAge = lastKeepAliveAt ? `${Math.round((Date.now() - lastKeepAliveAt) / 1000)}s ago` : "not yet";
    const keepAliveButton = panel.querySelector("[data-keepalive]");
    const keepAliveInput = panel.querySelector("[data-keepalive-min]");
    if (keepAliveButton) keepAliveButton.textContent = keepAlive.enabled ? "Keep Alive On" : "Keep Alive Off";
    if (keepAliveInput && document.activeElement !== keepAliveInput) keepAliveInput.value = String(keepAliveMinutes);

    panel.querySelector("[data-status]").innerHTML = `
      <div><b>Status:</b> ${state.active ? "running" : (state.phase || "idle")}</div>
      <div><b>Page:</b> ${summary.page || "unknown"}</div>
      <div><b>Queue:</b> ${queueText}; scanned ${accountIds.length}</div>
      <div><b>Addable:</b> ${summary.addable}</div>
      <div><b>Keep alive:</b> ${keepAlive.enabled ? `${keepAliveMinutes} min, last ${keepAliveAge}` : "off"}</div>
      ${isLoggedOutOrTimedOut() ? "<div><b>Action:</b> Sign in again and open Chase Offers.</div>" : ""}
    `;

    const logBox = panel.querySelector("[data-logs]");
    const nextLogText = logs.join("\n");
    if (logBox.textContent !== nextLogText) {
      logBox.textContent = nextLogText;
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  function boot() {
    if (document.getElementById("chase-offer-clicker")) return;
    panel = makePanel();
    scheduleKeepAlive();
    render(true);
    setInterval(() => scheduleRender(false), 5000);

    const state = getState();
    if (state.active) {
      pushLog("Resuming saved run after navigation/refresh.");
      setTimeout(() => resumeAfterRefresh().catch((error) => {
        pushLog(`Error: ${error.message}`);
        setState({ ...getState(), active: false, phase: "error" });
      }), 2500);
    }
  }

  boot();
})();
