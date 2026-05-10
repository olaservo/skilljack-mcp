/**
 * Skills Configuration MCP App - Vanilla JS implementation
 */
import {
  App,
  applyDocumentTheme,
  applyHostStyleVariables,
  applyHostFonts,
} from "@modelcontextprotocol/ext-apps";

// Types
interface DirectoryInfo {
  path: string;
  source: "cli" | "env" | "config";
  type: "local" | "github" | "well-known";
  valid: boolean;
  allowed: boolean;
  skillCount?: number;
}

interface ConfigState {
  directories: DirectoryInfo[];
  activeSource: string;
  isOverridden: boolean;
  staticMode?: boolean;
  allowedOrgs?: string[];
  allowedUsers?: string[];
  allowedOrigins?: string[];
  success?: boolean;
  error?: string;
}

// State
let directories: DirectoryInfo[] = [];
let activeSource = "config";
let isOverridden = false;
let staticMode = false;
let allowedOrgs: string[] = [];
let allowedUsers: string[] = [];
let allowedOrigins: string[] = [];
let app: App | null = null;

// DOM Elements
const directoryList = document.getElementById("directory-list")!;
const stats = document.getElementById("stats")!;
const addBtn = document.getElementById("add-btn") as HTMLButtonElement;
const addModal = document.getElementById("add-modal")!;
const overrideBanner = document.getElementById("override-banner")!;
const overrideSource = document.getElementById("override-source")!;
const toast = document.getElementById("toast")!;
const directoryInput = document.getElementById("directory-path") as HTMLInputElement;
const addSubmitBtn = document.getElementById("add-submit-btn") as HTMLButtonElement;

// Allowed orgs DOM elements
const allowedOrgsList = document.getElementById("allowed-orgs-list")!;
const addOrgBtn = document.getElementById("add-org-btn") as HTMLButtonElement;
const addOrgModal = document.getElementById("add-org-modal")!;
const orgNameInput = document.getElementById("org-name") as HTMLInputElement;
const addOrgSubmitBtn = document.getElementById("add-org-submit-btn") as HTMLButtonElement;

// Static mode DOM element
const staticModeToggle = document.getElementById("static-mode-toggle") as HTMLInputElement;

// Confirm remove modal DOM elements
const confirmRemoveModal = document.getElementById("confirm-remove-modal")!;
const confirmRemovePath = document.getElementById("confirm-remove-path")!;
const confirmRemoveBtn = document.getElementById("confirm-remove-btn") as HTMLButtonElement;
const confirmRemoveCancel = document.getElementById("confirm-remove-cancel") as HTMLButtonElement;
const confirmRemoveClose = document.getElementById("confirm-remove-close") as HTMLButtonElement;

// Track pending removal
let pendingRemovePath: string | null = null;
let pendingRemoveOrg: string | null = null;
let pendingRemoveOrigin: string | null = null;

// Confirm remove org modal DOM elements
const confirmRemoveOrgModal = document.getElementById("confirm-remove-org-modal")!;
const confirmRemoveOrgName = document.getElementById("confirm-remove-org-name")!;
const confirmRemoveOrgBtn = document.getElementById("confirm-remove-org-btn") as HTMLButtonElement;
const confirmRemoveOrgCancel = document.getElementById("confirm-remove-org-cancel") as HTMLButtonElement;
const confirmRemoveOrgClose = document.getElementById("confirm-remove-org-close") as HTMLButtonElement;

// Allowed origins DOM elements
const allowedOriginsList = document.getElementById("allowed-origins-list")!;
const addOriginBtn = document.getElementById("add-origin-btn") as HTMLButtonElement;
const addOriginModal = document.getElementById("add-origin-modal")!;
const originNameInput = document.getElementById("origin-name") as HTMLInputElement;
const addOriginSubmitBtn = document.getElementById("add-origin-submit-btn") as HTMLButtonElement;

// Confirm remove origin modal DOM elements
const confirmRemoveOriginModal = document.getElementById("confirm-remove-origin-modal")!;
const confirmRemoveOriginName = document.getElementById("confirm-remove-origin-name")!;
const confirmRemoveOriginBtn = document.getElementById("confirm-remove-origin-btn") as HTMLButtonElement;
const confirmRemoveOriginCancel = document.getElementById("confirm-remove-origin-cancel") as HTMLButtonElement;
const confirmRemoveOriginClose = document.getElementById("confirm-remove-origin-close") as HTMLButtonElement;

