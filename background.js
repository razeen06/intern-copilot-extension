// background.js
// The extension's central "brain" - content scripts can't store data
// directly in a reliable shared way, so they send messages here instead.
importScripts("employer-extraction.js");

// Base URL of the Flask Application Tracker API -- the deployed production
// app. Update this if it ever moves to a different domain (and update
// manifest.json's host_permissions + externally_connectable to match).
const API_BASE_URL = "https://application-tracker-ocop.onrender.com";

// Must match manifest.json's externally_connectable.matches. The manifest
// already restricts which origins Chrome will even deliver a message from,
// but this is checked again here as defense in depth rather than trusting
// that alone.
const ALLOWED_EXTERNAL_ORIGIN = "https://application-tracker-ocop.onrender.com";

// The "Connect Extension" button on the dashboard sends this directly via
// chrome.runtime.sendMessage(EXTENSION_ID, ...) -- no popup/options UI
// involved, so this listener is the only thing that runs for it.
chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (message.type === "SET_API_TOKEN") {
    handleSetApiToken(message, sender).then(sendResponse);
    return true;
  }
});

async function handleSetApiToken(message, sender) {
  if (sender.origin !== ALLOWED_EXTERNAL_ORIGIN) {
    return { ok: false, error: "Unauthorized origin" };
  }

  const token = message.token;
  if (!token || typeof token !== "string") {
    return { ok: false, error: "Invalid token" };
  }

  // Same storage key/shape options.js's manual save uses -- this is just a
  // second way to set the same value.
  await chrome.storage.local.set({ apiToken: token });
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "PAGE_FLAGS") {
    handlePageFlags(message);
  } else if (message.type === "POSSIBLE_SUBMISSION") {
    handlePossibleSubmission(message);
  } else if (message.type === "TRACK_APPLICATION") {
    trackApplication({ url: message.url, title: message.title, source: message.source }).then(sendResponse);
    return true; // keep the message channel open for the async sendResponse
  } else if (message.type === "UPDATE_APPLICATION") {
    updateApplication({ url: message.url, changes: message.changes }).then(sendResponse);
    return true;
  } else if (message.type === "REGISTER_DYNAMIC_ORIGIN") {
    registerDynamicOrigin(message.originPattern).then(sendResponse);
    return true;
  } else if (message.type === "SUMMARIZE_PAGE") {
    summarizePage(message.url).then(sendResponse);
    return true;
  } else if (message.type === "SCORE_SUITABILITY") {
    scoreSuitability(message.url).then(sendResponse);
    return true;
  } else if (message.type === "SCORE_COMPETITIVENESS") {
    scoreCompetitiveness(message.url, message.employer_name).then(sendResponse);
    return true;
  } else if (message.type === "COMPUTE_PRIORITY") {
    computePriority(message.suitability_score, message.competitiveness_score).then(sendResponse);
    return true;
  }
});

// ---------- User-approved sites (see popup.js's "Enable detection" flow) ----------

// Registers content.js to auto-run on a site the user just granted optional
// host permission to. chrome.scripting content scripts persist across
// browser restarts by default, so once approved, a site keeps working
// without asking again -- no hardcoded site list, just what the user opted in to.
async function registerDynamicOrigin(originPattern) {
  const id = "user-approved:" + originPattern;

  try {
    await chrome.scripting.unregisterContentScripts({ ids: [id] });
  } catch {
    // Wasn't registered before -- fine.
  }

  await chrome.scripting.registerContentScripts([
    {
      id,
      matches: [originPattern],
      js: ["employer-extraction.js", "timeline-extraction.js", "content.js"],
      runAt: "document_idle",
    },
  ]);

  return { ok: true };
}

