// popup.js

// Inline SVG icons (no external icon library -- MV3 popups can't load
// remote resources). Presentational only, swapped into the same template
// strings that already existed; no change to logic, events, or data.
const WARNING_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;
const CHECK_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
const TRASH_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`;
const SPINNER_ICON_SVG = `<svg class="spinner" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M21 12a9 9 0 11-9-9"/></svg>`;
const PAGE_EMPTY_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9h18"/><path d="M7 6.5h.01"/></svg>`;
const APPLICATIONS_EMPTY_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>`;

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
    container.innerHTML = `<div class="empty-state">${PAGE_EMPTY_ICON_SVG}<span class="empty-state-copy">No active tab detected.</span></div>`;
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

  // AI succeeded and returned its own flags analysis -- this supersedes the
  // regex-only flags renderCurrentPageFlags() already showed on popup-open
  // (the AI can reason about context, e.g. not flagging an incidental
  // "unpaid leave" mention when a real salary is also stated). Persist it so
  // the next popup open -- and the tracked-application sync in
  // background.js, which reads flaggedPages[url].flags -- also reflect the
  // AI-derived flags, not the stale regex-only ones. If the AI call had
  // failed instead, we return early above and never reach here, so the
  // regex-based flags already on screen simply remain the final answer.
  if (Array.isArray(result.flags)) {
    const { flaggedPages: currentFlagged = {} } = await chrome.storage.local.get("flaggedPages");
    if (currentFlagged[tab.url]) {
      currentFlagged[tab.url] = { ...currentFlagged[tab.url], flags: result.flags };
      await chrome.storage.local.set({ flaggedPages: currentFlagged });
    }
    renderCurrentPageFlags();
  }
}

// ---------- Application Priority ----------

const PRIORITY_LABEL_CLASS = {
  "Low Priority": "priority-badge-low",
  "Worth Applying": "priority-badge-worth",
  "Strong Match": "priority-badge-strong",
  "Top Priority": "priority-badge-top",
};
const EMPLOYER_SCORING_CACHE_VERSION = 2;

function suitabilityRowHtml(state) {
  if (state.status === "loading") {
    return `<div class="priority-row"><span class="priority-row-label">Suitability</span><span class="priority-row-value">${SPINNER_ICON_SVG}</span></div>`;
  }
  if (state.status === "no-background") {
    return `<div class="priority-row"><span class="priority-row-label">Suitability</span><span class="priority-note">Add background in Settings</span></div>`;
  }
  if (state.status === "error") {
    return `<div class="priority-row"><span class="priority-row-label">Suitability</span><span class="priority-note">Unavailable</span></div>`;
  }
  return `<div class="priority-row"><span class="priority-row-label">Suitability</span><span class="priority-row-value">${state.score.toFixed(1)}/10</span></div>`;
}

function competitivenessRowHtml(state) {
  if (state.status === "loading") {
    return `<div class="priority-row"><span class="priority-row-label">Competitiveness</span><span class="priority-row-value">${SPINNER_ICON_SVG}</span></div>`;
  }
  if (state.status === "error") {
    return `<div class="priority-row"><span class="priority-row-label">Competitiveness</span><span class="priority-note">Unavailable</span></div>`;
  }
  // Never claim a live lookup unless the backend actually confirmed the
  // grounded call succeeded (see api.py's _fetch_competitiveness_from_gemini)
  // -- an ungrounded guess must always read as an estimate, not research.
  const groundedNote = state.grounded ? "verified via search" : "estimate";
  return `<div class="priority-row"><span class="priority-row-label">Competitiveness</span><span class="priority-row-value">${state.score.toFixed(1)}/10<span class="priority-note">(${groundedNote})</span></span></div>`;
}

function priorityLabelRowHtml(label) {
  if (!label) return "";
  const cls = PRIORITY_LABEL_CLASS[label] || "priority-badge-worth";
  return `<div class="priority-row priority-label-row"><span class="priority-label-badge ${cls}">${escapeHtml(label)}</span></div>`;
}

function renderPriority(content, suitabilityState, competitivenessState, priorityLabel) {
  content.innerHTML =
    suitabilityRowHtml(suitabilityState) +
    competitivenessRowHtml(competitivenessState) +
    priorityLabelRowHtml(priorityLabel);
}

async function initPriority() {
  const section = document.getElementById("priority-section");
  const content = document.getElementById("priority-content");

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url) return;

  const { flaggedPages = {} } = await chrome.storage.local.get("flaggedPages");
  const pageEntry = flaggedPages[tab.url];

  // Same precondition as initSummary() -- nothing to score until content.js
  // has reported page text for this URL.
  if (!pageEntry) return;

  section.style.display = "block";

  const { priorityCache = {} } = await chrome.storage.local.get("priorityCache");
  const cached = priorityCache[tab.url];

  if (cached?.cache_version === EMPLOYER_SCORING_CACHE_VERSION) {
    renderPriority(
      content,
      cached.suitability_score != null
        ? { status: "ready", score: cached.suitability_score }
        : { status: cached.suitability_status || "error" },
      cached.competitiveness_score != null
        ? { status: "ready", score: cached.competitiveness_score, grounded: cached.grounded }
        : { status: "error" },
      cached.priority_label
    );
    return;
  }

  renderPriority(content, { status: "loading" }, { status: "loading" }, null);

  // The existing suitability call also extracts the real hiring organisation
  // from page text when structured markup/selectors could not. Wait for that
  // result only when content.js did not already find the employer; this keeps
  // common boards concurrent while preventing their domain from being scored.
  const suitabilityPromise = chrome.runtime.sendMessage({ type: "SCORE_SUITABILITY", url: tab.url });
  let competitivenessPromise;
  if (pageEntry.employerName) {
    competitivenessPromise = chrome.runtime.sendMessage({
      type: "SCORE_COMPETITIVENESS",
      url: tab.url,
      employer_name: pageEntry.employerName,
    });
  }

  const suitabilityResult = await suitabilityPromise;
  if (!competitivenessPromise) {
    competitivenessPromise = chrome.runtime.sendMessage({
      type: "SCORE_COMPETITIVENESS",
      url: tab.url,
      employer_name: suitabilityResult?.employer_name || null,
    });
  }
  const competitivenessResult = await competitivenessPromise;

  let suitabilityState;
  if (suitabilityResult && suitabilityResult.ok) {
    suitabilityState = suitabilityResult.suitability_score != null
      ? { status: "ready", score: suitabilityResult.suitability_score }
      : { status: "no-background" };
  } else {
    suitabilityState = { status: "error" };
  }

  let competitivenessState;
  if (competitivenessResult && competitivenessResult.ok) {
    competitivenessState = {
      status: "ready",
      score: competitivenessResult.competitiveness_score,
      grounded: competitivenessResult.grounded,
    };
  } else {
    competitivenessState = { status: "error" };
  }

  let priorityLabel = null;
  if (suitabilityState.status === "ready" && competitivenessState.status === "ready") {
    const priorityResult = await chrome.runtime.sendMessage({
      type: "COMPUTE_PRIORITY",
      suitability_score: suitabilityState.score,
      competitiveness_score: competitivenessState.score,
    });
    if (priorityResult && priorityResult.ok) {
      priorityLabel = priorityResult.priority_label;
    }
  }

  renderPriority(content, suitabilityState, competitivenessState, priorityLabel);

  const { priorityCache: currentCache = {} } = await chrome.storage.local.get("priorityCache");
  currentCache[tab.url] = {
    cache_version: EMPLOYER_SCORING_CACHE_VERSION,
    suitability_score: suitabilityState.status === "ready" ? suitabilityState.score : null,
    suitability_status: suitabilityState.status,
    competitiveness_score: competitivenessState.status === "ready" ? competitivenessState.score : null,
    company_name: competitivenessResult?.company_name || suitabilityResult?.employer_name || pageEntry.employerName || null,
    grounded: competitivenessState.grounded || false,
    priority_label: priorityLabel,
    cachedAt: Date.now(),
  };
  await chrome.storage.local.set({ priorityCache: currentCache });
}

const STATUS_OPTIONS = ["Applied", "Interview", "Offer", "Rejected"];
const DASHBOARD_URL = "https://application-tracker-ocop.onrender.com/dashboard";
const RECENT_WINDOW_MS = 60 * 60 * 1000; // 1 hour

function statusOptionsHtml(current) {
  return STATUS_OPTIONS.map(
    (s) => `<option value="${s}" ${s === current ? "selected" : ""}>${s}</option>`
  ).join("");
}

// Display-filter only -- storage/sync are untouched. Full history always
// lives in chrome.storage.local (and synced to the backend) regardless of
// what the popup chooses to show; this just narrows what's rendered here.
// Both renderApplications() and its remove-button handler call this with
// the same freshly-read list so index-based lookups stay in sync with each
// other even as items age out of the window between renders.
function getRecentApplications(applications) {
  return applications
    .filter((app) => Date.now() - app.appliedAt <= RECENT_WINDOW_MS)
    .sort((a, b) => b.appliedAt - a.appliedAt);
}

async function renderApplications() {
  const container = document.getElementById("applications-list");
  const { applications = [] } = await chrome.storage.local.get("applications");

  if (applications.length === 0) {
    container.innerHTML = `<div class="empty-state">${APPLICATIONS_EMPTY_ICON_SVG}<span class="empty-state-copy">No applications tracked yet. When you submit one, you'll get a notification asking to add it.</span></div>`;
    return;
  }

  const recent = getRecentApplications(applications);

  if (recent.length === 0) {
    container.innerHTML = `<div class="empty-state">${APPLICATIONS_EMPTY_ICON_SVG}<span class="empty-state-copy">No recent activity. View all applications on your dashboard →</span></div>`;
    return;
  }

  container.innerHTML = recent
    .map((app, index) => {
      const date = new Date(app.appliedAt).toLocaleDateString();
      const addedNote = app.source === "manual" ? " \u2022 added manually" : "";
      const synced = Boolean(app.apiId);

      return `
        <div class="app-row">
          <div class="app-row-top">
            <div class="app-title">${app.title || app.url}</div>
            <button class="remove-btn" data-index="${index}" aria-label="Remove application" title="Remove application">${TRASH_ICON_SVG}<span>Remove</span></button>
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
      const recentCurrent = getRecentApplications(current);
      const toRemove = recentCurrent[idx];
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
initPriority();
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

document.getElementById("viewAllApplicationsBtn").addEventListener("click", () => {
  chrome.tabs.create({ url: DASHBOARD_URL });
});