// Handle host context changes
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function handleHostContextChanged(ctx: any) {
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
  // Handle safe area insets for mobile/notched devices
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    document.body.style.paddingTop = `${top + 16}px`;
    document.body.style.paddingRight = `${right + 16}px`;
    document.body.style.paddingBottom = `${bottom + 16}px`;
    document.body.style.paddingLeft = `${left + 16}px`;
  }
}

// Update state from tool result
function updateState(data: ConfigState) {
  if (data.directories) {
    directories = data.directories;
  }
  if (data.activeSource) {
    activeSource = data.activeSource;
  }
  if (data.isOverridden !== undefined) {
    isOverridden = data.isOverridden;
  }
  if (data.staticMode !== undefined) {
    staticMode = data.staticMode;
  }
  if (data.allowedOrgs) {
    allowedOrgs = data.allowedOrgs;
  }
  if (data.allowedUsers) {
    allowedUsers = data.allowedUsers;
  }
  if (data.allowedOrigins) {
    allowedOrigins = data.allowedOrigins;
  }

  render();
}

// Render the UI
function render() {
  renderStats();
  renderOverrideBanner();
  renderDirectories();
  renderAllowedOrgs();
  renderAllowedOrigins();
  updateAddButton();
  renderStaticModeToggle();
}

function renderStats() {
  const totalSkills = directories.reduce((sum, d) => sum + (d.skillCount || 0), 0);
  const validCount = directories.filter((d) => d.valid).length;
  stats.textContent = `${directories.length} directories, ${totalSkills} skills total`;
  if (validCount < directories.length) {
    stats.textContent += ` (${directories.length - validCount} missing)`;
  }

  const warningBanner = document.getElementById("skill-count-warning")!;
  if (totalSkills >= 50) {
    warningBanner.style.display = "block";
  } else {
    warningBanner.style.display = "none";
  }
}

function renderOverrideBanner() {
  if (isOverridden) {
    overrideBanner.classList.add("visible");
    overrideSource.textContent =
      activeSource === "cli" ? "CLI arguments" : "SKILLS_DIR environment variable";
  } else {
    overrideBanner.classList.remove("visible");
  }
}