async function handlePageFlags({ url, title, flags, pageText, employerName, hiringEndDate }) {
  // Always store an entry, even with zero flags -- popup.js's flags UI
  // already treats "no entry" and "entry with flags: []" identically (both
  // show "no red flags detected"), but the AI-summary feature needs
  // pageText to exist for every recognized job page, not just flagged ones.
  const { flaggedPages = {} } = await chrome.storage.local.get("flaggedPages");
  flaggedPages[url] = {
    title,
    flags,
    pageText,
    employerName: employerName || flaggedPages[url]?.employerName || null,
    hiringEndDate: hiringEndDate || flaggedPages[url]?.hiringEndDate || null,
    checkedAt: Date.now(),
  };
  await chrome.storage.local.set({ flaggedPages });
}

async function handlePossibleSubmission({ url, title }) {
  // Avoid double-notifying for the same URL within a short window
  const { pendingConfirmations = {} } = await chrome.storage.local.get("pendingConfirmations");
  const alreadyPending = pendingConfirmations[url];
  if (alreadyPending && Date.now() - alreadyPending.detectedAt < 60000) {
    return;
  }

  pendingConfirmations[url] = { title, detectedAt: Date.now() };
  await chrome.storage.local.set({ pendingConfirmations });

  chrome.notifications.create(url, {
    type: "basic",
    iconUrl: "icon48.png",
    title: "Add this application to your tracker?",
    message: title || url,
    buttons: [{ title: "Yes, track it" }, { title: "No, ignore" }],
    requireInteraction: true,
  });
}

chrome.notifications.onButtonClicked.addListener(async (notificationId, buttonIndex) => {
  const { pendingConfirmations = {} } = await chrome.storage.local.get("pendingConfirmations");
  const pending = pendingConfirmations[notificationId];
  if (!pending) return;

  if (buttonIndex === 0) {
    // "Yes, track it"
    await trackApplication({ url: notificationId, title: pending.title, source: "notification" });
  }

  delete pendingConfirmations[notificationId];
  await chrome.storage.local.set({ pendingConfirmations });
  chrome.notifications.clear(notificationId);
});

// ---------- Application tracking: local save + best-effort API sync ----------

// Single entry point for recording a tracked application, used by both the
// notification "Yes, track it" flow and the popup's manual-track button.
// Dedup lives here (not in the callers) so both entry points are protected --
// the notification path has no UI moment to check first, unlike the popup's
// manual button.
async function trackApplication({ url, title, source }) {
  const { applications = [] } = await chrome.storage.local.get("applications");

  const alreadyTracked = applications.some((app) => app.url === url);
  if (alreadyTracked) {
    return { ok: true, alreadyTracked: true };
  }

  const appliedAt = Date.now();

  applications.push({ url, title, appliedAt, status: "Applied", notes: "", source });
  await chrome.storage.local.set({ applications });

  // Best-effort sync to the Flask API. If this fails for any reason (no
  // token configured, offline, API down), the local copy above is the
  // fallback -- the popup keeps working off chrome.storage.local either way.
  const apiId = await syncApplicationToApi({ url, title, appliedAt });

  if (apiId) {
    // Re-read before writing back -- time has passed during the fetch above,
    // so this avoids clobbering anything else that touched storage meanwhile.
    const { applications: current = [] } = await chrome.storage.local.get("applications");
    const index = current.findIndex((app) => app.url === url);
    if (index !== -1) {
      current[index].apiId = apiId;
      await chrome.storage.local.set({ applications: current });
    }
  }

  return { ok: true, alreadyTracked: false, apiId };
}

