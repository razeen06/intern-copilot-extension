// Employer-name extraction shared by the content script and its Node tests.
// Job-board domains are deliberately rejected: competitiveness must describe
// the hiring organisation, never SEEK, LinkedIn, Indeed, or another host.
(function (root, factory) {
  const api = factory();
  root.ApplicationTrackerEmployer = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  const JOB_BOARD_NAMES = new Set([
    "indeed",
    "linkedin",
    "seek",
    "seek grad",
  ]);

  const JOB_BOARD_HOSTS = [
    "indeed.com",
    "indeed.co.uk",
    "indeed.ca",
    "indeed.com.au",
    "linkedin.com",
    "seek.com",
    "seek.com.au",
    "seek.co.nz",
    "myworkdayjobs.com",
    "greenhouse.io",
    "lever.co",
    "smartrecruiters.com",
  ];

  const EMPLOYER_SELECTORS = [
    // Standards-based markup first.
    '[itemprop="hiringOrganization"] [itemprop="name"]',
    '[itemprop="hiringOrganization"]',
    // SEEK.
    '[data-automation="job-detail-company"]',
    '[data-automation="advertiser-name"]',
    // LinkedIn public and signed-in job views.
    '.topcard__org-name-link',
    '.job-details-jobs-unified-top-card__company-name a',
    '.jobs-unified-top-card__company-name a',
    '.job-details-jobs-unified-top-card__company-name',
    '.jobs-unified-top-card__company-name',
    // Indeed desktop/mobile job views.
    '[data-testid="inlineHeader-companyName"]',
    '[data-company-name="true"]',
  ];

  function cleanEmployerName(value) {
    if (typeof value !== "string") return null;

    const cleaned = value
      .replace(/\s+/g, " ")
      .replace(/^at\s+/i, "")
      .trim();
    if (!cleaned || cleaned.length > 200) return null;

    const normalized = cleaned.toLowerCase().replace(/^www\./, "");
    if (JOB_BOARD_NAMES.has(normalized)) return null;
    if (JOB_BOARD_HOSTS.some(
      (host) => normalized === host || normalized.endsWith("." + host)
    )) {
      return null;
    }

    return cleaned;
  }

  function fallbackCompanyName(url) {
    try {
      const hostname = new URL(url).hostname.replace(/^www\./, "");
      return cleanEmployerName(hostname) || "Employer not identified";
    } catch {
      return "Employer not identified";
    }
  }

  function hiringOrganizationName(value) {
    if (!value || typeof value !== "object") return null;

    if (Array.isArray(value)) {
      for (const item of value) {
        const found = hiringOrganizationName(item);
        if (found) return found;
      }
      return null;
    }

    const type = value["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.some((item) => String(item).toLowerCase() === "jobposting")) {
      const organisation = value.hiringOrganization;
      const name = typeof organisation === "string" ? organisation : organisation?.name;
      const cleaned = cleanEmployerName(name);
      if (cleaned) return cleaned;
    }

    if (value["@graph"]) {
      const found = hiringOrganizationName(value["@graph"]);
      if (found) return found;
    }

    return null;
  }

  function extractEmployerName(documentRef) {
    if (!documentRef) return null;

    const scripts = documentRef.querySelectorAll?.('script[type="application/ld+json"]') || [];
    for (const script of scripts) {
      try {
        const found = hiringOrganizationName(JSON.parse(script.textContent || ""));
        if (found) return found;
      } catch {
        // A malformed analytics/SEO block must not stop the remaining
        // structured-data blocks or the board-specific selector fallback.
      }
    }

    for (const selector of EMPLOYER_SELECTORS) {
      const element = documentRef.querySelector?.(selector);
      const found = cleanEmployerName(
        element?.getAttribute?.("content") || element?.textContent || ""
      );
      if (found) return found;
    }

    return null;
  }

  return {
    cleanEmployerName,
    extractEmployerName,
    fallbackCompanyName,
    hiringOrganizationName,
  };
});
