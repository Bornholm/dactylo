import type { LLMConfig, SystemPrompt, MCPServer } from "../shared/types.js";
import { storageGet, storageSet, generateId } from "../shared/storage.js";

// ─── Onglets ───────────────────────────────────────────────────────────────

const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
const tabContents = document.querySelectorAll<HTMLElement>(".tab-content");

tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    const target = tab.dataset["tab"];
    tabs.forEach((t) => {
      t.classList.toggle("active", t === tab);
      t.setAttribute("aria-selected", String(t === tab));
    });
    tabContents.forEach((section) => {
      section.hidden = section.id !== `tab-${target}`;
    });
  });
});

// ─── Toggle visibilité clés API ───────────────────────────────────────────

document.querySelectorAll<HTMLButtonElement>(".toggle-visibility").forEach((btn) => {
  btn.addEventListener("click", () => {
    const targetId = btn.dataset["target"];
    if (!targetId) return;
    const input = document.getElementById(targetId) as HTMLInputElement;
    input.type = input.type === "password" ? "text" : "password";
  });
});

// ─── Onglet LLM ──────────────────────────────────────────────────────────

const llmProvider = document.getElementById("llm-provider") as HTMLSelectElement;
const llmEndpoint = document.getElementById("llm-endpoint") as HTMLInputElement;
const llmApiKey = document.getElementById("llm-api-key") as HTMLInputElement;
const llmModel = document.getElementById("llm-model") as HTMLInputElement;
const llmTemperature = document.getElementById("llm-temperature") as HTMLInputElement;
const llmTempValue = document.getElementById("llm-temp-value") as HTMLSpanElement;
const llmMaxTokens = document.getElementById("llm-max-tokens") as HTMLInputElement;
const btnTestLLM = document.getElementById("btn-test-llm") as HTMLButtonElement;
const btnSaveLLM = document.getElementById("btn-save-llm") as HTMLButtonElement;
const llmStatus = document.getElementById("llm-status") as HTMLSpanElement;

async function loadLLMSettings() {
  const config = await storageGet("llm");
  llmProvider.value = config.provider ?? "openai";
  llmEndpoint.value = config.endpoint;
  llmApiKey.value = config.apiKey;
  llmModel.value = config.model;
  llmTemperature.value = String(config.temperature);
  llmTempValue.textContent = String(config.temperature);
  llmMaxTokens.value = String(config.maxTokens);
}

llmTemperature.addEventListener("input", () => {
  llmTempValue.textContent = llmTemperature.value;
});

btnSaveLLM.addEventListener("click", async () => {
  const config: LLMConfig = {
    provider: llmProvider.value as LLMConfig["provider"],
    endpoint: llmEndpoint.value.trim().replace(/\/$/, ""),
    apiKey: llmApiKey.value.trim(),
    model: llmModel.value.trim(),
    temperature: parseFloat(llmTemperature.value),
    maxTokens: parseInt(llmMaxTokens.value),
  };
  await storageSet("llm", config);
  showStatus(llmStatus, "Sauvegardé ✓", "success");
});

btnTestLLM.addEventListener("click", async () => {
  btnTestLLM.disabled = true;
  showStatus(llmStatus, "Test en cours…", "");

  const response = await browser.runtime.sendMessage({ action: "TEST_LLM_CONNECTION" }) as { success: boolean; error?: string };
  if (response.success) {
    showStatus(llmStatus, "Connexion réussie ✓", "success");
  } else {
    showStatus(llmStatus, `Échec : ${response.error}`, "error");
  }
  btnTestLLM.disabled = false;
});


// ─── Onglet Prompts ───────────────────────────────────────────────────────

const promptsList = document.getElementById("prompts-list") as HTMLDivElement;
const btnAddPrompt = document.getElementById("btn-add-prompt") as HTMLButtonElement;
const promptEditor = document.getElementById("prompt-editor") as HTMLDivElement;
const promptEditorTitle = document.getElementById("prompt-editor-title") as HTMLHeadingElement;
const promptNameInput = document.getElementById("prompt-name") as HTMLInputElement;
const promptContentInput = document.getElementById("prompt-content") as HTMLTextAreaElement;
const promptIsDefaultInput = document.getElementById("prompt-is-default") as HTMLInputElement;
const btnSavePrompt = document.getElementById("btn-save-prompt") as HTMLButtonElement;
const btnCancelPrompt = document.getElementById("btn-cancel-prompt") as HTMLButtonElement;

let editingPromptId: string | null = null;

