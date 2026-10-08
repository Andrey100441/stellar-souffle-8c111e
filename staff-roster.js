import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { setupAuth } from "./auth.js?v=36";
import { guardUnsaved, snapshot } from "./unsaved.js?v=1";
import { enableTapToExpandCells, enableScrollButtons, setupFilterToggle, onFilterChanged } from "./ui.js?v=3";
import { populateSelect, loadEquipmentList } from "./filters.js?v=1";
import { initCrumbs, applyUrlFilters, urlParam, STAFF_PAGES } from "./crumbs.js?v=2";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let currentRows = [];
let objectOptions = [];
let dashboardStarted = false;

const $ = (sel) => document.querySelector(sel);

// График работы — для оценки риска выгорания на «Персонале» (staff-details.js).
// Значения по умолчанию подставляются при выборе типа: [рабочих дней, дней отдыха, часов смены].
const SCHEDULES = {
  vahta: { name: "Вахта", def: [15, 15, 12] },
  "5x2": { name: "5/2 пн–пт", def: [5, 2, 8] },
  "5x2_sliding": { name: "5/2 скользящий", def: [5, 2, 8] },
  shift: { name: "Сменный", def: [2, 2, 12] },
};
function scheduleLabel(r) {
  const sc = SCHEDULES[r.work_schedule];
  if (!sc) return "—";
  const cycle = r.work_schedule.startsWith("5x2") && r.days_on === 5 && r.days_off === 2 ? "" : ` ${r.days_on ?? "?"}/${r.days_off ?? "?"}`;
  return `${sc.name}${cycle}${r.shift_hours != null ? ` · ${Number(r.shift_hours)} ч` : ""}`;
}
// «вахта», «5/2», «5/2 скользящий», «сменный», «не задан» или код — из Excel.
function parseSchedule(text) {
  const t = String(text ?? "").trim().toLowerCase();
  if (!t) return undefined; // колонка пустая — график не трогаем
  if (SCHEDULES[t]) return t;
  if (t.startsWith("не")) return null;
  if (t.includes("вахт")) return "vahta";
  if (t.includes("скольз")) return "5x2_sliding";
  if (t.includes("5/2") || t.includes("5х2") || t.includes("5x2") || t.includes("пятиднев")) return "5x2";
  if (t.includes("смен")) return "shift";
  return false; // не распознан
}

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

function loadFilterOptions() {
  const objects = [...new Set(currentRows.map((r) => r.object).filter(Boolean))].sort();
  const positions = [...new Set(currentRows.map((r) => r.pos).filter(Boolean))].sort();
  const names = [...new Set(currentRows.map((r) => r.famaly).filter(Boolean))].sort();
  populateSelect("#filterObject", objects);
  populateSelect("#filterPos", positions);
  populateSelect("#filterFamaly", names);

  $("#posOptions").innerHTML = positions.map((p) => `<option value="${p}"></option>`).join("");
}

async function loadData() {
  clearError();
  setLoading(true);
  try {
    const { data, error } = await supabase.from("v_staff_roster").select("*");
    if (error) throw error;
    currentRows = data;
    loadFilterOptions();
    applyUrlFilters([["object", "#filterObject"]]); // пришли по крошкам с другой формы (один раз)
    applyFiltersAndRender();
  } catch (e) {
    showError("Ошибка загрузки данных: " + e.message);
  } finally {
    setLoading(false);
  }
}

function applyFiltersAndRender() {
  const object = $("#filterObject").value;
  const pos = $("#filterPos").value;
  const famaly = $("#filterFamaly").value;

  let rows = currentRows;
  if (object) rows = rows.filter((r) => r.object === object);
  if (pos) rows = rows.filter((r) => r.pos === pos);
  if (famaly) rows = rows.filter((r) => r.famaly === famaly);

  renderSummary(rows);
  renderTable(rows);
}

function renderSummary(rows) {
  $("#summaryCards").innerHTML = `
    <div class="summary-card"><div class="label">Всего сотрудников</div><div class="value">${currentRows.length}</div></div>
    <div class="summary-card"><div class="label">Показано (с фильтром)</div><div class="value">${rows.length}</div></div>
  `;
}

