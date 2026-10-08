import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { setupAuth } from "./auth.js?v=36";
import { populateSelect } from "./filters.js?v=1";
import { initCrumbs, applyUrlFilters, equipmentParams, equipmentSteps, EQUIPMENT_PAGES } from "./crumbs.js?v=2";
import { enableTapToExpandCells, enableScrollButtons, setupFilterToggle, onFilterChanged } from "./ui.js?v=3";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let currentRows = [];
let dashboardStarted = false;

const $ = (sel) => document.querySelector(sel);
// Тексты из базы вставляются в HTML — экранируем.
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function showError(msg) {
  const el = $("#errorBanner");
  el.textContent = msg;
  el.hidden = false;
}
function clearError() {
  $("#errorBanner").hidden = true;
}
function setLoading(on) {
  $("#loadingIndicator").style.display = on ? "block" : "none";
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function loadFilterOptions() {
  const objects = [...new Set(currentRows.map((r) => r.object).filter(Boolean))].sort();
  const mines = [...new Set(currentRows.map((r) => r.mine).filter(Boolean))].sort();
  const models = [...new Set(currentRows.map((r) => r.model).filter(Boolean))].sort();
  const codes = [...new Set(currentRows.map((r) => r.local_code).filter(Boolean))].sort();
  populateSelect("#filterObject", objects);
  populateSelect("#filterMine", mines);
  populateSelect("#filterModel", models);
  populateSelect("#filterCode", codes);
}

// Guards against a slower, older request resolving after a newer one and silently
// overwriting the UI with stale data — rapid successive Deadline/AvgDays changes
// each re-fetch from the server and can resolve out of order.
let loadRequestId = 0;

async function loadData() {
  const myRequestId = ++loadRequestId;
  clearError();
  setLoading(true);
  try {
    const deadline = $("#filterDeadline").value || todayIso();
    const avgDays = $("#filterAvgDays").value === "" ? 30 : Number($("#filterAvgDays").value);
    const { data, error } = await supabase.rpc("pm_forecast", { p_deadline: deadline, p_avg_days: avgDays });
    if (error) throw error;
    if (myRequestId !== loadRequestId) return;
    currentRows = data;
    loadFilterOptions();
    applyUrlFilters(equipmentSteps()); // пришли по крошкам с другой формы (один раз)
    applyFiltersAndRender();
  } catch (e) {
    if (myRequestId !== loadRequestId) return;
    showError("Ошибка загрузки данных: " + e.message);
  } finally {
    if (myRequestId === loadRequestId) setLoading(false);
  }
}

function applyFiltersAndRender() {
  const object = $("#filterObject").value;
  const mine = $("#filterMine").value;
  const model = $("#filterModel").value;
  const code = $("#filterCode").value;
  const overdue = $("#filterOverdue").value;

  let rows = currentRows;
  if (object) rows = rows.filter((r) => r.object === object);
  if (mine) rows = rows.filter((r) => r.mine === mine);
  if (model) rows = rows.filter((r) => r.model === model);
  if (code) rows = rows.filter((r) => r.local_code === code);
  if (overdue === "overdue") rows = rows.filter((r) => r.days_to_pm < 0);
  else if (overdue === "upcoming") rows = rows.filter((r) => r.days_to_pm >= 0);

  renderSummary(rows);
  renderTable(rows);
}

function renderSummary(rows) {
  const overdueCount = currentRows.filter((r) => r.days_to_pm < 0).length;
  const upcomingCount = currentRows.filter((r) => r.days_to_pm >= 0).length;
  $("#summaryCards").innerHTML = `
    <div class="summary-card"><div class="label">Всего ТО в периоде</div><div class="value">${currentRows.length}</div></div>
    <div class="summary-card"><div class="label">Просрочено</div><div class="value bad">${overdueCount}</div></div>
    <div class="summary-card"><div class="label">Предстоит</div><div class="value good">${upcomingCount}</div></div>
    <div class="summary-card"><div class="label">Показано (с фильтром)</div><div class="value">${rows.length}</div></div>
  `;
}

function dateLabel(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

function renderTable(rows) {
  $("#dataTableBody").innerHTML = rows
    .map(
      (r) => `
    <tr class="${r.days_to_pm < 0 ? "overdue-row" : ""}">
      <td>${esc(r.object ?? "—")}</td>
      <td>${esc(r.mine ?? "—")}</td>
      <td title="${esc(r.model ?? "")}">${esc(r.model ?? "—")}</td>
      <td>${esc(r.local_code ?? "—")}</td>
      <td>${esc(r.fs ?? "—")}</td>
      <td title="${esc(r.descr ?? "")}">${esc(r.descr ?? "—")}</td>
      <td>${r.step_number != null && r.cycle_length != null ? `${r.step_number}/${r.cycle_length}` : "—"}</td>
      <td>${dateLabel(r.pm_date)}</td>
      <td>${r.days_to_pm}</td>
    </tr>`
    )
    .join("");
}

function exportExcel() {
  const wsData = currentRows.map((r) => ({
    Объект: r.object,
    Шахта: r.mine,
    Модель: r.model,
    Борт: r.local_code,
    FS: r.fs,
    "Тип ТО": r.descr,
    "Шаг цикла": r.step_number != null && r.cycle_length != null ? `${r.step_number}/${r.cycle_length}` : "",
    "Дата ТО": dateLabel(r.pm_date),
    "Дней до ТО": r.days_to_pm,
  }));
  const ws = XLSX.utils.json_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Прогноз ТО");
  XLSX.writeFile(wb, `to_forecast_${todayIso()}.xlsx`);
}

function initDashboard() {
  if (dashboardStarted) return;
  dashboardStarted = true;
  enableTapToExpandCells();
  enableScrollButtons();

  const in30Days = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  $("#filterDeadline").value = in30Days;

  setupFilterToggle(loadData);
  initCrumbs($("#crumbs"), EQUIPMENT_PAGES, "to-forecast.html", equipmentParams());
  $("#filterDeadline").addEventListener("change", () => onFilterChanged(loadData));
  $("#filterAvgDays").addEventListener("change", () => onFilterChanged(loadData));
  for (const id of ["#filterObject", "#filterMine", "#filterModel", "#filterCode", "#filterOverdue"]) {
    $(id).addEventListener("change", () => onFilterChanged(applyFiltersAndRender));
  }
  $("#resetFilters").addEventListener("click", () => {
    $("#filterDeadline").value = in30Days;
    $("#filterAvgDays").value = "30";
    $("#filterObject").value = "";
    $("#filterMine").value = "";
    $("#filterModel").value = "";
    $("#filterCode").value = "";
    $("#filterOverdue").value = "";
    loadData();
    $("#filterPanel").classList.remove("open");
  });

  $("#exportExcel").addEventListener("click", exportExcel);

  loadData();
}

setupAuth(supabase, "to-forecast.html", () => initDashboard());
