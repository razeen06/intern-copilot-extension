const test = require("node:test");
const assert = require("node:assert/strict");

const {
  cleanEmployerName,
  extractEmployerName,
  fallbackCompanyName,
} = require("../employer-extraction.js");

function fakeDocument({ jsonLd = [], selectors = {} }) {
  return {
    querySelectorAll(selector) {
      if (selector !== 'script[type="application/ld+json"]') return [];
      return jsonLd.map((value) => ({
        textContent: typeof value === "string" ? value : JSON.stringify(value),
      }));
    },
    querySelector(selector) {
      const value = selectors[selector];
      if (value == null) return null;
      return {
        textContent: value,
        getAttribute() {
          return null;
        },
      };
    },
  };
}

test("SEEK posting resolves Springtek from JobPosting JSON-LD", () => {
  const documentRef = fakeDocument({
    jsonLd: [{
      "@context": "https://schema.org",
      "@type": "JobPosting",
      title: "Start your Tech Career - Software Engineering Internship",
      hiringOrganization: { "@type": "Organization", name: "Springtek" },
    }],
  });

  assert.equal(extractEmployerName(documentRef), "Springtek");
});

test("LinkedIn posting resolves Atlassian from the signed-in job header", () => {
  const documentRef = fakeDocument({
    selectors: {
      ".job-details-jobs-unified-top-card__company-name a": "Atlassian",
    },
  });

  assert.equal(extractEmployerName(documentRef), "Atlassian");
});

test("Indeed posting resolves Airwallex from the company header", () => {
  const documentRef = fakeDocument({
    selectors: {
      '[data-testid="inlineHeader-companyName"]': "Airwallex",
    },
  });

  assert.equal(extractEmployerName(documentRef), "Airwallex");
});

test("job-board names and domains are rejected instead of being scored", () => {
  for (const value of ["SEEK", "au.seek.com", "LinkedIn", "au.linkedin.com", "Indeed", "au.indeed.com"]) {
    assert.equal(cleanEmployerName(value), null, value);
  }

  assert.equal(
    fallbackCompanyName("https://au.seek.com/job/123"),
    "Employer not identified"
  );
  assert.equal(
    fallbackCompanyName("https://careers.example-company.com/jobs/123"),
    "careers.example-company.com"
  );
});

test("malformed JSON-LD falls through to board-specific selectors", () => {
  const documentRef = fakeDocument({
    jsonLd: ["{not valid json"],
    selectors: {
      '[data-automation="job-detail-company"]': "Springtek",
    },
  });

  assert.equal(extractEmployerName(documentRef), "Springtek");
});