async function loadPrompts() {
  const prompts = await storageGet("systemPrompts");
  promptsList.innerHTML = "";

  for (const prompt of prompts) {
    const item = document.createElement("div");
    item.className = `prompt-item${prompt.isDefault ? " is-default" : ""}`;
    item.dataset["id"] = prompt.id;
    item.innerHTML = `
      <div class="prompt-item-info">
        <div class="prompt-item-name">
          ${escapeHtml(prompt.name)}
          ${prompt.isDefault ? '<span class="badge-default">Défaut</span>' : ""}
        </div>
        <div class="prompt-item-preview">${escapeHtml(prompt.content.slice(0, 80))}…</div>
      </div>
      <div class="prompt-item-actions">
        <button class="btn btn-secondary btn-sm btn-set-default" data-id="${prompt.id}" ${prompt.isDefault ? "disabled" : ""}>Défaut</button>
        <button class="btn btn-secondary btn-sm btn-edit-prompt" data-id="${prompt.id}">Modifier</button>
        <button class="btn btn-danger btn-sm btn-delete-prompt" data-id="${prompt.id}" ${prompt.isDefault ? "disabled" : ""}>Supprimer</button>
      </div>
    `;
    promptsList.appendChild(item);
  }

  // Événements sur les items
  promptsList.querySelectorAll<HTMLButtonElement>(".btn-edit-prompt").forEach((btn) => {
    btn.addEventListener("click", () => openEditPrompt(btn.dataset["id"]!));
  });
  promptsList.querySelectorAll<HTMLButtonElement>(".btn-delete-prompt").forEach((btn) => {
    btn.addEventListener("click", () => deletePrompt(btn.dataset["id"]!));
  });
  promptsList.querySelectorAll<HTMLButtonElement>(".btn-set-default").forEach((btn) => {
    btn.addEventListener("click", () => setDefaultPrompt(btn.dataset["id"]!));
  });
}

btnAddPrompt.addEventListener("click", () => {
  editingPromptId = null;
  promptEditorTitle.textContent = "Nouveau prompt";
  promptNameInput.value = "";
  promptContentInput.value = "";
  promptIsDefaultInput.checked = false;
  promptEditor.hidden = false;
  promptNameInput.focus();
});

btnCancelPrompt.addEventListener("click", () => {
  promptEditor.hidden = true;
  editingPromptId = null;
});

btnSavePrompt.addEventListener("click", async () => {
  const name = promptNameInput.value.trim();
  const content = promptContentInput.value.trim();
  if (!name || !content) {
    alert("Le nom et le contenu sont requis.");
    return;
  }

  let prompts = await storageGet("systemPrompts");

  if (editingPromptId) {
    prompts = prompts.map((p) =>
      p.id === editingPromptId ? { ...p, name, content, isDefault: promptIsDefaultInput.checked || p.isDefault } : p
    );
  } else {
    const isDefault = promptIsDefaultInput.checked;
    if (isDefault) {
      prompts = prompts.map((p) => ({ ...p, isDefault: false }));
    }
    prompts.push({ id: generateId(), name, content, isDefault });
  }

  await storageSet("systemPrompts", prompts);
  promptEditor.hidden = true;
  editingPromptId = null;
  await loadPrompts();
});

async function openEditPrompt(id: string) {
  const prompts = await storageGet("systemPrompts");
  const prompt = prompts.find((p) => p.id === id);
  if (!prompt) return;

  editingPromptId = id;
  promptEditorTitle.textContent = "Modifier le prompt";
  promptNameInput.value = prompt.name;
  promptContentInput.value = prompt.content;
  promptIsDefaultInput.checked = prompt.isDefault;
  promptEditor.hidden = false;
  promptNameInput.focus();
}

async function deletePrompt(id: string) {
  if (!confirm("Supprimer ce prompt ?")) return;
  let prompts = await storageGet("systemPrompts");
  prompts = prompts.filter((p) => p.id !== id);
  await storageSet("systemPrompts", prompts);
  await loadPrompts();
}

async function setDefaultPrompt(id: string) {
  let prompts = await storageGet("systemPrompts");
  prompts = prompts.map((p) => ({ ...p, isDefault: p.id === id }));
  await storageSet("systemPrompts", prompts);
  await loadPrompts();
}

// ─── Onglet MCP ───────────────────────────────────────────────────────────

