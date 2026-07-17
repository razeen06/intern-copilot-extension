// options.js

// Inline SVG icons (no external icon library -- MV3 pages can't load remote
// resources). Presentational only, swapped into the same template strings
// that already existed; no change to logic, events, or data.
const CHECK_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 11.08V12a10 10 0 11-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>`;
const TRASH_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6m3 0V4a2 2 0 012-2h4a2 2 0 012 2v2"/></svg>`;
const EMPTY_SITES_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 010 20M12 2a15.3 15.3 0 000 20"/></svg>`;

const tokenInput = document.getElementById("token-input");
const statusEl = document.getElementById("status");

async function loadToken() {
  const { apiToken } = await chrome.storage.local.get("apiToken");
  if (apiToken) tokenInput.value = apiToken;
}

document.getElementById("save-btn").addEventListener("click", async () => {
  const value = tokenInput.value.trim();
  await chrome.storage.local.set({ apiToken: value });
  statusEl.textContent = value ? "Saved." : "Token cleared.";
  setTimeout(() => {
    statusEl.textContent = "";
  }, 2000);
});

loadToken();

// ---------- Sites approved via the popup's "Enable detection" flow ----------

async function renderApprovedSites() {
  const container = document.getElementById("approved-sites-list");
  const registered = await chrome.scripting.getRegisteredContentScripts();
  const userApproved = registered.filter((script) => script.id.startsWith("user-approved:"));

  if (userApproved.length === 0) {
    container.innerHTML = `<div class="empty-state">${EMPTY_SITES_ICON_SVG}<span>No additional sites enabled yet.</span></div>`;
    return;
  }

  container.innerHTML = userApproved
    .map((script) => {
      const originPattern = script.matches[0];
      return `
        <div class="site-row">
          <span>${originPattern}</span>
          <button class="remove-site-btn" data-origin="${originPattern}" data-id="${script.id}" aria-label="Remove approved site" title="Remove approved site">${TRASH_ICON_SVG}<span>Remove</span></button>
        </div>
      `;
    })
    .join("");

  container.querySelectorAll(".remove-site-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const { origin, id } = btn.dataset;
      await chrome.scripting.unregisterContentScripts({ ids: [id] });
      try {
        await chrome.permissions.remove({ origins: [origin] });
      } catch {
        // Permission wasn't revocable (e.g. it overlaps a mandatory host
        // permission) -- the content script is unregistered either way,
        // which is what actually stops auto-detection on this site.
      }
      renderApprovedSites();
    });
  });
}

renderApprovedSites();
