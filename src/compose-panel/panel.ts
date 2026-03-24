import type { BackgroundMessage, BackgroundResponse, PopupMessage, AssistMode, ComposeContext } from "../shared/types.js";
import { getComposeState, setComposeState, storageGet } from "../shared/storage.js";

// Textes pré-remplis par mode (l'utilisateur peut les modifier)
const MODE_PRESETS: Record<AssistMode, string> = {
  improve: "Améliore le style et la clarté du texte en conservant le sens original.",
  correct: "Corrige les fautes d'orthographe, de grammaire et de ponctuation.",
  compose: "Rédige un courriel professionnel selon les instructions ci-dessous :",
};

// ─── État ─────────────────────────────────────────────────────────────────

let currentTabId = -1;
let currentMode: AssistMode = "improve";

// ─── Éléments DOM ─────────────────────────────────────────────────────────

const promptSelect     = document.getElementById("prompt-select")     as HTMLSelectElement;
const modeBtns         = document.querySelectorAll<HTMLButtonElement>(".mode-btn");
const instructionInput = document.getElementById("instruction-input") as HTMLTextAreaElement;
const btnRun           = document.getElementById("btn-run")           as HTMLButtonElement;
const btnCancel        = document.getElementById("btn-cancel")        as HTMLButtonElement;
const loader           = document.getElementById("loader")            as HTMLDivElement;
const updateToast      = document.getElementById("update-toast")      as HTMLDivElement;
const errorBanner      = document.getElementById("error-banner")      as HTMLDivElement;
const errorMessage     = document.getElementById("error-message")     as HTMLSpanElement;

// ─── Construction du prompt utilisateur ───────────────────────────────────

function buildUserMessage(instruction: string, ctx: ComposeContext): string {
  const lines: string[] = [instruction];

  const meta: string[] = [];
  if (ctx.to?.length)              meta.push(`Destinataire(s) : ${ctx.to.join(", ")}`);
  if (ctx.cc?.length)              meta.push(`Copie (CC) : ${ctx.cc.join(", ")}`);
  if (ctx.bcc?.length)             meta.push(`Copie cachée (BCC) : ${ctx.bcc.join(", ")}`);
  if (ctx.subject)                 meta.push(`Objet : ${ctx.subject}`);
  if (ctx.attachmentNames?.length) meta.push(`Pièces jointes : ${ctx.attachmentNames.join(", ")}`);

  if (meta.length > 0) {
    lines.push("\nContexte du courriel :\n" + meta.map(m => `- ${m}`).join("\n"));
  }

  if (ctx.thread) {
    lines.push("\nMessage auquel tu réponds (thread) :\n" + ctx.thread);
  }

  if (ctx.content) {
    lines.push("\nBrouillon en cours :\n" + ctx.content);
  } else if (ctx.thread) {
    lines.push("\nBrouillon en cours : (vide — à rédiger)");
  }

  return lines.join("\n");
}

// ─── Initialisation ────────────────────────────────────────────────────────