const mcpList = document.getElementById("mcp-list") as HTMLDivElement;
const btnAddMCP = document.getElementById("btn-add-mcp") as HTMLButtonElement;
const mcpEditor = document.getElementById("mcp-editor") as HTMLDivElement;
const mcpEditorTitle = document.getElementById("mcp-editor-title") as HTMLHeadingElement;
const mcpNameInput = document.getElementById("mcp-name") as HTMLInputElement;
const mcpUrlInput = document.getElementById("mcp-url") as HTMLInputElement;
const mcpHeadersList = document.getElementById("mcp-headers-list") as HTMLDivElement;
const btnAddMCPHeader = document.getElementById("btn-add-mcp-header") as HTMLButtonElement;
const btnSaveMCP = document.getElementById("btn-save-mcp") as HTMLButtonElement;
const btnCancelMCP = document.getElementById("btn-cancel-mcp") as HTMLButtonElement;
const mcpTestStatus = document.getElementById("mcp-test-status") as HTMLSpanElement;
const mcpGlobalStatus = document.getElementById("mcp-global-status") as HTMLSpanElement;

let editingMCPServerId: string | null = null;

function addMCPHeaderRow(name = "", value = "") {
  const row = document.createElement("div");
  row.className = "mcp-header-row";
  row.innerHTML = `
    <input type="text" class="mcp-header-name" placeholder="Nom (ex. Authorization)" value="${escapeHtml(name)}" />
    <input type="text" class="mcp-header-value" placeholder="Valeur (ex. Bearer token)" value="${escapeHtml(value)}" />
    <button type="button" class="btn btn-danger btn-sm btn-remove-header" title="Supprimer">×</button>
  `;
  row.querySelector<HTMLButtonElement>(".btn-remove-header")!.addEventListener("click", () => row.remove());
  mcpHeadersList.appendChild(row);
}

function collectMCPHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  mcpHeadersList.querySelectorAll<HTMLDivElement>(".mcp-header-row").forEach((row) => {
    const name = row.querySelector<HTMLInputElement>(".mcp-header-name")!.value.trim();
    const value = row.querySelector<HTMLInputElement>(".mcp-header-value")!.value.trim();
    if (name) headers[name] = value;
  });
  return headers;
}

btnAddMCPHeader.addEventListener("click", () => addMCPHeaderRow());

async function loadMCPServers() {
  const servers = await storageGet("mcpServers");
  mcpList.innerHTML = "";

  if (servers.length === 0) {
    mcpList.innerHTML = `<p style="color: var(--color-text-muted); font-size: 13px;">Aucun serveur MCP configuré.</p>`;
    return;
  }

  for (const server of servers) {
    const statusClass = server.lastStatus === "connected" ? "connected"
      : server.lastStatus === "error" ? "disconnected"
      : "unknown";

    const item = document.createElement("div");
    item.className = "mcp-item";
    item.innerHTML = `
      <div class="status-dot ${statusClass}" title="${server.lastStatus}"></div>
      <div class="mcp-item-info">
        <div class="mcp-item-name">${escapeHtml(server.name)}</div>
        <div class="mcp-item-url">${escapeHtml(server.url)}</div>
      </div>
      <div class="mcp-item-actions">
        <input type="checkbox" class="toggle-switch mcp-toggle" data-id="${server.id}" ${server.enabled ? "checked" : ""} title="${server.enabled ? "Activé" : "Désactivé"}" />
        <button class="btn btn-secondary btn-sm btn-test-mcp" data-id="${server.id}" data-url="${escapeHtml(server.url)}">Tester</button>
        <button class="btn btn-secondary btn-sm btn-edit-mcp" data-id="${server.id}">Modifier</button>
        <button class="btn btn-danger btn-sm btn-delete-mcp" data-id="${server.id}">Supprimer</button>
      </div>
    `;
    mcpList.appendChild(item);
  }

  mcpList.querySelectorAll<HTMLInputElement>(".mcp-toggle").forEach((toggle) => {
    toggle.addEventListener("change", () => toggleMCPServer(toggle.dataset["id"]!, toggle.checked));
  });
  mcpList.querySelectorAll<HTMLButtonElement>(".btn-test-mcp").forEach((btn) => {
    btn.addEventListener("click", () => testMCPServer(btn.dataset["id"]!, btn.dataset["url"]!));
  });
  mcpList.querySelectorAll<HTMLButtonElement>(".btn-edit-mcp").forEach((btn) => {
    btn.addEventListener("click", () => openEditMCPServer(btn.dataset["id"]!));
  });
  mcpList.querySelectorAll<HTMLButtonElement>(".btn-delete-mcp").forEach((btn) => {
    btn.addEventListener("click", () => deleteMCPServer(btn.dataset["id"]!));
  });
}

btnAddMCP.addEventListener("click", () => {
  editingMCPServerId = null;
  mcpEditorTitle.textContent = "Nouveau serveur MCP";
  btnSaveMCP.textContent = "Ajouter";
  mcpNameInput.value = "";
  mcpUrlInput.value = "";
  mcpHeadersList.innerHTML = "";
  mcpEditor.hidden = false;
  mcpNameInput.focus();
});