// Applies a status/notes change locally first (offline-first), then
// best-effort PUTs it to the Flask API if this entry has synced before
// (has an apiId) and a token is configured. Used by the popup's status
// dropdown and notes field.
async function updateApplication({ url, changes }) {
  const { applications = [] } = await chrome.storage.local.get("applications");
  const index = applications.findIndex((app) => app.url === url);

  if (index === -1) {
    return { ok: false, error: "Application not found locally" };
  }

  applications[index] = { ...applications[index], ...changes };
  await chrome.storage.local.set({ applications });

  const apiId = applications[index].apiId;
  if (!apiId) {
    return { ok: true, synced: false };
  }

  const { apiToken } = await chrome.storage.local.get("apiToken");
  if (!apiToken) {
    return { ok: true, synced: false };
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/applications/${apiId}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(changes),
    });

    if (!response.ok) {
      console.warn("Application Tracker: update sync failed", response.status, await response.text());
      return { ok: true, synced: false };
    }

    return { ok: true, synced: true };
  } catch (err) {
    console.warn("Application Tracker: update sync error, kept local copy only", err);
    return { ok: true, synced: false };
  }
}

async function syncApplicationToApi({ url, title, appliedAt }) {
  const { apiToken } = await chrome.storage.local.get("apiToken");
  if (!apiToken) return null; // no token saved yet in the options page -- local-only for now

  const { flaggedPages = {} } = await chrome.storage.local.get("flaggedPages");
  const pageEntry = flaggedPages[url] || {};
  const flags = pageEntry.flags || [];

  // If the popup already scored this page (see popup.js's initPriority),
  // reuse those scores rather than re-scoring -- the application row is
  // created with its priority_label already computed server-side (see
  // api.py's create_application), instead of tracking first and hoping a
  // later scan fills it in.
  const { priorityCache = {} } = await chrome.storage.local.get("priorityCache");
  let priorityEntry = priorityCache[url];

  // Notification-based tracking can happen without the popup ever opening,
  // so there may be no cached suitability metadata yet. Reuse that existing
  // endpoint here rather than inventing a second AI call/API shape solely for
  // employer and timeline extraction.
  if (!priorityEntry || priorityEntry.cache_version !== 3) {
    const suitabilityResult = await scoreSuitability(url);
    if (suitabilityResult?.ok) {
      priorityEntry = {
        ...(priorityEntry || {}),
        cache_version: 3,
        company_name: suitabilityResult.employer_name || priorityEntry?.company_name || null,
        hiring_end_date: suitabilityResult.hiring_end_date || pageEntry.hiringEndDate || null,
      };
    }
  }

  const body = {
    title: title || url,
    company: priorityEntry?.company_name || pageEntry.employerName || ApplicationTrackerEmployer.fallbackCompanyName(url),
    url,
    flags,
    applied_date: new Date(appliedAt).toISOString().slice(0, 10),
    hiring_end_date: priorityEntry?.hiring_end_date || pageEntry.hiringEndDate || null,
  };
  if (priorityEntry) {
    if (priorityEntry.suitability_score != null) body.suitability_score = priorityEntry.suitability_score;
    if (priorityEntry.competitiveness_score != null) body.competitiveness_score = priorityEntry.competitiveness_score;
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/applications`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      console.warn("Application Tracker: API sync failed", response.status, await response.text());
      return null;
    }

    const created = await response.json();
    return created.id;
  } catch (err) {
    // Network error, API unreachable, etc. -- the local storage.local copy
    // written in trackApplication() already has this application saved.
    console.warn("Application Tracker: API sync error, kept local copy only", err);
    return null;
  }
}

// ---------- AI page summary ----------

// Reuses the pageText content.js already extracted and sent up via
// PAGE_FLAGS (handlePageFlags above) -- no separate re-scrape of the tab.
async function summarizePage(url) {
  const { flaggedPages = {} } = await chrome.storage.local.get("flaggedPages");
  const pageEntry = flaggedPages[url];

  if (!pageEntry || !pageEntry.pageText) {
    return { ok: false, error: "No page text available for this page yet" };
  }

  const { apiToken } = await chrome.storage.local.get("apiToken");
  if (!apiToken) {
    return { ok: false, error: "No API token configured" };
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/summarize`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        url,
        page_text: pageEntry.pageText,
        flags: pageEntry.flags || [],
      }),
    });

    if (!response.ok) {
      console.warn("Application Tracker: summarize request failed", response.status, await response.text());
      return { ok: false, error: "Summary unavailable" };
    }

    const data = await response.json();
    // data.flags is the AI-derived flags (or the server's own regex-fallback
    // if Gemini's response didn't parse) -- popup.js uses this to replace
    // the regex flags it already showed immediately on popup-open.
    return { ok: true, summary: data.summary, cached: data.cached, flags: data.flags };
  } catch (err) {
    console.warn("Application Tracker: summarize request error", err);
    return { ok: false, error: "Summary unavailable" };
  }
}