async function init() {
  const tabs = await browser.tabs.query({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab?.id) { showError("Impossible de récupérer l'onglet actif."); return; }
  currentTabId = tab.id;

  const state = await getComposeState(currentTabId);
  currentMode = state.selectedMode;
  instructionInput.value = state.pendingInstruction;

  await loadPrompts(state.selectedPromptId);
  applyMode(currentMode, false);

  browser.runtime.onMessage.addListener((raw: unknown) => {
    handleBackgroundMessage(raw as PopupMessage);
  });

  document.getElementById("btn-close-error")?.addEventListener("click", hideError);

  promptSelect.addEventListener("change", persist);
  instructionInput.addEventListener("input", persist);
  modeBtns.forEach(btn => btn.addEventListener("click", () => {
    applyMode(btn.dataset["mode"] as AssistMode, true);
  }));
  btnRun.addEventListener("click", onRun);
  btnCancel.addEventListener("click", onCancel);
}

// ─── Chargement des prompts ────────────────────────────────────────────────

async function loadPrompts(selectedId: string | null) {
  const prompts = await storageGet("systemPrompts");
  promptSelect.innerHTML = "";
  for (const p of prompts) {
    const opt = document.createElement("option");
    opt.value = p.id;
    opt.textContent = p.name;
    if (p.id === selectedId || (!selectedId && p.isDefault)) {
      opt.selected = true;
    }
    promptSelect.appendChild(opt);
  }
}

// ─── Gestion du mode ───────────────────────────────────────────────────────

function applyMode(mode: AssistMode, prefill: boolean) {
  currentMode = mode;
  modeBtns.forEach(btn => btn.classList.toggle("active", btn.dataset["mode"] === mode));

  if (prefill) {
    instructionInput.value = MODE_PRESETS[mode];
    instructionInput.focus();
    instructionInput.select();
  }

  persist();
}

// ─── Action LLM ────────────────────────────────────────────────────────────

async function onRun() {
  hideError();
  hideToast();

  const instruction = instructionInput.value.trim();
  if (!instruction) {
    showError("Saisissez des instructions avant de lancer.");
    instructionInput.focus();
    return;
  }

  const res = await sendMessage({ action: "GET_COMPOSE_CONTENT", tabId: currentTabId }) as BackgroundResponse;
  if (!res.success) { showError(res.error); return; }

  const ctx = res as ComposeContext;
  const userMessage = buildUserMessage(instruction, ctx);

  const prompts = await storageGet("systemPrompts");
  const prompt = prompts.find(p => p.id === promptSelect.value) ?? prompts[0];
  if (!prompt) { showError("Aucun prompt système configuré. Ouvrez les paramètres."); return; }

  // Préfixer le prompt système avec l'identité de l'auteur pour ancrer le rôle du LLM
  const authorPrefix = ctx.from
    ? `Tu écris au nom de : ${ctx.from}.\n\n`
    : "";
  const systemPrompt = authorPrefix + prompt.content;

  setStreaming(true);

  try {
    const result = await sendMessage({
      action: "LLM_REQUEST",
      tabId: currentTabId,
      systemPrompt,
      userMessage,
      history: [],
      mode: currentMode,
    }) as BackgroundResponse;

    setStreaming(false);
    if (!result.success) showError(result.error);
  } catch (e) {
    setStreaming(false);
    showError(String(e));
  }
}

function onCancel() {
  sendMessage({ action: "LLM_CANCEL", tabId: currentTabId });
  setStreaming(false);
}

// ─── Messages du background ────────────────────────────────────────────────

function handleBackgroundMessage(msg: PopupMessage) {
  if (msg.action === "EMAIL_UPDATED") {
    showToast();
  } else if (msg.action === "BACKGROUND_ERROR") {
    setStreaming(false);
    showError(msg.message);
  }
}

// ─── État streaming ────────────────────────────────────────────────────────

let keepaliveInterval: ReturnType<typeof setInterval> | null = null;

function setStreaming(on: boolean) {
  btnRun.hidden = on;
  btnCancel.hidden = !on;
  loader.hidden = !on;
  promptSelect.disabled = on;
  modeBtns.forEach(btn => (btn.disabled = on));
  instructionInput.disabled = on;

  if (on) {
    // Envoyer un KEEPALIVE toutes les 20s pour maintenir la page background active
    // (Firefox MV3 termine les event pages après 30s sans événement WebExtension)
    keepaliveInterval = setInterval(() => {
      sendMessage({ action: "KEEPALIVE" }).catch(() => {});
    }, 20_000);
  } else {
    if (keepaliveInterval !== null) {
      clearInterval(keepaliveInterval);
      keepaliveInterval = null;
    }
  }
}

// ─── Toast / erreur ────────────────────────────────────────────────────────

let toastTimer: ReturnType<typeof setTimeout> | null = null;

function showToast() {
  updateToast.hidden = false;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { updateToast.hidden = true; }, 3000);
}

function hideToast() {
  if (toastTimer) { clearTimeout(toastTimer); toastTimer = null; }
  updateToast.hidden = true;
}

function showError(msg: string) {
  errorMessage.textContent = msg;
  errorBanner.hidden = false;
}

function hideError() { errorBanner.hidden = true; }

// ─── Persistance ───────────────────────────────────────────────────────────

function persist() {
  setComposeState(currentTabId, {
    selectedPromptId: promptSelect.value,
    selectedMode: currentMode,
    conversationHistory: [],
    pendingInstruction: instructionInput.value,
  }).catch(() => {});
}

function sendMessage(msg: BackgroundMessage): Promise<unknown> {
  return browser.runtime.sendMessage(msg);
}

// ─── Démarrage ─────────────────────────────────────────────────────────────

init().catch(e => console.error("Dactylo init error:", e));
