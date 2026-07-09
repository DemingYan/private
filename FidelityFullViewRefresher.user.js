// ==UserScript==
// @name         Fidelity Full View Refresher
// @namespace    https://digital.fidelity.com/
// @version      0.3.4
// @description  Refreshes linked institutions in Fidelity Full View by clicking the native Refresh information control slowly.
// @match        https://digital.fidelity.com/ftgw/pna/customer/pgc/networth/*
// @match        https://digital.fidelity.com/ftgw/pna/customer/pgc/networth*
// @updateURL    https://raw.githubusercontent.com/wtxcn/private/main/FidelityFullViewRefresher.user.js
// @downloadURL  https://raw.githubusercontent.com/wtxcn/private/main/FidelityFullViewRefresher.user.js
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const VERSION = "0.3.4";
  const STORE_KEY = "fidelityFullViewRefresherState.v1";
  const LOG_KEY = "fidelityFullViewRefresherLogs.v1";
  const QUEUE_KEY = "fidelityFullViewRefresherQueue.v1";

  let panel;
  let abortRequested = false;
  let renderQueued = false;

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
    saveJson(LOG_KEY, logs.slice(-300));
    scheduleRender();
  }

  function clearLogs(event) {
    event?.preventDefault();
    event?.stopPropagation();
    saveJson(LOG_KEY, []);
    panel?.querySelector("[data-logs]")?.replaceChildren();
    scheduleRender(true);
  }

  function textOf(node) {
    return (node?.innerText || node?.textContent || "").trim().replace(/\s+/g, " ");
  }

  function isVisible(node) {
    if (!node || !node.getBoundingClientRect) return false;
    const rect = node.getBoundingClientRect();
    const style = window.getComputedStyle(node);
    return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
  }

  function isEnabled(node) {
    return !node.disabled && node.getAttribute("aria-disabled") !== "true";
  }

  function isOwnPanel(node) {
    return Boolean(node?.closest?.("#fidelity-full-view-refresher"));
  }

  function getSearchRoots() {
    const roots = [document];
    const seen = new Set(roots);

    function collectShadowRoots(root) {
      Array.from(root.querySelectorAll("*")).forEach((node) => {
        if (node.shadowRoot && !seen.has(node.shadowRoot)) {
          seen.add(node.shadowRoot);
          roots.push(node.shadowRoot);
          collectShadowRoots(node.shadowRoot);
        }
      });
    }

    collectShadowRoots(document);

    Array.from(document.querySelectorAll("iframe")).forEach((frame) => {
      try {
        const doc = frame.contentDocument;
        if (doc && !seen.has(doc)) {
          seen.add(doc);
          roots.push(doc);
          collectShadowRoots(doc);
        }
      } catch (_) {
        // Cross-origin frames cannot be inspected from a userscript.
      }
    });

    return roots;
  }

  function getAllCandidates(selector) {
    return getSearchRoots().flatMap((root) => Array.from(root.querySelectorAll(selector)));
  }

  function pageLabel() {
    const headings = Array.from(document.querySelectorAll("h1,h2,[role='heading']"))
      .filter(isVisible)
      .map(textOf)
      .filter(Boolean);
    return headings.slice(0, 2).join(" | ") || document.title || location.pathname;
  }

  function isEditAccountsPage() {
    const body = textOf(document.body).slice(0, 3000);
    return (/Edit accounts/i.test(body) && /Linked\s*\(\d+\s+institutions?\)/i.test(body))
      || getInstitutionCards().length >= 1;
  }

  function isEditInstitutionPage() {
    const refresh = getRefreshInformationButton();
    const back = getBackButton();
    if (!refresh && !back) return false;
    const detailRoot = getDetailRoot(refresh);
    const detailText = textOf(detailRoot || document.body);
    const bodyText = textOf(document.body);
    return /Edit institution/i.test(`${detailText} ${bodyText}`)
      || (/Refresh information/i.test(bodyText) && /Find accounts|Delete institution|Back/i.test(bodyText));
  }

  function getClickableLabel(node) {
    return [
      textOf(node),
      node.getAttribute("aria-label") || "",
      node.getAttribute("title") || "",
      node.getAttribute("data-testid") || "",
      node.id || ""
    ].join(" ").replace(/\s+/g, " ").trim();
  }

  function findByText(pattern) {
    const selector = "button, a, [role='button'], [tabindex], input[type='button'], input[type='submit']";
    return getAllCandidates(selector)
      .filter((node) => !isOwnPanel(node) && isVisible(node) && isEnabled(node))
      .find((node) => pattern.test(getClickableLabel(node)));
  }

  function findActionByText(pattern, preferredSelector = "", options = {}) {
    const includeDisabled = Boolean(options.includeDisabled);
    const canUse = (node) => !isOwnPanel(node) && isVisible(node) && (includeDisabled || isEnabled(node));
    const matchesActionText = (node) => pattern.test(textOf(node)) || pattern.test(getClickableLabel(node));

    if (preferredSelector) {
      const preferred = getAllCandidates(preferredSelector)
        .filter(canUse)
        .find(matchesActionText);
      if (preferred) return closestClickable(preferred);
    }

    const selectors = [
      "button",
      "a",
      "[role='button']",
      "[tabindex]",
      "input[type='button']",
      "input[type='submit']",
      "pvd3-button"
    ].filter(Boolean).join(",");

    const semantic = getAllCandidates(selectors)
      .filter(canUse)
      .find(matchesActionText);
    if (semantic) return closestClickable(semantic);

    const textNode = getAllCandidates("button,a,[role='button'],[tabindex],pvd3-button,div,span,s-slot,s-assigned-wrapper")
      .filter(canUse)
      .find((node) => pattern.test(textOf(node)));
    return textNode ? closestClickable(textNode) : null;
  }

  function getRefreshInformationButton() {
    return findActionByText(/^Refresh information$/i, "[id='refresh-connection-btn']")
      || findActionByText(/Refresh information/i, "[id='refresh-connection-btn']");
  }

  function getRefreshInformationButtonAnyState() {
    return findActionByText(/^Refresh information$/i, "[id='refresh-connection-btn']", { includeDisabled: true })
      || findActionByText(/Refresh information/i, "[id='refresh-connection-btn']", { includeDisabled: true });
  }

  function getBackButton() {
    return getAllCandidates("button[id='fvlBackButton'], [id='fvlBackButton']")
      .filter((node) => !isOwnPanel(node) && isVisible(node) && isEnabled(node))
      .find(Boolean)
      || findActionByText(/^Back$/i, "[id='fvlBackButton']")
      || findActionByText(/^Back$/i);
  }

  function getCloseButton() {
    return getAllCandidates("button[aria-label='Close'], [aria-label='Close']")
      .filter((node) => !isOwnPanel(node) && isVisible(node) && isEnabled(node))
      .find(Boolean)
      || findActionByText(/^Close$/i);
  }

  function describeNode(node) {
    if (!node) return "none";
    const tag = node.tagName?.toLowerCase() || "node";
    const id = node.id ? `#${node.id}` : "";
    const label = (node.getAttribute?.("aria-label") || textOf(node)).trim();
    return `${tag}${id}${label ? ` (${label})` : ""}`;
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

    ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove", "pointerdown", "mousedown", "pointerup", "mouseup", "click"].forEach((type) => {
      const EventClass = type.startsWith("pointer") && typeof PointerEvent !== "undefined" ? PointerEvent : MouseEvent;
      node.dispatchEvent(new EventClass(type, { ...base, button: 0, buttons: type.endsWith("down") ? 1 : 0, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    });
    node.click?.();
    return true;
  }

  function getDetailRoot(node) {
    return closestAcrossRoots(node, ".focus-layer-content, .connection-detail, aggregation-fullview-link-content, aggregation-connection-detail")
      || closestAcrossRoots(node, ".connection-actions")
      || node?.parentElement;
  }

  function closestClickable(node) {
    let current = node;
    for (let i = 0; i < 8 && current; i += 1) {
      const tag = current.tagName?.toLowerCase();
      const role = current.getAttribute?.("role") || "";
      const tabindex = current.getAttribute?.("tabindex");
      if (tag === "button" || tag === "a" || role === "button" || tabindex === "0") return current;
      current = current.parentElement || current.getRootNode?.().host;
    }
    return node;
  }

  function closestAcrossRoots(node, selector) {
    let current = node;
    for (let i = 0; i < 10 && current; i += 1) {
      const match = current.closest?.(selector);
      if (match) return match;
      current = current.getRootNode?.().host || current.parentElement;
    }
    return null;
  }

  function isInstitutionGrid(node) {
    if (!isVisible(node) || !isEnabled(node)) return false;
    if (node.closest?.("#fidelity-full-view-refresher")) return false;
    if (node.classList?.contains("account")) return false;
    if (!node.classList?.contains("grid")) return false;
    if ((node.getAttribute("role") || "") !== "button") return false;
    const id = node.id || "";
    const text = textOf(node);
    if (!id || id === "manage-accts-button") return false;
    if (/Add more accounts|Add a non-Fidelity account|Edit\/Link Accounts|Edit non-Fidelity accounts/i.test(`${id} ${text}`)) return false;
    return text.length > 1 && text.length < 180;
  }

  function getInstitutionCards() {
    const gridCards = getAllCandidates("div.grid[role='button']").filter(isInstitutionGrid);
    const seen = new Set();
    return gridCards
      .filter((node) => {
        const key = node.id || textOf(node);
        if (!key || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((node) => {
        const text = textOf(node);
        const id = node.id || "";
        const rawName = text || id;
        const name = rawName
          .replace(/\s+-\s+via\s+.+$/i, "")
          .replace(/\$[\d,.-]+/g, "")
          .replace(/\b(Cash Equivalent|Checking|Savings|Credit Card|Brokerage|Loan|Mortgage)\b.*$/i, "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 120);
        return { node, clickable: node, name, text };
      });
  }

  function nearestActionButton(node) {
    if (!node) return null;
    const parentAction = node.closest?.("button, a, [role='button'], [tabindex], pvd3-button");
    if (parentAction && parentAction !== node) return parentAction;
    if (node.matches?.("button, a, [role='button'], [tabindex], pvd3-button")) return node;

    const childAction = Array.from(node.querySelectorAll?.("button, a, [role='button'], [tabindex], pvd3-button") || [])
      .find((child) => !isOwnPanel(child) && isVisible(child) && isEnabled(child));
    return childAction || node;
  }

  function findEditAccountsButton() {
    const preferredText = /^Edit non-Fidelity accounts$/i;
    const fallbackText = /^Edit\/Link Accounts$/i;
    const findAction = (pattern) => getAllCandidates("button, a, [role='button'], [tabindex], pvd3-button")
      .filter((node) => !isOwnPanel(node) && isVisible(node) && isEnabled(node))
      .find((node) => pattern.test(textOf(node)) || pattern.test(getClickableLabel(node)));

    const preferredAction = findAction(preferredText);
    if (preferredAction) return preferredAction;

    const exactText = /^(Edit\/Link Accounts|Edit non-Fidelity accounts)$/i;
    const primaryAction = getAllCandidates("button, a, [role='button'], [tabindex], pvd3-button")
      .filter((node) => !isOwnPanel(node) && isVisible(node) && isEnabled(node))
      .find((node) => fallbackText.test(textOf(node)) || fallbackText.test(getClickableLabel(node)) || exactText.test(textOf(node)) || exactText.test(getClickableLabel(node)));
    if (primaryAction) return primaryAction;

    const textNode = getAllCandidates("span, div")
      .filter((node) => !isOwnPanel(node) && isVisible(node) && isEnabled(node))
      .find((node) => exactText.test(textOf(node)));
    return nearestActionButton(textNode)
      || findByText(exactText)
      || findByText(/Edit\/Link Accounts|Edit non-Fidelity accounts/i);
  }

  function visibleActionLabels(limit = 10) {
    return getAllCandidates("button, a, [role='button'], [tabindex], pvd3-button")
      .filter((node) => !isOwnPanel(node) && isVisible(node) && isEnabled(node))
      .map((node) => textOf(node) || node.getAttribute("aria-label") || node.id || node.tagName?.toLowerCase() || "")
      .filter(Boolean)
      .slice(0, limit)
      .join(" | ");
  }

  async function ensureEditAccountsPage(timeoutMs = 30000) {
    if (isEditAccountsPage()) return true;

    const start = Date.now();
    let attempt = 0;
    while (Date.now() - start < timeoutMs) {
      if (isEditAccountsPage()) return true;

      const button = findEditAccountsButton();
      if (button) {
        attempt += 1;
        const clicked = humanClick(button) ? describeNode(button) : "";
        pushLog(`Clicked Edit/Link Accounts attempt ${attempt} via ${clicked || "unknown"}.`);
        const ready = await waitForPage(isEditAccountsPage, 5000);
        if (ready) return true;
        pushLog(`Edit accounts list not visible after attempt ${attempt}. Retrying.`);
      }

      await sleep(700);
    }

    pushLog(`Could not find Edit/Link Accounts. Visible actions: ${visibleActionLabels() || "none"}`);
    return false;
  }

  function getQueue() {
    return loadJson(QUEUE_KEY, []);
  }

  function setQueue(queue) {
    saveJson(QUEUE_KEY, queue);
    scheduleRender(true);
  }

  function scanInstitutions() {
    if (!isEditAccountsPage()) {
      setQueue([]);
      pushLog("Open Edit accounts first, then scan. Use Refresh All to open it automatically.");
      return [];
    }

    const queue = getInstitutionCards().map((item, index) => ({
      index,
      name: item.name || `Institution ${index + 1}`
    }));
    setQueue(queue);
    pushLog(`Scanned ${queue.length} institution candidate(s).`);
    queue.slice(0, 20).forEach((item, index) => pushLog(`#${index + 1}: ${item.name}`));
    if (queue.length > 20) pushLog(`...and ${queue.length - 20} more.`);
    return queue;
  }

  function getCurrentInstitutionName() {
    if (!isEditInstitutionPage()) return "";
    const refresh = getRefreshInformationButton();
    const root = getDetailRoot(refresh);
    const heading = Array.from((root || document).querySelectorAll?.("h1,h2,[role='heading']") || [])
      .find((node) => /Edit institution/i.test(textOf(node)));
    const body = textOf(root || document.body);
    const withoutHeading = body.replace(/.*Edit institution\s*/i, "");
    const firstLine = withoutHeading.split(/Updated\s+|Refresh information|Find accounts|Delete institution|Back/i)[0] || "";
    return firstLine.replace(/\s+/g, " ").trim().slice(0, 120) || textOf(heading);
  }

  function clickBack() {
    const button = getBackButton();
    return humanClick(button) ? describeNode(button) : "";
  }

  function clickRefreshInformation() {
    const button = getRefreshInformationButton();
    return humanClick(button) ? describeNode(button) : "";
  }

  function isBusyRefreshButton(node) {
    if (!node) return true;
    let current = node;
    for (let i = 0; i < 6 && current; i += 1) {
      const style = window.getComputedStyle(current);
      const className = String(current.className || "");
      if (!isEnabled(current)
        || current.matches?.(":disabled")
        || current.getAttribute?.("aria-busy") === "true"
        || current.getAttribute?.("data-loading") === "true"
        || current.getAttribute?.("loading") === "true"
        || /\b(disabled|loading|busy|spinner)\b/i.test(className)
        || style.pointerEvents === "none"
        || Number(style.opacity || 1) < 0.65) {
        return true;
      }
      current = current.parentElement || current.getRootNode?.().host;
    }
    return false;
  }

  async function waitForRefreshToFinish(name, maxWaitMs) {
    const timeoutMs = Math.max(Number(maxWaitMs || 30000), 8000);
    const start = Date.now();
    let sawBusy = false;
    let loggedBusy = false;

    await sleep(700);
    while (Date.now() - start < timeoutMs) {
      if (!isEditInstitutionPage()) return true;

      const button = getRefreshInformationButtonAnyState();
      const busy = isBusyRefreshButton(button);
      if (busy) {
        sawBusy = true;
        if (!loggedBusy) {
          loggedBusy = true;
          pushLog(`Refresh information is gray/busy. Waiting: ${name}.`);
        }
      } else if (sawBusy || Date.now() - start >= 1500) {
        pushLog(`Refresh information is available again: ${name}.`);
        return true;
      }

      await sleep(700);
    }

    pushLog(`Refresh wait timed out after ${Math.round(timeoutMs / 1000)}s: ${name}. Continuing.`);
    return false;
  }

  function clickClose() {
    const button = getCloseButton();
    return humanClick(button) ? describeNode(button) : "";
  }

  async function returnToInstitutionList(name, context) {
    const closeOk = clickClose();
    if (closeOk) {
      pushLog(`Clicked Close to return to list ${context}: ${name} via ${closeOk}`);
      await sleep(1500);
    } else {
      const backOk = clickBack();
      if (backOk) {
        pushLog(`Close not found. Clicked Back to return to list ${context}: ${name} via ${backOk}`);
        await sleep(1500);
      } else {
        pushLog(`Could not find Close or Back on ${name}.`);
        return false;
      }
    }

    let returned = await ensureEditAccountsPage();
    if (returned) return true;

    if (isEditInstitutionPage()) {
      const backOk = clickBack();
      if (backOk) {
        pushLog(`Still on detail page. Retried Back via ${backOk}.`);
        await sleep(1500);
        returned = await ensureEditAccountsPage();
      }
    }

    return returned;
  }

  async function waitForPage(predicate, timeoutMs = 20000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return true;
      await sleep(500);
    }
    return false;
  }

  async function openInstitutionAt(index) {
    const cards = getInstitutionCards();
    const item = cards[index];
    if (!item) return false;
    item.clickable.scrollIntoView({ block: "center", inline: "nearest" });
    await sleep(400);
    item.clickable.click();
    pushLog(`Opened: ${item.name || `institution #${index + 1}`}`);
    return true;
  }

  async function processQueue() {
    const state = getState();
    if (!state.active) return;

    if (isEditInstitutionPage()) {
      const name = getCurrentInstitutionName() || state.currentName || "institution";
      if (state.phase !== "refreshing" && state.phase !== "returning-list") {
        const ok = clickRefreshInformation();
        if (ok) {
          pushLog(`Clicked Refresh information: ${name} via ${ok}`);
          setState({ ...state, phase: "refreshing", currentName: name });
          await waitForRefreshToFinish(name, state.delayMs || 30000);
        } else {
          pushLog(`Could not find Refresh information on ${name}.`);
        }
      }

      setState({ ...getState(), phase: "returning-list" });
      const returned = await returnToInstitutionList(name, "after refresh");
      if (!returned) {
        pushLog("Could not return to the institution list. Stopping so you can inspect the page.");
        setState({ ...getState(), active: false, phase: "return-failed" });
        return;
      }
      setState({ ...getState(), phase: "returned-list", index: (state.index || 0) + 1 });
    }

    if (!isEditAccountsPage() && getBackButton()) {
      pushLog("On an institution detail page. Returning to list before continuing.");
      const returned = await returnToInstitutionList(getState().currentName || "institution", "before continuing");
      if (!returned) {
        pushLog("Could not return to the institution list. Stopping to avoid bad clicks.");
        setState({ ...getState(), active: false, phase: "return-failed" });
        return;
      }
    }

    const onList = await ensureEditAccountsPage();
    if (!onList) {
      pushLog("Could not open Edit accounts. Click Edit/Link Accounts manually, then run again.");
      setState({ ...getState(), active: false, phase: "not-on-list" });
      return;
    }

    let nextState = getState();
    let queue = getQueue();
    if (queue.length === 0) queue = scanInstitutions();

    const maxItems = Number(nextState.maxItems || 100);
    const index = Number(nextState.index || 0);
    if (index >= queue.length || index >= maxItems) {
      pushLog(`Done. Processed ${Math.min(index, queue.length)} of ${queue.length} institution candidate(s).`);
      setState({ ...nextState, active: false, phase: "done" });
      return;
    }

    if (abortRequested) {
      pushLog("Stopped by user.");
      setState({ ...nextState, active: false, phase: "stopped" });
      return;
    }

    const opened = await openInstitutionAt(index);
    if (!opened) {
      pushLog(`Could not open institution #${index + 1}. Skipping.`);
      setState({ ...nextState, index: index + 1, phase: "skip-open-failed" });
      setTimeout(() => processQueue().catch((error) => pushLog(`Error: ${error.message}`)), 800);
      return;
    }

    nextState = getState();
    setState({ ...nextState, phase: "opening-institution", currentName: queue[index]?.name || `Institution ${index + 1}` });
    const detailReady = await waitForPage(isEditInstitutionPage, 20000);
    if (!detailReady) {
      pushLog(`Institution #${index + 1} did not open to a refresh page. Skipping after returning if possible.`);
      clickBack();
      setState({ ...getState(), index: index + 1, phase: "skip-no-refresh-page" });
      setTimeout(() => processQueue().catch((error) => pushLog(`Error: ${error.message}`)), 1600);
      return;
    }

    setTimeout(() => processQueue().catch((error) => {
      pushLog(`Error: ${error.message}`);
      setState({ ...getState(), active: false, phase: "error" });
    }), 1600);
  }

  function startRun() {
    abortRequested = false;
    let queue = getQueue();
    if (!isEditAccountsPage()) {
      setQueue([]);
      queue = [];
    }
    if (queue.length === 0 && isEditAccountsPage()) queue = scanInstitutions();

    setState({
      active: true,
      phase: "starting",
      index: 0,
      delayMs: Number(panel.querySelector("[data-delay]").value || 30000),
      maxItems: Number(panel.querySelector("[data-max]").value || 100),
      startedAt: Date.now()
    });
    pushLog(`Starting Fidelity Full View refresh run v${VERSION}.`);
    processQueue().catch((error) => {
      pushLog(`Error: ${error.message}`);
      setState({ ...getState(), active: false, phase: "error" });
    });
  }

  function stopRun() {
    abortRequested = true;
    setState({ ...getState(), active: false, phase: "stopped" });
    pushLog("Stop requested.");
  }

  function debugScan() {
    pushLog(`Debug: page="${pageLabel()}", editAccounts=${isEditAccountsPage()}, editInstitution=${isEditInstitutionPage()}`);
    pushLog(`Debug: found ${getInstitutionCards().length} institution candidate(s), refreshButton=${Boolean(getRefreshInformationButton())}, backButton=${Boolean(getBackButton())}`);
  }

  function scheduleRender(force = false) {
    if (!panel) return;
    if (force) {
      render();
      return;
    }
    if (renderQueued) return;
    renderQueued = true;
    window.setTimeout(() => {
      renderQueued = false;
      render();
    }, 250);
  }

  function makePanel() {
    const el = document.createElement("div");
    el.id = "fidelity-full-view-refresher";
    el.innerHTML = `
      <style>
        #fidelity-full-view-refresher {
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
        #fidelity-full-view-refresher header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          padding: 10px 12px;
          border-bottom: 1px solid #e5e7eb;
          font-weight: 700;
        }
        #fidelity-full-view-refresher main { padding: 10px 12px; }
        #fidelity-full-view-refresher button {
          margin: 4px 4px 4px 0;
          padding: 7px 10px;
          border: 1px solid #2e7d32;
          border-radius: 6px;
          background: #2e7d32;
          color: white;
          cursor: pointer;
          font-size: 12px;
        }
        #fidelity-full-view-refresher button.secondary {
          background: #fff;
          color: #2e7d32;
        }
        #fidelity-full-view-refresher button.danger {
          border-color: #b91c1c;
          background: #b91c1c;
        }
        #fidelity-full-view-refresher label {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          margin-right: 8px;
        }
        #fidelity-full-view-refresher input {
          width: 72px;
          padding: 5px;
          border: 1px solid #cbd5e1;
          border-radius: 5px;
        }
        #fidelity-full-view-refresher .status {
          margin: 8px 0;
          padding: 8px;
          border-radius: 6px;
          background: #f8fafc;
          border: 1px solid #e5e7eb;
          line-height: 1.35;
        }
        #fidelity-full-view-refresher .logs {
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
        <span>Fidelity Full View</span>
        <button type="button" class="secondary" data-hide>Hide</button>
      </header>
      <main>
        <div>
          <label>Max wait <input data-delay type="number" min="8000" step="1000" value="30000"> ms</label>
          <label>Max <input data-max type="number" min="1" step="1" value="100"></label>
        </div>
        <div>
          <button type="button" data-scan>Scan Institutions</button>
          <button type="button" data-start>Refresh All</button>
          <button type="button" data-stop class="danger">Stop</button>
          <button type="button" data-debug class="secondary">Debug Scan</button>
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
      scanInstitutions();
    });
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
      debugScan();
    });
    el.querySelector("[data-clear]").addEventListener("click", clearLogs);
    el.querySelector("[data-hide]").addEventListener("click", () => {
      el.style.display = "none";
      const tab = document.createElement("button");
      tab.textContent = "Full View";
      tab.style.cssText = "position:fixed;right:18px;top:92px;z-index:2147483647;padding:8px 10px;border-radius:6px;border:1px solid #2e7d32;background:#2e7d32;color:#fff;cursor:pointer";
      tab.addEventListener("click", () => {
        tab.remove();
        el.style.display = "block";
      });
      document.body.appendChild(tab);
    });

    return el;
  }

  function render() {
    if (!panel) return;
    const state = getState();
    const queue = getQueue();
    const logs = getLogs();
    const index = Number(state.index || 0);

    panel.querySelector("[data-status]").innerHTML = `
      <div><b>Status:</b> ${state.active ? "running" : (state.phase || "idle")}</div>
      <div><b>Version:</b> ${VERSION}</div>
      <div><b>Page:</b> ${pageLabel()}</div>
      <div><b>Queue:</b> ${queue.length ? `${Math.min(index + 1, queue.length)}/${queue.length}` : "not scanned"}</div>
      <div><b>Current:</b> ${state.currentName || "-"}</div>
    `;

    const logBox = panel.querySelector("[data-logs]");
    const nextLogText = logs.join("\n");
    if (logBox.textContent !== nextLogText) {
      logBox.textContent = nextLogText;
      logBox.scrollTop = logBox.scrollHeight;
    }
  }

  function boot() {
    if (document.getElementById("fidelity-full-view-refresher")) return;
    panel = makePanel();
    render();
    setInterval(() => scheduleRender(false), 5000);

    const state = getState();
    if (state.active) {
      pushLog("Resuming saved run after navigation.");
      setTimeout(() => processQueue().catch((error) => {
        pushLog(`Error: ${error.message}`);
        setState({ ...getState(), active: false, phase: "error" });
      }), 2500);
    }
  }

  boot();
})();