// popup.js

// Inline SVG icons (no external icon library -- MV3 popups can't load
// remote resources). Presentational only, swapped into the same template
// strings that already existed; no change to logic, events, or data.
const WARNING_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const CHECK_ICON_SVG = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
const TRASH_ICON_SVG = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`;
const SPINNER_ICON_SVG = `<svg class="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 11-9-9"/></svg>`;

// The Gemini-generated summary text is inserted into innerHTML below --
// escape it first. It's LLM output derived from a scraped web page's text,
// not a trusted app-controlled string, so treat it like any other untrusted
// external content.
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// Same convention-based keywords content.js uses for its own pre-filter --
// duplicated here (rather than shared) since popup.js can't import from a
// content script module, and this is only ~10 lines.
const JOB_URL_HINTS = [
  "career", "job", "apply", "application", "internship",
  "vacanc", "position", "recruit", "hiring", "opportunit", "join-us",
];

// Sites the manifest doesn't already cover (an unlisted ATS, a company's own
// oddly-named careers page, etc.) can still be enabled here -- no hardcoded
// site list, just a URL/title heuristic to decide whether it's worth asking.
function looksLikeJobUrl(urlStr, title) {
  let hostname = "";
  try {
    hostname = new URL(urlStr).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (hostname.startsWith("jobs.") || hostname.startsWith("careers.")) return true;

  const haystack = (urlStr + " " + (title || "")).toLowerCase();
  return JOB_URL_HINTS.some((hint) => haystack.includes(hint));
}

function originPatternFor(urlStr) {
  const url = new URL(urlStr);
  return `${url.protocol}//${url.hostname}/*`;
}

async function initCandidateBanner() {
  const banner = document.getElementById("candidate-banner");
  const bannerText = document.getElementById("candidate-banner-text");
  const enableBtn = document.getElementById("enable-detection-btn");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^https?:\/\//.test(tab.url)) return;

  if (!looksLikeJobUrl(tab.url, tab.title)) return;

  const originPattern = originPatternFor(tab.url);
  const alreadyGranted = await chrome.permissions.contains({ origins: [originPattern] });
  if (alreadyGranted) return; // already covered, either statically or previously approved

  const hostname = new URL(tab.url).hostname;
  bannerText.textContent = `This looks like it might be a job page on ${hostname} that detection isn't enabled for yet.`;
  banner.style.display = "block";

  enableBtn.addEventListener("click", async () => {
    enableBtn.disabled = true;
    const granted = await chrome.permissions.request({ origins: [originPattern] });

    if (!granted) {
      bannerText.textContent = "Permission was denied. You can try again anytime from this popup.";
      enableBtn.disabled = false;
      return;
    }

    await chrome.runtime.sendMessage({ type: "REGISTER_DYNAMIC_ORIGIN", originPattern });
    bannerText.textContent = `Enabled for ${hostname}. Reloading the page...`;
    chrome.tabs.reload(tab.id);
  });
}

async function renderCurrentPageFlags() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const container = document.getElementById("current-page-flags");

  if (!tab || !tab.url) {
    container.innerHTML = `<div class="empty-state">No active tab detected.</div>`;
    return;
  }

  const { flaggedPages = {} } = await chrome.storage.local.get("flaggedPages");
  const entry = flaggedPages[tab.url];

  if (!entry || entry.flags.length === 0) {
    container.innerHTML = `<div class="no-flags">${CHECK_ICON_SVG}No red flags detected on this page.</div>`;
    return;
  }

  const items = entry.flags
    .map((flag) => `<div class="flag-item">${WARNING_ICON_SVG}<span>${flag}</span></div>`)
    .join("");
  container.innerHTML = `<div class="flag-box">${items}</div>`;
}

// ---------- AI summary ----------

function renderSummaryLoading(content) {
  content.innerHTML = `<div class="summary-loading">${SPINNER_ICON_SVG}<span>Summarizing...</span></div>`;
}

function renderSummaryText(content, summaryText) {
  content.innerHTML = `<div class="summary-text">${escapeHtml(summaryText)}</div>`;
}

function renderSummaryError(content, onRetry) {
  content.innerHTML = `<div class="summary-error">${WARNING_ICON_SVG}<span>Summary unavailable</span><button class="summary-retry-btn">Retry</button></div>`;
  content.querySelector(".summary-retry-btn").addEventListener("click", onRetry);
}

