// ===== Logging =====
function log(msg) {
  const el = document.getElementById("log");
  el.value += msg + "\n";
  el.scrollTop = el.scrollHeight;
}

// ===== Storage (JSON-first) =====
const STORAGE_KEY = "chatgpt_csv_runner_results_json";
async function loadResults() {
  const data = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] || [];
  return data;
}
async function saveResultJSON(entry) {
  const data = await loadResults();
  data.push(entry);
  await chrome.storage.local.set({ [STORAGE_KEY]: data });
}
async function clearResults() { await chrome.storage.local.set({ [STORAGE_KEY]: [] }); }
function toCSV(rows) {
  const esc = (s) => {
    const t = (s ?? "").toString();
    if (/[",\n]/.test(t)) return `"${t.replace(/"/g, '""')}"`;
    return t;
  };
  const header = ["question","answer","timestamp"];
  const lines = [header.join(",")];
  for (const r of rows) lines.push([esc(r.question), esc(r.answer), esc(r.timestamp)].join(","));
  return lines.join("\n");
}
function download(filename, content, type = "text/plain") {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ===== Tab helpers =====
async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function isOnChatGPT() {
  const tab = await getActiveTab();
  if (!tab) return false;
  try {
    const url = new URL(tab.url || "about:blank");
    // Accept both current domains OpenAI uses
    return /^(chat\.openai\.com|chatgpt\.com)$/.test(url.hostname);
  } catch {
    return false;
  }
}

async function openChatGPTIfNeeded() {
  const on = await isOnChatGPT();
  if (on) return;
  const tab = await getActiveTab();
  if (tab?.id) {
    await chrome.tabs.update(tab.id, { url: "https://chat.openai.com/" });
  }
}

// ===== Injected: robust DOM submit + wait-for-completion for ChatGPT =====
function domSubmitAndWaitComplete(q, selectors) {
  const {
    inputCandidates,
    submitCandidates,
    formCandidates,
    messagesContainerSel,
    assistantMsgCandidates,
    streamingClass,
    finalizeDelayMs
  } = selectors;

  function visible(el) { return !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length)); }

  function queryAllDeep(selector) {
    const out = [];
    const walker = (root) => {
      const nodes = root.querySelectorAll(selector);
      nodes.forEach(n => out.push(n));
      const tree = root.querySelectorAll("*");
      tree.forEach(n => { if (n.shadowRoot) walker(n.shadowRoot); });
    };
    walker(document);
    return out;
  }

  function findFirstVisible(selectors) {
    for (const sel of selectors) {
      const list = queryAllDeep(sel);
      for (const el of list) if (visible(el)) return el;
    }
    for (const sel of selectors) {
      const list = queryAllDeep(sel);
      if (list.length) return list[0];
    }
    return null;
  }

  function getLastAssistantMessage() {
    const container = document.querySelector(messagesContainerSel) || document;
    for (const sel of assistantMsgCandidates) {
      const list = container.querySelectorAll(sel);
      if (list && list.length) return list[list.length - 1];
    }
    return null;
  }

  function waitForStreamingToFinish(timeoutMs = 180000) {
    return new Promise((resolve) => {
      const start = Date.now();
      let lastText = "";
      let stableTimer = null;
      const targetGetter = () => getLastAssistantMessage();

      const observer = new MutationObserver(() => {
        const el = targetGetter();
        if (!el) return;
        if (streamingClass && el.closest(`.${streamingClass}`)) return;
        const t = el.innerText || "";
        if (t !== lastText) {
          lastText = t;
          if (stableTimer) { clearTimeout(stableTimer); stableTimer = null; }
          // Slightly longer stabilization for ChatGPT cadence
          stableTimer = setTimeout(() => { observer.disconnect(); resolve(el); }, finalizeDelayMs || 1800);
        }
      });

      lastText = (targetGetter()?.innerText || "");
      observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });

      const timer = setInterval(() => {
        if (Date.now() - start > timeoutMs) {
          observer.disconnect();
          if (stableTimer) clearTimeout(stableTimer);
          resolve(targetGetter());
          clearInterval(timer);
        }
      }, 800);
    });
  }

  function setCaretAtEnd(el) {
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
  }

  function setInputValue(input, value) {
    if (!input) return;
    input.focus();
    if (input.scrollIntoView) input.scrollIntoView({ behavior: "smooth", block: "center" });

    const isCE = input.getAttribute("contenteditable") === "true";
    if (isCE) {
      input.textContent = "";
      input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "deleteContentBackward" }));
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: "", inputType: "deleteContentBackward" }));
      input.textContent = value;
      setCaretAtEnd(input);
      input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, data: value, inputType: "insertText" }));
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: value, inputType: "insertText" }));
      try { document.execCommand && document.execCommand("insertText", false, ""); } catch {}
    } else {
      const proto = input.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      if (setter) setter.call(input, value); else input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }

  function tryClickSubmit() {
    const btn = findFirstVisible(submitCandidates);
    if (!btn) return false;
    const rect = btn.getBoundingClientRect();
    const x = rect.left + Math.min(8, rect.width / 2);
    const y = rect.top + Math.min(8, rect.height / 2);
    btn.focus();
    btn.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    btn.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: x, clientY: y, button: 0 }));
    btn.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, clientX: x, clientY: y, pointerId: 1, pointerType: "mouse", isPrimary: true }));
    btn.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: x, clientY: y, button: 0 }));
    btn.click();
    return true;
  }

  function trySubmitForm(input) {
    const form = input?.closest("form") || findFirstVisible(formCandidates);
    if (form) {
      if (typeof form.requestSubmit === "function") { form.requestSubmit(); return true; }
      if (typeof form.submit === "function") { form.submit(); return true; }
      const ok = form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      return ok;
    }
    return false;
  }

  function sendKeys(input) {
    // For ChatGPT, Enter submits; Shift+Enter inserts newline
    const enter = (opts) => {
      input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...opts }));
      input.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true, cancelable: true, ...opts }));
      input.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, cancelable: true, ...opts }));
    };
    input.dispatchEvent(new InputEvent("beforeinput", { bubbles: true, inputType: "insertParagraph" }));
    enter({ key: "Enter", code: "Enter" });
    setTimeout(() => enter({ key: "Enter", code: "Enter", ctrlKey: true }), 30);
    setTimeout(() => enter({ key: "Enter", code: "Enter", metaKey: true }), 60);
  }

  async function strongDomSubmit() {
    const input = findFirstVisible(inputCandidates);
    if (!input) return { ok: false, reason: "input_not_found" };
    setInputValue(input, q);

    if (tryClickSubmit()) return { ok: true, via: "button" };
    if (trySubmitForm(input)) return { ok: true, via: "form" };
    sendKeys(input);
    setTimeout(() => { tryClickSubmit(); }, 80);
    return { ok: true, via: "keyboard" };
  }

  return strongDomSubmit().then(async (res) => {
    if (!res.ok) return res;
    const el = await waitForStreamingToFinish(180000);
    const answerText = el?.innerText?.trim() || "";
    return { ok: true, answer: answerText };
  });
}

// ===== UI + CSV parsing =====
let rows = [];
let index = 0;
let stopped = false;

function parseCSV(text) {
  const lines = text.split(/\r?\n/).filter(l => l.trim().length);
  if (!lines.length) return [];
  const headers = lines[0].split(",").map(h => h.trim());
  return lines.slice(1).map(line => {
    const cols = line.split(",");
    const obj = {};
    headers.forEach((h, i) => obj[h] = (cols[i] ?? "").trim());
    return obj;
  });
}

const fileEl = document.getElementById('csvFile');
fileEl.addEventListener('click', (e) => { e.target.value = null; });
fileEl.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    rows = parseCSV(text);
    log(`Loaded ${rows.length} rows.`);
  } catch (err) {
    log("Error reading file: " + String(err));
  }
});

document.getElementById("openChatGPT").addEventListener("click", async () => {
  await openChatGPTIfNeeded();
  log("ChatGPT opened or already open.");
});

document.getElementById("start").addEventListener("click", async () => {
  if (!rows.length) { log("No CSV loaded."); return; }
  stopped = false;

  const delay = parseInt(document.getElementById("delay").value || "800", 10);
  const colInput = document.getElementById("column").value.trim();

  let getQ = (r) => r?.question ?? "";
  if (colInput) {
    const asIdx = parseInt(colInput, 10);
    if (!Number.isNaN(asIdx)) {
      getQ = (r) => { const arr = Object.values(r); return (arr[asIdx] ?? "").toString(); };
    } else {
      getQ = (r) => (r?.[colInput] ?? "").toString();
    }
  }

  // Do NOT navigate here; only verify we’re already on ChatGPT
  const on = await isOnChatGPT();
  if (!on) {
    log("Please click Open ChatGPT first to load the site, then Start.");
    return;
  }

  const selectors = {
    inputCandidates: [
      'div[contenteditable="true"][role="textbox"][aria-multiline="true"]',
      'div[contenteditable="true"][role="textbox"]',
      'div[contenteditable="true"]',
      'textarea[aria-label*="message"]',
      '[role="textbox"][contenteditable="true"]'
    ],
    submitCandidates: [
      'button[aria-label*="Send"]',
      'button[aria-label*="submit"]',
      'button:has(svg[aria-hidden])',
      'form button[type="submit"]'
    ],
    formCandidates: ["form[action]", "form"],
    messagesContainerSel: 'main, [data-testid*="conversation"], body',
    assistantMsgCandidates: [
      'article:has([data-message-author-role]:not([data-message-author-role="user"]))',
      '[data-message-author-role="assistant"]',
      'article'
    ],
    streamingClass: "",
    finalizeDelayMs: 1800
  };

  for (; index < rows.length; index++) {
    if (stopped) break;
    const q = (getQ(rows[index]) || "").trim();
    if (!q) { log(`Row ${index + 1}: empty question, skipping.`); continue; }

    log(`Submitting (same session): ${q}`);
    const tab = await getActiveTab();
    if (!tab?.id) { log("No active tab."); break; }

    // Let previous UI settle
    await new Promise(r => setTimeout(r, 2000));

    let result = null;
    try {
      const injectionResults = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: domSubmitAndWaitComplete,
        args: [q, selectors],
        world: "MAIN"
      });
      const first = Array.isArray(injectionResults) ? injectionResults[0] : undefined;
      result = first?.result ?? null;
    } catch (e) {
      log("Injection error: " + String(e));
      result = { ok: false, reason: String(e) };
    }

    let answer = "";
    if (result?.ok) {
      answer = result.answer || "";
      const preview = answer.length > 160 ? answer.slice(0, 160) + "..." : answer;
      log(`Answer finalized (${answer.length} chars): ${preview}`);
    } else {
      log(`Answer capture failed: ${result?.reason || "unknown"}`);
    }

    await saveResultJSON({ question: q, answer, timestamp: new Date().toISOString() });

    // Pause before next iteration
    await new Promise(r => setTimeout(r, delay));
  }

  log("Done (same session).");
});

document.getElementById("stop").addEventListener("click", () => { stopped = true; log("Stopped."); });

document.getElementById("exportCSV").addEventListener("click", () => {
  loadResults().then(data => {
    download("chatgpt_results.csv", toCSV(data), "text/csv");
  });
});

document.getElementById("exportJSON").addEventListener("click", () => {
  loadResults().then(data => {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    chrome.downloads.download({
      url,
      filename: "chatgpt_results.json"
    });
  });
});

document.getElementById("clearResults").addEventListener("click", async () => {
  await clearResults();
  log("Results cleared.");
});