// ---------- Application Priority: suitability, competitiveness, combined label ----------

// Reuses the same pageText as summarizePage() above -- no separate re-scrape.
async function scoreSuitability(url) {
  const { flaggedPages = {} } = await chrome.storage.local.get("flaggedPages");
  const pageEntry = flaggedPages[url];

  if (!pageEntry || !pageEntry.pageText) {
    return { ok: false, error: "No page text available for this page yet" };
  }

  const { apiToken } = await chrome.storage.local.get("apiToken");
  if (!apiToken) {
    return { ok: false, error: "No API token configured" };
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/score-suitability`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ page_text: pageEntry.pageText }),
    });

    if (!response.ok) {
      console.warn("Application Tracker: suitability scoring failed", response.status, await response.text());
      return { ok: false, error: "Suitability score unavailable" };
    }

    const data = await response.json();
    // suitability_score is null (with a message) when no background_text is
    // set yet -- an expected state, not a failure, so this still returns
    // ok: true and lets popup.js show data.message instead of a number.
    return {
      ok: true,
      suitability_score: data.suitability_score,
      employer_name: data.employer_name || pageEntry.employerName || null,
      hiring_end_date: data.hiring_end_date || pageEntry.hiringEndDate || null,
      message: data.message,
    };
  } catch (err) {
    console.warn("Application Tracker: suitability scoring error", err);
    return { ok: false, error: "Suitability score unavailable" };
  }
}

async function scoreCompetitiveness(url, employerName) {
  const { apiToken } = await chrome.storage.local.get("apiToken");
  if (!apiToken) {
    return { ok: false, error: "No API token configured" };
  }

  const { flaggedPages = {} } = await chrome.storage.local.get("flaggedPages");
  const companyName = employerName || flaggedPages[url]?.employerName;
  if (!companyName) {
    return { ok: false, error: "Employer name unavailable" };
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/score-competitiveness`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({ company_name: companyName }),
    });

    if (!response.ok) {
      console.warn("Application Tracker: competitiveness scoring failed", response.status, await response.text());
      return { ok: false, error: "Competitiveness score unavailable" };
    }

    const data = await response.json();
    // data.grounded distinguishes a real web-search-backed score from a
    // plain-prompt estimate -- popup.js surfaces this as-is so an estimate
    // is never shown as verified research.
    return {
      ok: true,
      company_name: data.company_name || companyName,
      competitiveness_score: data.competitiveness_score,
      grounded: data.grounded,
    };
  } catch (err) {
    console.warn("Application Tracker: competitiveness scoring error", err);
    return { ok: false, error: "Competitiveness score unavailable" };
  }
}

async function computePriority(suitabilityScore, competitivenessScore) {
  const { apiToken } = await chrome.storage.local.get("apiToken");
  if (!apiToken) {
    return { ok: false, error: "No API token configured" };
  }

  try {
    const response = await fetch(`${API_BASE_URL}/api/compute-priority`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify({
        suitability_score: suitabilityScore,
        competitiveness_score: competitivenessScore,
      }),
    });

    if (!response.ok) {
      console.warn("Application Tracker: compute-priority failed", response.status, await response.text());
      return { ok: false, error: "Priority label unavailable" };
    }

    const data = await response.json();
    return { ok: true, priority_label: data.priority_label };
  } catch (err) {
    console.warn("Application Tracker: compute-priority error", err);
    return { ok: false, error: "Priority label unavailable" };
  }
}