async function initSummary() {
  const section = document.getElementById("summary-section");
  const content = document.getElementById("summary-content");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  const { flaggedPages = {} } = await chrome.storage.local.get("flaggedPages");
  const pageEntry = flaggedPages[tab.url];

  // No entry means content.js never recognized this as a job page (or
  // hasn't reported back yet) -- nothing to summarize, so the whole section
  // stays hidden rather than showing an empty/broken state.
  if (!pageEntry) return;

  section.style.display = "block";

  // Client-side cache first -- avoids hitting the network (and re-asking
  // the Flask-side cache) at all when reopening the popup on a URL already
  // summarized this session.
  const { summaryCache = {} } = await chrome.storage.local.get("summaryCache");
  const cached = summaryCache[tab.url];

  if (cached) {
    renderSummaryText(content, cached.summary);
    return;
  }

  renderSummaryLoading(content);

  const result = await chrome.runtime.sendMessage({ type: "SUMMARIZE_PAGE", url: tab.url });

  if (!result || !result.ok) {
    renderSummaryError(content, initSummary);
    return;
  }

  const { summaryCache: current = {} } = await chrome.storage.local.get("summaryCache");
  current[tab.url] = { summary: result.summary, cachedAt: Date.now() };
  await chrome.storage.local.set({ summaryCache: current });

  renderSummaryText(content, result.summary);
}

const STATUS_OPTIONS = ["Applied", "Interview", "Offer", "Rejected"];

function statusOptionsHtml(current) {
  return STATUS_OPTIONS.map(
    (s) => `<option value="${s}" ${s === current ? "selected" : ""}>${s}</option>`
  ).join("");
}

async function renderApplications() {
  const container = document.getElementById("applications-list");
  const { applications = [] } = await chrome.storage.local.get("applications");

  if (applications.length === 0) {
    container.innerHTML = `<div class="empty-state">No applications tracked yet. When you submit one, you'll get a notification asking to add it.</div>`;
    return;
  }

  const sorted = [...applications].sort((a, b) => b.appliedAt - a.appliedAt);

  container.innerHTML = sorted
    .map((app, index) => {
      const date = new Date(app.appliedAt).toLocaleDateString();
      const addedNote = app.source === "manual" ? " \u2022 added manually" : "";
      const synced = Boolean(app.apiId);

      return `
        <div class="app-row">
          <div class="app-row-top">
            <div class="app-title">${app.title || app.url}</div>
            <button class="remove-btn" data-index="${index}">${TRASH_ICON_SVG}<span>Remove</span></button>
          </div>
          <div class="app-status">${date}${addedNote}</div>
          <div class="app-controls">
            <select class="status-select" data-url="${app.url}" ${synced ? "" : "disabled"}>
              ${statusOptionsHtml(app.status)}
            </select>
            <input
              type="text"
              class="notes-input"
              data-url="${app.url}"
              placeholder="${synced ? "Notes..." : "Sign in via Settings to add notes"}"
              value="${app.notes || ""}"
              ${synced ? "" : "disabled"}
            />
          </div>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      const idx = parseInt(e.target.getAttribute("data-index"), 10);
      const { applications: current = [] } = await chrome.storage.local.get("applications");
      const sortedCurrent = [...current].sort((a, b) => b.appliedAt - a.appliedAt);
      const toRemove = sortedCurrent[idx];
      const updated = current.filter((a) => a !== toRemove);
      await chrome.storage.local.set({ applications: updated });
      renderApplications();
    });
  });

  container.querySelectorAll(".status-select").forEach((select) => {
    select.addEventListener("change", async () => {
      await chrome.runtime.sendMessage({
        type: "UPDATE_APPLICATION",
        url: select.dataset.url,
        changes: { status: select.value },
      });
      renderApplications();
    });
  });

  container.querySelectorAll(".notes-input").forEach((input) => {
    input.addEventListener("blur", async () => {
      await chrome.runtime.sendMessage({
        type: "UPDATE_APPLICATION",
        url: input.dataset.url,
        changes: { notes: input.value },
      });
    });
  });
}

initCandidateBanner();
renderCurrentPageFlags();
initSummary();
renderApplications();

// Manual fallback: works on ANY page, regardless of whether auto-detection
// caught it. This is the safety net for arbitrary company career sites
// where the confirmation-text patterns might not match.
document.getElementById("manual-track-btn").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  const result = await chrome.runtime.sendMessage({
    type: "TRACK_APPLICATION",
    url: tab.url,
    title: tab.title || tab.url,
    source: "manual",
  });

  if (result && result.alreadyTracked) {
    alert("This page is already in your tracker.");
    return;
  }

  renderApplications();
});

document.getElementById("open-options-btn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