btnCancelMCP.addEventListener("click", () => {
  mcpEditor.hidden = true;
  editingMCPServerId = null;
  mcpNameInput.value = "";
  mcpUrlInput.value = "";
  mcpHeadersList.innerHTML = "";
});

btnSaveMCP.addEventListener("click", async () => {
  const name = mcpNameInput.value.trim();
  const url = mcpUrlInput.value.trim();
  if (!name || !url) {
    alert("Le nom et l'URL sont requis.");
    return;
  }

  const headers = collectMCPHeaders();

  showStatus(mcpTestStatus, "Test en cours…", "");
  const response = await browser.runtime.sendMessage({ action: "TEST_MCP_CONNECTION", url, headers }) as { success: boolean; error?: string };
  const lastStatus: MCPServer["lastStatus"] = response.success ? "connected" : "error";
  const isEditing = editingMCPServerId !== null;

  let servers = await storageGet("mcpServers");

  if (isEditing) {
    servers = servers.map((s) =>
      s.id === editingMCPServerId
        ? { ...s, name, url, lastStatus, ...(Object.keys(headers).length > 0 ? { headers } : { headers: undefined }) }
        : s
    );
  } else {
    servers.push({
      id: generateId(),
      name,
      url,
      enabled: true,
      lastStatus,
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    });
  }

  await storageSet("mcpServers", servers);

  // Fermer l'éditeur avant d'afficher le résultat (mcpTestStatus est dans l'éditeur)
  mcpEditor.hidden = true;
  mcpTestStatus.textContent = "";
  editingMCPServerId = null;
  mcpNameInput.value = "";
  mcpUrlInput.value = "";
  mcpHeadersList.innerHTML = "";
  await loadMCPServers();

  const verb = isEditing ? "Modifié" : "Ajouté";
  if (response.success) {
    showStatus(mcpGlobalStatus, `${verb} et connecté ✓`, "success");
  } else {
    showStatus(mcpGlobalStatus, `${verb} mais connexion échouée : ${response.error}`, "error");
  }
});

async function toggleMCPServer(id: string, enabled: boolean) {
  const servers = await storageGet("mcpServers");
  const updated = servers.map((s) => s.id === id ? { ...s, enabled } : s);
  await storageSet("mcpServers", updated);
}

async function testMCPServer(id: string, url: string) {
  showStatus(mcpGlobalStatus, "Test en cours…", "");
  const servers = await storageGet("mcpServers");
  const server = servers.find((s) => s.id === id);
  const response = await browser.runtime.sendMessage({
    action: "TEST_MCP_CONNECTION",
    url,
    ...(server?.headers ? { headers: server.headers } : {}),
  }) as { success: boolean; error?: string };
  const updated = servers.map((s) =>
    s.id === id ? { ...s, lastStatus: (response.success ? "connected" : "error") as MCPServer["lastStatus"] } : s
  );
  await storageSet("mcpServers", updated);
  await loadMCPServers();
  if (response.success) {
    showStatus(mcpGlobalStatus, "Connexion réussie ✓", "success");
  } else {
    showStatus(mcpGlobalStatus, `Connexion échouée : ${response.error}`, "error");
  }
}

async function deleteMCPServer(id: string) {
  if (!confirm("Supprimer ce serveur MCP ?")) return;
  const servers = await storageGet("mcpServers");
  await storageSet("mcpServers", servers.filter((s) => s.id !== id));
  await loadMCPServers();
}

async function openEditMCPServer(id: string) {
  const servers = await storageGet("mcpServers");
  const server = servers.find((s) => s.id === id);
  if (!server) return;

  editingMCPServerId = id;
  mcpEditorTitle.textContent = "Modifier le serveur MCP";
  btnSaveMCP.textContent = "Enregistrer";
  mcpNameInput.value = server.name;
  mcpUrlInput.value = server.url;
  mcpHeadersList.innerHTML = "";
  for (const [name, value] of Object.entries(server.headers ?? {})) {
    addMCPHeaderRow(name, value);
  }
  mcpEditor.hidden = false;
  mcpNameInput.focus();
}

// ─── Utilitaires ─────────────────────────────────────────────────────────

function showStatus(el: HTMLSpanElement, message: string, type: "success" | "error" | "") {
  el.textContent = message;
  el.className = `status-msg${type ? " " + type : ""}`;
  if (type) {
    setTimeout(() => { el.textContent = ""; el.className = "status-msg"; }, 4000);
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ─── Initialisation ───────────────────────────────────────────────────────

async function init() {
  await Promise.all([
    loadLLMSettings(),
    loadPrompts(),
    loadMCPServers(),
  ]);
}

init().catch(console.error);