function renderDirectories() {
  if (directories.length === 0) {
    directoryList.innerHTML = `
      <div class="empty-state">
        <p>No skills directories configured.</p>
        <p>Click "Add Directory" to get started.</p>
      </div>
    `;
    return;
  }

  directoryList.innerHTML = directories
    .map((dir) => {
      const isReadOnly = dir.source !== "config";
      const isBlocked = (dir.type === "github" || dir.type === "well-known") && !dir.allowed;
      return `
      <div class="directory-card ${isReadOnly ? "readonly" : ""} ${isBlocked ? "blocked" : ""}">
        ${isReadOnly ? `<span class="lock-icon" title="Read-only: configured via ${dir.source.toUpperCase()}">&#128274;</span>` : ""}
        <div class="directory-info">
          <div class="directory-path">${escapeHtml(dir.path)}</div>
          <div class="directory-meta">
            <span class="source-badge ${dir.source}">${dir.source.toUpperCase()}</span>
            <span class="type-badge ${dir.type}">${dir.type.toUpperCase()}</span>
            ${isBlocked
              ? `<span class="blocked-badge" title="Add org/user to allowed list to sync">BLOCKED</span>`
              : `<span class="skill-count">${dir.skillCount} skill${dir.skillCount !== 1 ? "s" : ""}</span>`
            }
            <span class="validity-icon ${dir.valid ? "valid" : "invalid"}" title="${dir.valid ? "Directory exists" : "Directory not found"}">
              ${dir.valid ? "&#10003;" : "&#10007;"}
            </span>
          </div>
        </div>
        ${!isReadOnly ? `<button class="remove-btn" data-path="${escapeHtml(dir.path)}">Remove</button>` : ""}
      </div>
    `;
    })
    .join("");

  // Add click handlers for remove buttons
  directoryList.querySelectorAll(".remove-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const path = (btn as HTMLButtonElement).dataset.path;
      if (path) {
        showConfirmRemoveModal(path);
      }
    });
  });
}

function updateAddButton() {
  // Disable add button if directories are overridden
  addBtn.disabled = isOverridden;
  if (isOverridden) {
    addBtn.title =
      "Cannot add directories while " +
      (activeSource === "cli" ? "CLI args" : "env var") +
      " override is active";
  } else {
    addBtn.title = "";
  }
}

function renderStaticModeToggle() {
  if (staticModeToggle) {
    staticModeToggle.checked = staticMode;
  }
}

// Toggle static mode
async function setStaticModeEnabled(enabled: boolean) {
  staticModeToggle.disabled = true;

  try {
    const result = await app!.callServerTool({
      name: "skill-config-set-static-mode",
      arguments: { enabled },
    });

    console.log("Static mode result:", result);

    const structured = result.structuredContent as unknown as { success?: boolean; staticMode?: boolean; error?: string };
    if (structured?.success) {
      staticMode = structured.staticMode ?? enabled;
      renderStaticModeToggle();
      showToast(
        enabled
          ? "Static mode enabled. Restart server for changes to take effect."
          : "Static mode disabled. Restart server for changes to take effect.",
        "success"
      );
    } else {
      // Revert toggle on failure
      staticModeToggle.checked = staticMode;
      showToast(structured?.error || "Failed to change static mode", "error");
    }
  } catch (error) {
    console.error("Set static mode error:", error);
    // Revert toggle on error
    staticModeToggle.checked = staticMode;
    showToast((error as Error).message || "Failed to change static mode", "error");
  } finally {
    staticModeToggle.disabled = false;
  }
}

// Add directory
async function addDirectory() {
  const path = directoryInput.value.trim();
  if (!path) {
    showToast("Please enter a directory path", "error");
    return;
  }

  addSubmitBtn.disabled = true;
  addSubmitBtn.textContent = "Adding...";

  try {
    const result = await app!.callServerTool({
      name: "skill-config-add-directory",
      arguments: { directory: path },
    });

    console.log("Add result:", result);

    const structured = result.structuredContent as unknown as ConfigState;
    if (structured?.success) {
      updateState(structured);
      closeAddModal();
      showToast("Directory added successfully", "success");
    } else {
      showToast(structured?.error || "Failed to add directory", "error");
    }
  } catch (error) {
    console.error("Add directory error:", error);
    showToast((error as Error).message || "Failed to add directory", "error");
  } finally {
    addSubmitBtn.disabled = false;
    addSubmitBtn.textContent = "Add Directory";
  }
}

// Show confirmation modal for removing a directory
function showConfirmRemoveModal(path: string) {
  pendingRemovePath = path;
  confirmRemovePath.textContent = path;
  confirmRemoveModal.classList.add("active");
}

// Hide confirmation modal
function closeConfirmRemoveModal() {
  confirmRemoveModal.classList.remove("active");
  pendingRemovePath = null;
}

// Remove directory (called after confirmation)
async function removeDirectory(path: string) {
  try {
    const result = await app!.callServerTool({
      name: "skill-config-remove-directory",
      arguments: { directory: path },
    });

    console.log("Remove result:", result);

    const structured = result.structuredContent as unknown as ConfigState;
    if (structured?.success) {
      updateState(structured);
      showToast("Directory removed", "success");
    } else {
      showToast(structured?.error || "Failed to remove directory", "error");
    }
  } catch (error) {
    console.error("Remove directory error:", error);
    showToast((error as Error).message || "Failed to remove directory", "error");
  }
}

// Render allowed orgs list
function renderAllowedOrgs() {
  if (allowedOrgs.length === 0) {
    allowedOrgsList.innerHTML = `
      <div class="empty-state small">
        No allowed orgs configured. GitHub repos are blocked until an org/user is added.
      </div>
    `;
    return;
  }

  allowedOrgsList.innerHTML = allowedOrgs
    .map((org) => `
      <div class="allowed-item">
        <span class="allowed-name">${escapeHtml(org)}</span>
        <button class="remove-org-btn" data-org="${escapeHtml(org)}">Remove</button>
      </div>
    `)
    .join("");

  // Add click handlers for remove buttons
  allowedOrgsList.querySelectorAll(".remove-org-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const org = (btn as HTMLButtonElement).dataset.org;
      if (org) {
        showConfirmRemoveOrgModal(org);
      }
    });
  });
}

// Add allowed org
async function addAllowedOrg() {
  const org = orgNameInput.value.trim();
  if (!org) {
    showToast("Please enter an organization name", "error");
    return;
  }

  addOrgSubmitBtn.disabled = true;
  addOrgSubmitBtn.textContent = "Adding...";

  try {
    const result = await app!.callServerTool({
      name: "skill-config-add-allowed-org",
      arguments: { org },
    });

    console.log("Add org result:", result);

    const structured = result.structuredContent as unknown as ConfigState;
    if (structured?.success) {
      updateState(structured);
      closeOrgModal();
      showToast(`Added allowed org: ${org}`, "success");
    } else {
      showToast(structured?.error || "Failed to add org", "error");
    }
  } catch (error) {
    console.error("Add org error:", error);
    showToast((error as Error).message || "Failed to add org", "error");
  } finally {
    addOrgSubmitBtn.disabled = false;
    addOrgSubmitBtn.textContent = "Add Org";
  }
}

// Show confirmation modal for removing an allowed org
function showConfirmRemoveOrgModal(org: string) {
  pendingRemoveOrg = org;
  confirmRemoveOrgName.textContent = org;
  confirmRemoveOrgModal.classList.add("active");
}

// Hide confirmation modal for org removal
function closeConfirmRemoveOrgModal() {
  confirmRemoveOrgModal.classList.remove("active");
  pendingRemoveOrg = null;
}

// Remove allowed org (called after confirmation)
async function removeAllowedOrg(org: string) {
  try {
    const result = await app!.callServerTool({
      name: "skill-config-remove-allowed-org",
      arguments: { org },
    });

    console.log("Remove org result:", result);

    const structured = result.structuredContent as unknown as ConfigState;
    if (structured?.success) {
      updateState(structured);
      showToast(`Removed allowed org: ${org}`, "success");
    } else {
      showToast(structured?.error || "Failed to remove org", "error");
    }
  } catch (error) {
    console.error("Remove org error:", error);
    showToast((error as Error).message || "Failed to remove org", "error");
  }
}

// Render allowed origins list
function renderAllowedOrigins() {
  if (allowedOrigins.length === 0) {
    allowedOriginsList.innerHTML = `
      <div class="empty-state small">
        No allowed origins configured. Well-known publishers are blocked until an origin is added.
      </div>
    `;
    return;
  }

  allowedOriginsList.innerHTML = allowedOrigins
    .map((origin) => `
      <div class="allowed-item">
        <span class="allowed-name">${escapeHtml(origin)}</span>
        <button class="remove-origin-btn" data-origin="${escapeHtml(origin)}">Remove</button>
      </div>
    `)
    .join("");

  allowedOriginsList.querySelectorAll(".remove-origin-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const origin = (btn as HTMLButtonElement).dataset.origin;
      if (origin) {
        showConfirmRemoveOriginModal(origin);
      }
    });
  });
}

// Add allowed origin
async function addAllowedOrigin() {
  const origin = originNameInput.value.trim();
  if (!origin) {
    showToast("Please enter an origin", "error");
    return;
  }

  addOriginSubmitBtn.disabled = true;
  addOriginSubmitBtn.textContent = "Adding...";

  try {
    const result = await app!.callServerTool({
      name: "skill-config-add-allowed-origin",
      arguments: { origin },
    });

    console.log("Add origin result:", result);

    const structured = result.structuredContent as unknown as ConfigState;
    if (structured?.success) {
      updateState(structured);
      closeOriginModal();
      showToast(`Added allowed origin`, "success");
    } else {
      showToast(structured?.error || "Failed to add origin", "error");
    }
  } catch (error) {
    console.error("Add origin error:", error);
    showToast((error as Error).message || "Failed to add origin", "error");
  } finally {
    addOriginSubmitBtn.disabled = false;
    addOriginSubmitBtn.textContent = "Add Origin";
  }
}

// Show confirmation modal for removing an allowed origin
function showConfirmRemoveOriginModal(origin: string) {
  pendingRemoveOrigin = origin;
  confirmRemoveOriginName.textContent = origin;
  confirmRemoveOriginModal.classList.add("active");
}

function closeConfirmRemoveOriginModal() {
  confirmRemoveOriginModal.classList.remove("active");
  pendingRemoveOrigin = null;
}

// Remove allowed origin (called after confirmation)
async function removeAllowedOrigin(origin: string) {
  try {
    const result = await app!.callServerTool({
      name: "skill-config-remove-allowed-origin",
      arguments: { origin },
    });

    console.log("Remove origin result:", result);

    const structured = result.structuredContent as unknown as ConfigState;
    if (structured?.success) {
      updateState(structured);
      showToast(`Removed allowed origin: ${origin}`, "success");
    } else {
      showToast(structured?.error || "Failed to remove origin", "error");
    }
  } catch (error) {
    console.error("Remove origin error:", error);
    showToast((error as Error).message || "Failed to remove origin", "error");
  }
}

// Origin modal functions
function showOriginModal() {
  originNameInput.value = "";
  addOriginModal.classList.add("active");
  originNameInput.focus();
}

function closeOriginModal() {
  addOriginModal.classList.remove("active");
}

// Org modal functions
function showOrgModal() {
  orgNameInput.value = "";
  addOrgModal.classList.add("active");
  orgNameInput.focus();
}

function closeOrgModal() {
  addOrgModal.classList.remove("active");
}

// Modal functions
function showAddModal() {
  if (isOverridden) {
    showToast("Cannot add directories while override is active", "error");
    return;
  }
  directoryInput.value = "";
  addModal.classList.add("active");
  directoryInput.focus();
}

function closeAddModal() {
  addModal.classList.remove("active");
}

// Toast
function showToast(message: string, type: "success" | "error" = "success") {
  toast.textContent = message;
  toast.className = `toast ${type} visible`;
  setTimeout(() => {
    toast.classList.remove("visible");
  }, 3000);
}

// Utilities
function escapeHtml(str: string): string {
  if (!str) return "";
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c] || c
  );
}

// Set up event listeners
addBtn.addEventListener("click", showAddModal);
addModal.querySelector(".modal-close")?.addEventListener("click", closeAddModal);
addModal.querySelector(".btn-secondary")?.addEventListener("click", closeAddModal);
addSubmitBtn.addEventListener("click", addDirectory);
directoryInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    addDirectory();
  }
});

// Confirm remove modal event listeners
confirmRemoveBtn.addEventListener("click", async () => {
  if (pendingRemovePath) {
    const path = pendingRemovePath;
    closeConfirmRemoveModal();
    await removeDirectory(path);
  }
});
confirmRemoveCancel.addEventListener("click", closeConfirmRemoveModal);
confirmRemoveClose.addEventListener("click", closeConfirmRemoveModal);

// Confirm remove org modal event listeners
confirmRemoveOrgBtn.addEventListener("click", async () => {
  if (pendingRemoveOrg) {
    const org = pendingRemoveOrg;
    closeConfirmRemoveOrgModal();
    await removeAllowedOrg(org);
  }
});
confirmRemoveOrgCancel.addEventListener("click", closeConfirmRemoveOrgModal);
confirmRemoveOrgClose.addEventListener("click", closeConfirmRemoveOrgModal);

// Org modal event listeners
addOrgBtn.addEventListener("click", showOrgModal);
addOrgModal.querySelector(".modal-close")?.addEventListener("click", closeOrgModal);
addOrgModal.querySelector(".btn-secondary")?.addEventListener("click", closeOrgModal);
addOrgSubmitBtn.addEventListener("click", addAllowedOrg);
orgNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    addAllowedOrg();
  }
});

// Origin modal event listeners
addOriginBtn.addEventListener("click", showOriginModal);
addOriginModal.querySelector(".modal-close")?.addEventListener("click", closeOriginModal);
addOriginModal.querySelector(".btn-secondary")?.addEventListener("click", closeOriginModal);
addOriginSubmitBtn.addEventListener("click", addAllowedOrigin);
originNameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    addAllowedOrigin();
  }
});

// Confirm remove origin modal event listeners
confirmRemoveOriginBtn.addEventListener("click", async () => {
  if (pendingRemoveOrigin) {
    const origin = pendingRemoveOrigin;
    closeConfirmRemoveOriginModal();
    await removeAllowedOrigin(origin);
  }
});
confirmRemoveOriginCancel.addEventListener("click", closeConfirmRemoveOriginModal);
confirmRemoveOriginClose.addEventListener("click", closeConfirmRemoveOriginModal);

// Static mode toggle event listener
staticModeToggle?.addEventListener("change", (e) => {
  const enabled = (e.target as HTMLInputElement).checked;
  setStaticModeEnabled(enabled);
});

// 1. Create app instance
app = new App({ name: "Skills Config", version: "1.0.0" });

// 2. Register handlers BEFORE connecting
app.onteardown = async () => {
  console.info("App is being torn down");
  return {};
};

app.ontoolinput = (params) => {
  console.info("Received tool input:", params);
};

app.ontoolresult = (result) => {
  console.info("Received tool result:", result);
  if (result.structuredContent) {
    updateState(result.structuredContent as ConfigState);
  }
};

app.ontoolcancelled = (params) => {
  console.info("Tool call cancelled:", params.reason);
};

app.onerror = console.error;

app.onhostcontextchanged = handleHostContextChanged;

// 3. Connect to host
app.connect().then(() => {
  console.info("Connected to host");

  // Apply initial host context
  const ctx = app!.getHostContext();
  if (ctx) {
    handleHostContextChanged(ctx);
  }
});
