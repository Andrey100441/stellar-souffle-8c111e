import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { setupAuth } from "./auth.js?v=36";
import { populateSelect, loadEquipmentList, updateMineOptions, updateModelAndCodeOptions } from "./filters.js?v=1";
import { initCrumbs, applyUrlFilters, equipmentParams, equipmentSteps, EQUIPMENT_PAGES } from "./crumbs.js?v=2";
import { enableTapToExpandCells, enableScrollButtons, setupFilterToggle, onFilterChanged } from "./ui.js?v=3";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const MONTHS_RU_FULL = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];

let equipmentList = [];
let planRows = []; // flat rows from v_plan_indicators
let planMtbs = null; // MTBS план открытой в окне строки — поле убрано со страницы, значение сохраняется как было
let dashboardStarted = false;

const $ = (sel) => document.querySelector(sel);

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
function fmtNum(v, digits = 1) {
  return v === null || v === undefined
    ? "—"
    : Number(v).toLocaleString("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

async function loadFilterOptions() {
  // Справочник и список лет не зависят друг от друга — запрашиваем одновременно.
  const yearsP = supabase.from("v_plan_years").select("reporting_year").order("reporting_year", { ascending: false }).then((res) => res);
  equipmentList = await loadEquipmentList(supabase);
  const objects = [...new Set(equipmentList.map((d) => d.object).filter(Boolean))].sort();
  populateSelect("#filterObject", objects);
  updateMineOptions(equipmentList);
  updateModelAndCodeOptions(equipmentList);

  const { data: years, error } = await yearsP;
  if (error) {
    showError("Не удалось загрузить список лет: " + error.message);
  } else {
    const currentYear = new Date().getFullYear();
    const yearSet = new Set([...years.map((y) => y.reporting_year), currentYear, currentYear + 1]);
    populateSelect("#filterYear", [...yearSet].sort((a, b) => b - a));
    populateSelect("#pfYear", [...yearSet].sort((a, b) => b - a));
  }

  const monthSel = $("#filterMonth");
  monthSel.innerHTML = '<option value="">Все</option>';
  for (let m = 1; m <= 12; m++) {
    const opt = document.createElement("option");
    opt.value = m;
    opt.textContent = MONTHS_RU_FULL[m - 1];
    monthSel.appendChild(opt);
  }
}

// prefetched — уже отправленный запрос v_plan_indicators (при открытии страницы он идёт
// одновременно со справочниками, см. ниже); без аргумента — обычная перезагрузка.
async function loadData(prefetched) {
  clearError();
  setLoading(true);
  try {
    const { data, error } = await (prefetched || supabase.from("v_plan_indicators").select("*"));
    if (error) throw error;
    planRows = data;
    render();
  } catch (e) {
    showError("Ошибка загрузки данных: " + e.message);
  } finally {
    setLoading(false);
  }
}

// Борт -> Модель -> Период, all ascending, so scrolling down checks machines in order.
function sortByCodeModelPeriod(a, b) {
  return (
    String(a.local_code ?? "").trim().localeCompare(String(b.local_code ?? "").trim(), undefined, { numeric: true }) ||
    String(a.model ?? "").trim().localeCompare(String(b.model ?? "").trim()) ||
    (a.reporting_year ?? 0) - (b.reporting_year ?? 0) ||
    (a.reporting_month_num ?? 0) - (b.reporting_month_num ?? 0)
  );
}

function matchesEquipmentFilters(row) {
  const object = $("#filterObject").value;
  const mine = $("#filterMine").value;
  const model = $("#filterModel").value;
  const code = $("#filterCode").value;
  if (object && row.object !== object) return false;
  if (mine && row.mine !== mine) return false;
  if (model && row.model !== model) return false;
  if (code && row.local_code !== code) return false;
  return true;
}

function render() {
  const year = $("#filterYear").value;
  const month = $("#filterMonth").value;

  if (year && month) {
    renderCompletenessView(Number(year), Number(month));
  } else {
    renderLogView(year, month);
  }
}

function renderCompletenessView(year, month) {
  $("#hintText").textContent = `Показаны все активные машины за ${MONTHS_RU_FULL[month - 1]} ${year} — видно, у кого план уже заполнен, а у кого нет.`;

  const planByCod = new Map();
  for (const r of planRows) {
    if (r.reporting_year === year && r.reporting_month_num === month) planByCod.set(r.cod, r);
  }

  const machines = equipmentList.filter(matchesEquipmentFilters);
  const rows = machines.map((m) => {
    const plan = planByCod.get(m.cod);
    return { ...m, ...plan, hasPlan: !!plan, reporting_year: year, reporting_month_num: month };
  });
  rows.sort(sortByCodeModelPeriod);

  renderSummary(rows.filter((r) => r.hasPlan).length, rows.length);
  renderTable(rows, true);
}

function renderLogView(year, month) {
  $("#hintText").textContent = "Показан журнал уже заполненных показателей. Выберите год и месяц одновременно, чтобы увидеть, какие машины ещё не заполнены.";

  let rows = planRows.filter(matchesEquipmentFilters);
  if (year) rows = rows.filter((r) => r.reporting_year === Number(year));
  if (month) rows = rows.filter((r) => r.reporting_month_num === Number(month));
  rows = rows.map((r) => ({ ...r, hasPlan: true }));
  rows.sort(sortByCodeModelPeriod);

  renderSummary(rows.length, null);
  renderTable(rows, false);
}

function renderSummary(filled, totalActive) {
  const cards = [];
  if (totalActive != null) {
    cards.push(`<div class="summary-card"><div class="label">Заполнено</div><div class="value">${filled} из ${totalActive}</div></div>`);
    cards.push(`<div class="summary-card"><div class="label">Не заполнено</div><div class="value">${totalActive - filled}</div></div>`);
  } else {
    cards.push(`<div class="summary-card"><div class="label">Записей в журнале</div><div class="value">${filled}</div></div>`);
  }
  $("#summaryCards").innerHTML = cards.join("");
}

function renderTable(rows, showPeriodFromContext) {
  $("#dataTableBody").innerHTML = rows
    .map((r) => {
      const periodLabel = r.reporting_year && r.reporting_month_num ? `${MONTHS_RU_FULL[r.reporting_month_num - 1]} ${r.reporting_year}` : "—";
      const rowClass = r.hasPlan ? "" : "plan-missing-row";
      const actionBtn = r.hasPlan
        ? `<button class="btn-secondary btn-small edit-plan-btn" data-cod="${r.cod}" data-year="${r.reporting_year}" data-month="${r.reporting_month_num}">Изменить</button>`
        : `<button class="btn-primary btn-small fill-plan-btn" data-cod="${r.cod}" data-year="${r.reporting_year}" data-month="${r.reporting_month_num}">Заполнить</button>`;
      return `
    <tr class="${rowClass}">
      <td>${r.local_code ?? "—"}</td>
      <td title="${r.model ?? ""}">${r.model ?? "—"}</td>
      <td>${r.mine ?? "—"}</td>
      <td>${r.object ?? "—"}</td>
      <td>${periodLabel}</td>
      <td>${fmtNum(r.smh)}</td>
      <td>${fmtNum(r.budget)}</td>
      <td>${r.plan_availability != null ? fmtNum(r.plan_availability * 100) + "%" : "—"}</td>
      <td>${fmtNum(r.mtbf, 0)}</td>
      <td>${fmtNum(r.mttr, 0)}</td>
      <td>${fmtNum(r.cost_per_hour)}</td>
      <td>${actionBtn}</td>
    </tr>`;
    })
    .join("");

  for (const btn of $("#dataTableBody").querySelectorAll(".fill-plan-btn, .edit-plan-btn")) {
    btn.addEventListener("click", () => {
      const cod = Number(btn.dataset.cod);
      const year = btn.dataset.year ? Number(btn.dataset.year) : null;
      const month = btn.dataset.month ? Number(btn.dataset.month) : null;
      openPlanModal(cod, year, month);
    });
  }
}

function populatePlanFormEquipmentSelects() {
  const objects = [...new Set(equipmentList.map((d) => d.object).filter(Boolean))].sort();
  const sel = (id) => $(id);
  sel("#pfObject").innerHTML = '<option value="">Выберите</option>' + objects.map((o) => `<option value="${o}">${o}</option>`).join("");
  updatePlanFormMines();
  updatePlanFormModelsAndCodes();
}

function updatePlanFormMines() {
  const object = $("#pfObject").value;
  const source = object ? equipmentList.filter((d) => d.object === object) : equipmentList;
  const mines = [...new Set(source.map((d) => d.mine).filter(Boolean))].sort();
  $("#pfMine").innerHTML = '<option value="">Выберите</option>' + mines.map((m) => `<option value="${m}">${m}</option>`).join("");
}

function updatePlanFormModelsAndCodes() {
  const object = $("#pfObject").value;
  const mine = $("#pfMine").value;
  let source = equipmentList;
  if (object) source = source.filter((d) => d.object === object);
  if (mine) source = source.filter((d) => d.mine === mine);
  const models = [...new Set(source.map((d) => d.model).filter(Boolean))].sort();
  $("#pfModel").innerHTML = '<option value="">Выберите</option>' + models.map((m) => `<option value="${m}">${m}</option>`).join("");

  populatePfCode(source);
}

// Only rebuilds the Борт/код list — used when the model itself changes, so
// picking a model doesn't also regenerate (and reset) the model select.
function updatePlanFormCodes() {
  const object = $("#pfObject").value;
  const mine = $("#pfMine").value;
  const model = $("#pfModel").value;
  let source = equipmentList;
  if (object) source = source.filter((d) => d.object === object);
  if (mine) source = source.filter((d) => d.mine === mine);
  if (model) source = source.filter((d) => d.model === model);
  populatePfCode(source);
}

function populatePfCode(source) {
  const codes = [...new Set(source.map((d) => d.local_code).filter(Boolean))].sort();
  $("#pfCode").innerHTML = '<option value="">Выберите</option>' + codes.map((c) => `<option value="${c}">${c}</option>`).join("");
}

function resolveCod() {
  const object = $("#pfObject").value;
  const mine = $("#pfMine").value;
  const model = $("#pfModel").value;
  const code = $("#pfCode").value;
  const match = equipmentList.find((d) => d.object === object && d.mine === mine && d.model === model && d.local_code === code);
  return match ? match.cod : null;
}

function openPlanModal(cod, year, month) {
  $("#planFormError").hidden = true;
  populatePlanFormEquipmentSelects();

  const machine = cod ? equipmentList.find((m) => m.cod === cod) : null;
  const existing = cod && year && month ? planRows.find((r) => r.cod === cod && r.reporting_year === year && r.reporting_month_num === month) : null;

  if (machine) {
    $("#pfObject").value = machine.object ?? "";
    updatePlanFormMines();
    $("#pfMine").value = machine.mine ?? "";
    updatePlanFormModelsAndCodes();
    $("#pfModel").value = machine.model ?? "";
    updatePlanFormCodes();
    $("#pfCode").value = machine.local_code ?? "";
  } else {
    // Opened via the generic "+ Заполнить показатели" button — carry over
    // whatever the page's own filters are already set to, so the user
    // doesn't have to repeat the same picks in the modal.
    $("#pfObject").value = $("#filterObject").value;
    updatePlanFormMines();
    $("#pfMine").value = $("#filterMine").value;
    updatePlanFormModelsAndCodes();
    $("#pfModel").value = $("#filterModel").value;
    updatePlanFormCodes();
    $("#pfCode").value = $("#filterCode").value;
  }
  $("#pfYear").value = year || $("#filterYear").value || new Date().getFullYear();
  $("#pfMonth").value = month || $("#filterMonth").value || new Date().getMonth() + 1;

  $("#pfSmh").value = existing?.smh ?? "";
  $("#pfBudget").value = existing?.budget ?? "";
  $("#pfAvailability").value = existing?.plan_availability ?? "";
  $("#pfMtbf").value = existing?.mtbf ?? "";
  $("#pfMttr").value = existing?.mttr ?? "";
  planMtbs = existing?.mtbs ?? null; // MTBS со страницы убран (не используется) — сохранённое значение не затираем
  $("#pfCostPerHour").value = existing?.cost_per_hour ?? "";

  $("#planModalTitle").textContent = existing ? "Изменить показатели" : "Заполнить показатели";
  $("#planModal").hidden = false;
}

function closePlanModal() {
  $("#planModal").hidden = true;
}

async function submitPlanForm(e) {
  e.preventDefault();
  const cod = resolveCod();
  const errEl = $("#planFormError");
  if (!cod) {
    errEl.textContent = "Не удалось определить машину — проверьте выбор Объект/Шахта/Модель/Борт";
    errEl.hidden = false;
    return;
  }
  const year = Number($("#pfYear").value);
  const month = Number($("#pfMonth").value);
  const reportingMonth = `${year}-${String(month).padStart(2, "0")}-01`;

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  const { error } = await supabase.rpc("set_plan_indicator", {
    p_cod: cod,
    p_reporting_month: reportingMonth,
    p_smh: $("#pfSmh").value === "" ? null : Number($("#pfSmh").value),
    p_budget: $("#pfBudget").value === "" ? null : Number($("#pfBudget").value),
    p_plan_availability: $("#pfAvailability").value === "" ? null : Number($("#pfAvailability").value),
    p_mtbf: $("#pfMtbf").value === "" ? null : Number($("#pfMtbf").value),
    p_mttr: $("#pfMttr").value === "" ? null : Number($("#pfMttr").value),
    p_mtbs: planMtbs,
    p_cost_per_hour: $("#pfCostPerHour").value === "" ? null : Number($("#pfCostPerHour").value),
  });
  submitBtn.disabled = false;

  if (error) {
    errEl.textContent = error.message;
    errEl.hidden = false;
    return;
  }
  closePlanModal();
  await loadData();
}

const TEMPLATE_HEADERS = ["Борт", "Модель", "Шахта", "Объект", "Год", "Месяц", "SMH план", "Бюджет", "Доступность план", "MTBF план", "MTTR план", "Cost per hour"];

function downloadTemplate() {
  const exampleRow = {
    "Борт": "104", "Модель": "CAT773E", "Шахта": "Аралтобе", "Объект": "ЕХУ", "Год": 2025, "Месяц": 1,
    "SMH план": 500, "Бюджет": 20000, "Доступность план": 0.8, "MTBF план": 150,
    "MTTR план": 5, "Cost per hour": 30,
  };
  const ws = XLSX.utils.json_to_sheet([exampleRow], { header: TEMPLATE_HEADERS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "План");
  XLSX.writeFile(wb, "plan_indicators_template.xlsx");
}

async function handleExcelFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  $("#importModal").hidden = false;
  $("#importSummary").innerHTML = `Импорт ${rows.length} строк…`;

  let created = 0;
  let updated = 0;
  const errors = [];
  for (const [i, row] of rows.entries()) {
    const localCode = String(row["Борт"] ?? "").trim();
    const model = String(row["Модель"] ?? "").trim();
    const mine = String(row["Шахта"] ?? "").trim();
    const object = String(row["Объект"] ?? "").trim();
    const year = Number(row["Год"]);
    const month = Number(row["Месяц"]);

    if (!localCode || !model || !mine || !year || !month) {
      errors.push(`Строка ${i + 2}: не заполнены обязательные поля (Борт/Модель/Шахта/Год/Месяц)`);
      continue;
    }
    let matches = equipmentList.filter(
      (d) =>
        String(d.local_code ?? "").trim() === localCode &&
        String(d.model ?? "").trim() === model &&
        String(d.mine ?? "").trim() === mine
    );
    if (matches.length > 1 && object) {
      matches = matches.filter((d) => String(d.object ?? "").trim() === object);
    }
    if (matches.length === 0) {
      errors.push(`Строка ${i + 2}: машина не найдена (борт "${localCode}", модель "${model}", шахта "${mine}"${object ? `, объект "${object}"` : ""})`);
      continue;
    }
    if (matches.length > 1) {
      errors.push(`Строка ${i + 2}: неоднозначно, найдено ${matches.length} машин с бортом "${localCode}", моделью "${model}", шахтой "${mine}" — заполните колонку "Объект", чтобы уточнить`);
      continue;
    }

    const { data, error } = await supabase.rpc("set_plan_indicator", {
      p_cod: matches[0].cod,
      p_reporting_month: `${year}-${String(month).padStart(2, "0")}-01`,
      p_smh: row["SMH план"] === "" ? null : Number(row["SMH план"]),
      p_budget: row["Бюджет"] === "" ? null : Number(row["Бюджет"]),
      p_plan_availability: row["Доступность план"] === "" ? null : Number(row["Доступность план"]),
      p_mtbf: row["MTBF план"] === "" ? null : Number(row["MTBF план"]),
      p_mttr: row["MTTR план"] === "" ? null : Number(row["MTTR план"]),
      // MTBS со страницы убран; старые файлы с колонкой «MTBS план» по-прежнему загружаются.
      p_mtbs: row["MTBS план"] == null || row["MTBS план"] === "" ? null : Number(row["MTBS план"]),
      p_cost_per_hour: row["Cost per hour"] === "" ? null : Number(row["Cost per hour"]),
    });
    if (error) errors.push(`Строка ${i + 2} (${localCode}): ${error.message}`);
    else if (data === "updated") updated++;
    else created++;
  }

  $("#importSummary").innerHTML = `
    <p>Создано новых записей: <strong>${created}</strong>, обновлено существующих: <strong>${updated}</strong> (из ${rows.length} строк)</p>
    ${errors.length ? `<p class="import-errors-title">Ошибки:</p><ul class="import-errors-list">${errors.map((e) => `<li>${e}</li>`).join("")}</ul>` : ""}
  `;
  await loadData();
}

// Каскад списков после выбора объекта/шахты/модели (как в обработчиках change ниже).
const cascade = (level) => {
  if (level === "object") updateMineOptions(equipmentList);
  updateModelAndCodeOptions(equipmentList);
};

function initDashboard() {
  if (dashboardStarted) return;
  dashboardStarted = true;
  enableTapToExpandCells();
  enableScrollButtons();

  setupFilterToggle(render);
  initCrumbs($("#crumbs"), EQUIPMENT_PAGES, "plan-indicators.html", equipmentParams());
  for (const id of ["#filterYear", "#filterMonth", "#filterObject", "#filterMine", "#filterModel", "#filterCode"]) {
    $(id).addEventListener("change", () => {
      if (id === "#filterObject") {
        updateMineOptions(equipmentList);
        updateModelAndCodeOptions(equipmentList);
      } else if (id === "#filterMine" || id === "#filterModel") {
        updateModelAndCodeOptions(equipmentList);
      }
      onFilterChanged(render);
    });
  }
  $("#resetFilters").addEventListener("click", () => {
    for (const id of ["#filterYear", "#filterMonth", "#filterObject", "#filterMine", "#filterModel", "#filterCode"]) {
      $(id).value = "";
    }
    updateMineOptions(equipmentList);
    updateModelAndCodeOptions(equipmentList);
    render();
    $("#filterPanel").classList.remove("open");
  });

  $("#addPlanBtn").addEventListener("click", () => openPlanModal(null, null, null));
  $("#planModalClose").addEventListener("click", closePlanModal);
  $("#planCancelBtn").addEventListener("click", closePlanModal);
  $("#planModal").addEventListener("click", (e) => {
    if (e.target.id === "planModal") closePlanModal();
  });
  $("#planForm").addEventListener("submit", submitPlanForm);
  $("#pfObject").addEventListener("change", () => {
    updatePlanFormMines();
    updatePlanFormModelsAndCodes();
  });
  $("#pfMine").addEventListener("change", updatePlanFormModelsAndCodes);
  $("#pfModel").addEventListener("change", updatePlanFormCodes);

  $("#downloadTemplateBtn").addEventListener("click", downloadTemplate);
  $("#excelImportBtn").addEventListener("click", () => $("#excelFileInput").click());
  $("#excelFileInput").addEventListener("change", (e) => {
    const file = e.target.files[0];
    if (file) handleExcelFile(file);
    e.target.value = "";
  });
  $("#importModalClose").addEventListener("click", () => ($("#importModal").hidden = true));
  $("#importModal").addEventListener("click", (e) => {
    if (e.target.id === "importModal") $("#importModal").hidden = true;
  });

  // Сами показатели от фильтров не зависят — запрос уходит сразу, одновременно со
  // справочниками; отрисовка (ей нужен справочник оборудования) — после обоих.
  const planP = supabase.from("v_plan_indicators").select("*").then((res) => res);
  loadFilterOptions().then(() => {
    applyUrlFilters(equipmentSteps("#filterCode", cascade)); // пришли по крошкам с другой формы
    return loadData(planP);
  });
}

setupAuth(supabase, "plan-indicators.html", () => initDashboard());
