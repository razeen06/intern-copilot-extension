// content.js
// The manifest's host_permissions/content_scripts "matches" (see
// manifest.json) scope injection to a named set of big job boards/ATS
// domains PLUS a set of convention-based wildcards that generalize to ATS
// platforms and self-hosted career pages we can't enumerate by name:
// the "jobs." / "careers." subdomain convention, and path substrings like
// *career*, *job*, *apply*, *hiring*, *vacanc*, *position*, *opportunit*,
// *recruit*, *join-us*. This deliberately trades precision for coverage --
// a page merely containing "apply" in its URL is not necessarily a job page
// (e.g. a blog post about loan applications). The pre-filter below is the
// second, stricter layer: outside the named ATS domains (where the URL match
// already guarantees relevance), it confirms the page text itself looks
// job-related before doing any real work.

// ---------- 0. PRE-FILTER: does this page even look job-related? ----------

// Domains where the manifest's "matches" already scoped us to job-specific
// paths (LinkedIn /jobs/, Workday job boards, etc.) -- no need to re-check
// page text for these, the URL match already guarantees relevance.
const KNOWN_JOB_BOARD_HOSTS = [
  "linkedin.com",
  "seek.com",
  "seek.com.au",
  "seek.co.nz",
  "indeed.com",
  "indeed.co.uk",
  "indeed.ca",
  "indeed.com.au",
  "myworkdayjobs.com",
  "greenhouse.io",
  "lever.co",
  "smartrecruiters.com",
];

const JOB_PAGE_HINTS = [
  "career", "careers", "job", "jobs", "apply", "application",
  "internship", "vacancy", "vacancies", "position", "recruit",
  "hiring", "opportunit", "join us", "join our team",
];

function isKnownJobBoardHost(hostname) {
  return KNOWN_JOB_BOARD_HOSTS.some(
    (host) => hostname === host || hostname.endsWith("." + host)
  );
}

function looksLikeJobPage() {
  if (isKnownJobBoardHost(window.location.hostname)) {
    return true;
  }

  // Reached via the generic */careers/* or */apply/* path wildcard on an
  // arbitrary domain -- still confirm the page text looks job-related.
  const haystack = (
    window.location.href + " " +
    document.title + " " +
    (document.body ? document.body.innerText.slice(0, 2000) : "")
  ).toLowerCase();

  return JOB_PAGE_HINTS.some((hint) => haystack.includes(hint));
}

// If this page doesn't look job-related at all, stop here -- don't scan,
// don't watch for submissions, don't do anything. Saves CPU and avoids
// false positives on unrelated sites.
if (!looksLikeJobPage()) {
  // Exit early. Nothing below this point runs.
} else {

// ---------- 1. ELIGIBILITY FLAG SCANNING ----------

// Each rule: a short label + a regex to test against the page's visible text.
// Keep these as plain, readable patterns so they're easy to extend later.
const FLAG_RULES = [
  {
    label: "WAM/GPA cutoff mentioned",
    pattern: /\b(WAM|GPA)\b.{0,40}\b(minimum|at least|or (above|higher)|cut ?off|required)\b/i,
  },
  {
    label: "'Penultimate year' requirement",
    pattern: /\bpenultimate year\b/i,
  },
  {
    label: "'Final year' requirement",
    pattern: /\bfinal year\b(?!.{0,20}(penultimate))/i,
  },
  {
    label: "Possible pay-to-place scheme",
    // looks for "guarantee" AND ("fee" or "$" or "cost") both present,
    // since a guaranteed placement + a cost is the actual red flag combo,
    // not either word alone.
    pattern: /guarantee(d)?.{0,120}(fee|\$\d|cost|payment)|((fee|\$\d|cost|payment).{0,120}guarantee(d)?)/i,
  },
  {
    label: "Unpaid internship",
    pattern: /\bunpaid\b/i,
  },
];

function scanPageForFlags(pageText) {
  const foundFlags = [];

  for (const rule of FLAG_RULES) {
    if (rule.pattern.test(pageText)) {
      foundFlags.push(rule.label);
    }
  }

  return foundFlags;
}

function reportFlags() {
  // Extracted once and reused for both flag scanning and the AI-summary
  // feature (background.js/popup.js), rather than re-scraping separately.
  const pageText = document.body.innerText || "";
  const flags = scanPageForFlags(pageText);
  const employerName = ApplicationTrackerEmployer.extractEmployerName(document);
  // Previously registered optional-site content scripts may not include the
  // new helper until that site is re-registered. Keep those installations
  // working and let the backend AI extraction provide the date meanwhile.
  const hiringEndDate = globalThis.ApplicationTrackerTimeline
    ? ApplicationTrackerTimeline.extractHiringEndDate(pageText)
    : null;
  chrome.runtime.sendMessage({
    type: "PAGE_FLAGS",
    url: window.location.href,
    title: document.title,
    flags,
    pageText,
    employerName,
    hiringEndDate,
  });
}

// Run once on load, and also after a short delay in case the page is a
// single-page app that renders content slightly after initial load.
reportFlags();
setTimeout(reportFlags, 2000);

// ---------- 2. APPLICATION SUBMISSION DETECTION ----------

// Generic confirmation-language patterns. Not perfect, not meant to be --
// this is a "catch the common cases, confirm with the user" design, not a
// silent, always-right oracle.
const CONFIRMATION_PATTERNS = [
  /application (has been |was )?(successfully )?submitted/i,
  /thank you for (your application|applying)/i,
  /your application (has been |was )?received/i,
  /application complete/i,
];

const CONFIRMATION_URL_HINTS = ["thank-you", "thankyou", "confirmation", "success", "submitted"];

function looksLikeConfirmation() {
  const url = window.location.href.toLowerCase();
  if (CONFIRMATION_URL_HINTS.some((hint) => url.includes(hint))) {
    return true;
  }
  const pageText = document.body.innerText || "";
  return CONFIRMATION_PATTERNS.some((pattern) => pattern.test(pageText));
}

let alreadyReportedThisPage = false;

function checkForSubmission() {
  if (alreadyReportedThisPage) return;
  if (looksLikeConfirmation()) {
    alreadyReportedThisPage = true;
    chrome.runtime.sendMessage({
      type: "POSSIBLE_SUBMISSION",
      url: window.location.href,
      title: document.title,
    });
  }
}

// Check once on load...
checkForSubmission();

// ...and keep watching, since many application forms are single-page apps
// that change content/URL without a full page reload after you hit submit.
const observer = new MutationObserver(() => checkForSubmission());
observer.observe(document.body, { childList: true, subtree: true });

// Also catch actual navigation changes (SPA route changes)
let lastUrl = window.location.href;
setInterval(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    alreadyReportedThisPage = false;
    checkForSubmission();
  }
}, 1000);

} // end of "if (looksLikeJobPage())" block
