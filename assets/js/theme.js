// theme.js — tema perangkat/lokal; dimuat di <head> agar tidak flash terang.
"use strict";

const THEME_KEY = "catet.theme.v1";
const THEME_MEDIA = matchMedia("(prefers-color-scheme: dark)");
let themeMode = (() => {
  try {
    const saved = localStorage.getItem(THEME_KEY);
    return ["light", "dark", "system"].includes(saved) ? saved : "system";
  } catch { return "system"; }
})();

function effectiveTheme() {
  return themeMode === "system" ? (THEME_MEDIA.matches ? "dark" : "light") : themeMode;
}
function applyTheme() {
  const effective = effectiveTheme();
  document.documentElement.dataset.theme = effective;
  document.documentElement.style.colorScheme = effective;
  const btn = document.querySelector("#theme-toggle");
  if (!btn) return;
  btn.textContent = effective === "dark" ? "☀" : "☾";
  btn.setAttribute("aria-label", effective === "dark" ? "Gunakan tema terang" : "Gunakan tema gelap");
  btn.title = btn.getAttribute("aria-label");
  btn.setAttribute("aria-pressed", String(effective === "dark"));
}
function setThemeMode(mode) {
  themeMode = ["light", "dark", "system"].includes(mode) ? mode : "system";
  try { localStorage.setItem(THEME_KEY, themeMode); } catch { /* Sandboxed local preview keeps theme in memory. */ }
  applyTheme();
}
function toggleTheme() {
  setThemeMode(effectiveTheme() === "dark" ? "light" : "dark");
}
function initThemeToggle() {
  const btn = document.querySelector("#theme-toggle");
  if (btn) btn.onclick = toggleTheme;
  applyTheme();
}
THEME_MEDIA.addEventListener("change", () => { if (themeMode === "system") applyTheme(); });
applyTheme();