function renderTable(rows) {
  $("#dataTableBody").innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${r.famaly ?? "—"}</td>
      <td title="${r.pos ?? ""}">${r.pos ?? "—"}</td>
      <td title="${r.object ?? ""}">${r.object ?? "—"}</td>
      <td>${r.month_time ?? "—"}</td>
      <td>${r.staff_type === "contractor" ? "Подрядчик" : r.staff_type === "staff" ? "Штат" : "—"}</td>
      <td>${scheduleLabel(r)}</td>
      <td>${r.staff_type === "contractor" ? `${r.organization ?? "—"}${r.rate_per_hour ? " · " + r.rate_per_hour + "/ч" : ""}` : "—"}</td>
      <td class="row-actions">
        <button class="btn-secondary btn-small edit-btn" data-id="${r.id_workers}">Изменить</button>
        <button class="btn-danger btn-small delete-btn" data-id="${r.id_workers}">Удалить</button>
      </td>
    </tr>`
    )
    .join("");

  for (const btn of $("#dataTableBody").querySelectorAll(".edit-btn")) {
    btn.addEventListener("click", () => openStaffModal(Number(btn.dataset.id)));
  }
  for (const btn of $("#dataTableBody").querySelectorAll(".delete-btn")) {
    btn.addEventListener("click", () => deleteStaff(Number(btn.dataset.id)));
  }
}

async function deleteStaff(id) {
  const row = currentRows.find((r) => r.id_workers === id);
  if (!row) return;
  if (!confirm(`Удалить сотрудника "${row.famaly}" (${row.pos}, ${row.object})? Действие необратимо.`)) return;

  const { error } = await supabase.rpc("delete_staff_member", { p_id_workers: id });
  if (error) {
    showError("Ошибка удаления: " + error.message);
    return;
  }
  await loadData();
}

function fillForm(row) {
  $("#sfId").value = row ? row.id_workers : "";
  $("#sfFamaly").value = row ? row.famaly ?? "" : "";
  $("#sfPos").value = row ? row.pos ?? "" : "";
  $("#sfObject").value = row ? row.object ?? "" : "";
  $("#sfMonthTime").value = row && row.month_time != null ? row.month_time : "";
  $("#sfStaffType").value = row?.staff_type === "contractor" ? "contractor" : "staff";
  $("#sfOrganization").value = row ? row.organization ?? "" : "";
  $("#sfRate").value = row && row.rate_per_hour != null ? row.rate_per_hour : "";
  $("#sfSchedule").value = row && SCHEDULES[row.work_schedule] ? row.work_schedule : "";
  $("#sfDaysOn").value = row && row.days_on != null ? row.days_on : "";
  $("#sfDaysOff").value = row && row.days_off != null ? row.days_off : "";
  $("#sfShiftHours").value = row && row.shift_hours != null ? Number(row.shift_hours) : "";
  updateStaffTypeFields();
  updateScheduleFields();
}

// Цикл и длительность смены нужны только при выбранном графике.
function updateScheduleFields() {
  const has = !!$("#sfSchedule").value;
  $("#sfCycleGroup").hidden = !has;
  $("#sfShiftGroup").hidden = !has;
}
// Смена типа графика подставляет типовые значения (их можно поправить).
function onScheduleChange() {
  const sc = SCHEDULES[$("#sfSchedule").value];
  if (sc) [$("#sfDaysOn").value, $("#sfDaysOff").value, $("#sfShiftHours").value] = sc.def;
  updateScheduleFields();
}

// Организация/ставка имеют смысл только для подрядчика — прячем эти поля для штата,
// а не просто оставляем пустыми, иначе форма выглядит так, будто чего-то не хватает.
function updateStaffTypeFields() {
  const isContractor = $("#sfStaffType").value === "contractor";
  $("#sfOrgGroup").hidden = !isContractor;
  $("#sfRateGroup").hidden = !isContractor;
}

function openStaffModal(id) {
  const row = id ? currentRows.find((r) => r.id_workers === id) : null;
  $("#staffModalTitle").textContent = row ? `Изменить сотрудника` : "Новый сотрудник";
  $("#staffFormError").hidden = true;
  fillForm(row);
  $("#staffModal").hidden = false;
  staffFormOrig = snapshot($("#staffForm")); // для «есть несохранённые изменения»
}
// Открыта форма с изменёнными полями, а пользователь уходит со страницы — предложить сохранить.
let staffFormOrig = null;
const staffFormDirty = () => !$("#staffModal").hidden && staffFormOrig != null && snapshot($("#staffForm")) !== staffFormOrig;
guardUnsaved({
  isDirty: staffFormDirty,
  describe: () => [$("#staffModalTitle").textContent + " — форма не сохранена"],
  save: () => submitStaffForm({ preventDefault() {}, target: $("#staffForm") }),
});

function closeStaffModal() {
  $("#staffModal").hidden = true;
}

function formToParams() {
  const isContractor = $("#sfStaffType").value === "contractor";
  return {
    p_famaly: $("#sfFamaly").value.trim(),
    p_pos: $("#sfPos").value.trim(),
    p_object: $("#sfObject").value.trim(),
    p_month_time: $("#sfMonthTime").value === "" ? null : Number($("#sfMonthTime").value),
    p_staff_type: $("#sfStaffType").value,
    p_organization: isContractor ? $("#sfOrganization").value.trim() || null : null,
    p_rate_per_hour: isContractor && $("#sfRate").value !== "" ? Number($("#sfRate").value) : null,
  };
}

async function submitStaffForm(e) {
  e.preventDefault();
  const id = $("#sfId").value;
  const params = formToParams();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  let { error } = id
    ? await supabase.rpc("update_staff_member", { p_id_workers: Number(id), ...params })
    : await supabase.rpc("create_staff_member", params);
  // График хранится по ФИО (анализ на «Персонале» объединяет строки сотрудника по ФИО).
  const prev = id ? currentRows.find((r) => r.id_workers === Number(id)) : null;
  const sched = $("#sfSchedule").value || null;
  if (!error && (sched || prev?.work_schedule)) {
    ({ error } = await supabase.rpc("set_staff_schedule", {
      p_famaly: params.p_famaly,
      p_work_schedule: sched,
      p_days_on: sched && $("#sfDaysOn").value !== "" ? Number($("#sfDaysOn").value) : null,
      p_days_off: sched && $("#sfDaysOff").value !== "" ? Number($("#sfDaysOff").value) : null,
      p_shift_hours: sched && $("#sfShiftHours").value !== "" ? Number($("#sfShiftHours").value) : null,
    }));
  }

  submitBtn.disabled = false;
  if (error) {
    const el = $("#staffFormError");
    el.textContent = error.message;
    el.hidden = false;
    return;
  }
  closeStaffModal();
  await loadData();
}

const TEMPLATE_HEADERS = ["ФИО", "Должность", "Объект", "Норма часов/мес", "Тип", "Организация", "Ставка, за час", "График", "Рабочих дней", "Дней отдыха", "Смена, ч"];

function downloadTemplate() {
  const exampleRow = {
    "ФИО": "Иванов Иван",
    "Должность": "Механик",
    "Объект": "ЕХУ",
    "Норма часов/мес": 165,
    "Тип": "staff",
    "Организация": "",
    "Ставка, за час": "",
    "График": "вахта",
    "Рабочих дней": 15,
    "Дней отдыха": 15,
    "Смена, ч": 12,
  };
  const ws = XLSX.utils.json_to_sheet([exampleRow], { header: TEMPLATE_HEADERS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Персонал");
  XLSX.writeFile(wb, "staff_import_template.xlsx");
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
    const famaly = String(row["ФИО"] ?? row["famaly"] ?? "").trim();
    const pos = String(row["Должность"] ?? row["pos"] ?? "").trim();
    const object = String(row["Объект"] ?? row["object"] ?? "").trim();
    const monthTimeRaw = row["Норма часов/мес"] ?? row["month_time"] ?? "";
    const staffType = String(row["Тип"] ?? row["staff_type"] ?? "staff").trim() === "contractor" ? "contractor" : "staff";
    const organization = String(row["Организация"] ?? row["organization"] ?? "").trim();
    const rateRaw = row["Ставка, за час"] ?? row["rate_per_hour"] ?? "";
    if (!famaly) {
      errors.push(`Строка ${i + 2}: не заполнено обязательное поле (ФИО)`);
      continue;
    }
    const { data, error } = await supabase.rpc("upsert_staff_member", {
      p_famaly: famaly,
      p_pos: pos || null,
      p_object: object || null,
      p_month_time: monthTimeRaw === "" ? null : Number(monthTimeRaw),
      p_staff_type: staffType,
      p_organization: staffType === "contractor" ? organization || null : null,
      p_rate_per_hour: staffType === "contractor" && rateRaw !== "" ? Number(rateRaw) : null,
    });
    if (error) {
      errors.push(`Строка ${i + 2} (${famaly}): ${error.message}`);
      continue;
    }
    if (data === "created") created++;
    else updated++;
    // График: пустая колонка — не меняем; «не задан» — очищаем; иначе типовые значения,
    // если цикл/смена не указаны.
    const sched = parseSchedule(row["График"] ?? row["work_schedule"]);
    if (sched === false) {
      errors.push(`Строка ${i + 2} (${famaly}): график «${row["График"]}» не распознан (вахта, 5/2, 5/2 скользящий, сменный, не задан)`);
    } else if (sched !== undefined) {
      const def = sched ? SCHEDULES[sched].def : [];
      const num = (v, d) => (v === "" || v == null ? d ?? null : Number(v));
      const { error: sErr } = await supabase.rpc("set_staff_schedule", {
        p_famaly: famaly,
        p_work_schedule: sched,
        p_days_on: sched ? num(row["Рабочих дней"] ?? row["days_on"], def[0]) : null,
        p_days_off: sched ? num(row["Дней отдыха"] ?? row["days_off"], def[1]) : null,
        p_shift_hours: sched ? num(row["Смена, ч"] ?? row["shift_hours"], def[2]) : null,
      });
      if (sErr) errors.push(`Строка ${i + 2} (${famaly}): график — ${sErr.message}`);
    }
  }

  $("#importSummary").innerHTML = `
    <p>Создано новых записей: <strong>${created}</strong>, обновлено существующих: <strong>${updated}</strong> (из ${rows.length} строк)</p>
    ${errors.length ? `<p class="import-errors-title">Ошибки:</p><ul class="import-errors-list">${errors.map((e) => `<li>${e}</li>`).join("")}</ul>` : ""}
  `;
  await loadData();
}

async function loadObjectOptions() {
  try {
    const list = await loadEquipmentList(supabase);
    objectOptions = [...new Set(list.map((d) => d.object).filter(Boolean))].sort();
  } catch {
    objectOptions = [...new Set(currentRows.map((r) => r.object).filter(Boolean))].sort();
  }
  $("#sfObject").innerHTML =
    '<option value="">Выберите</option>' + objectOptions.map((o) => `<option value="${o}">${o}</option>`).join("");
}

function initDashboard() {
  if (dashboardStarted) return;
  dashboardStarted = true;
  enableTapToExpandCells();
  enableScrollButtons();

  setupFilterToggle(applyFiltersAndRender);
  // Крошки: объект; года и шахты здесь нет — передаём дальше те, с которыми пришли.
  initCrumbs($("#crumbs"), STAFF_PAGES, "staff-roster.html", {
    year: () => urlParam("year"),
    object: () => $("#filterObject").value,
    mine: () => ($("#filterObject").value === urlParam("object") ? urlParam("mine") : ""),
  });
  for (const id of ["#filterObject", "#filterPos", "#filterFamaly"]) {
    $(id).addEventListener("change", () => {
      onFilterChanged(applyFiltersAndRender);
    });
  }
  $("#resetFilters").addEventListener("click", () => {
    $("#filterObject").value = "";
    $("#filterPos").value = "";
    $("#filterFamaly").value = "";
    applyFiltersAndRender();
    $("#filterPanel").classList.remove("open");
  });

  $("#addStaffBtn").addEventListener("click", () => openStaffModal(null));
  $("#staffModalClose").addEventListener("click", closeStaffModal);
  $("#staffCancelBtn").addEventListener("click", closeStaffModal);
  $("#staffModal").addEventListener("click", (e) => {
    if (e.target.id === "staffModal") closeStaffModal();
  });
  $("#staffForm").addEventListener("submit", submitStaffForm);
  $("#sfStaffType").addEventListener("change", updateStaffTypeFields);
  $("#sfSchedule").addEventListener("change", onScheduleChange);

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

  loadObjectOptions();
  loadData();
}

setupAuth(supabase, "staff-roster.html", () => initDashboard());
