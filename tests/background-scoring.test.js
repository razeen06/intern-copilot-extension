const test = require("node:test");
const assert = require("node:assert/strict");

function loadBackground(initialStorage, fetchImpl) {
  const storage = structuredClone(initialStorage);
  let messageListener;

  global.ApplicationTrackerEmployer = require("../employer-extraction.js");
  global.importScripts = () => {};
  global.fetch = fetchImpl;
  global.chrome = {
    runtime: {
      onMessageExternal: { addListener() {} },
      onMessage: { addListener(listener) { messageListener = listener; } },
    },
    notifications: {
      create() {},
      clear() {},
      onButtonClicked: { addListener() {} },
    },
    scripting: {
      unregisterContentScripts: async () => {},
      registerContentScripts: async () => {},
    },
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return { [key]: storage[key] };
          return storage;
        },
        async set(values) {
          Object.assign(storage, values);
        },
      },
    },
  };

  delete require.cache[require.resolve("../background.js")];
  require("../background.js");

  async function send(message) {
    return new Promise((resolve) => {
      const keepAlive = messageListener(message, {}, resolve);
      assert.equal(keepAlive, true);
    });
  }

  return { send, storage };
}

test("competitiveness request sends the real employer, not the job-board URL", async () => {
  let requestBody;
  const { send } = loadBackground(
    { apiToken: "token", flaggedPages: {} },
    async (url, options) => {
      assert.match(url, /\/api\/score-competitiveness$/);
      requestBody = JSON.parse(options.body);
      return {
        ok: true,
        async json() {
          return {
            company_name: "Atlassian",
            competitiveness_score: 8.5,
            grounded: false,
          };
        },
      };
    }
  );

  const result = await send({
    type: "SCORE_COMPETITIVENESS",
    url: "https://au.linkedin.com/jobs/view/4373523620",
    employer_name: "Atlassian",
  });

  assert.deepEqual(requestBody, { company_name: "Atlassian" });
  assert.equal(result.company_name, "Atlassian");
});

test("tracked SEEK application persists the same employer used by scoring", async () => {
  let requestBody;
  const jobUrl = "https://au.seek.com/job/123";
  const { send, storage } = loadBackground(
    {
      apiToken: "token",
      applications: [],
      flaggedPages: {
        [jobUrl]: { flags: [], employerName: "Springtek", pageText: "posting" },
      },
      priorityCache: {
        [jobUrl]: {
          cache_version: 2,
          company_name: "Springtek",
          suitability_score: 7,
          competitiveness_score: 4,
        },
      },
    },
    async (url, options) => {
      assert.match(url, /\/api\/applications$/);
      requestBody = JSON.parse(options.body);
      return { ok: true, async json() { return { id: 42 }; } };
    }
  );

  const result = await send({
    type: "TRACK_APPLICATION",
    url: jobUrl,
    title: "Start your Tech Career - Software Engineering Internship",
    source: "manual",
  });

  assert.equal(result.apiId, 42);
  assert.equal(requestBody.company, "Springtek");
  assert.equal(requestBody.suitability_score, 7);
  assert.equal(requestBody.competitiveness_score, 4);
  assert.equal(storage.applications[0].apiId, 42);
});
