import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { setupAuth } from "./auth.js?v=36";
import { enableTapToExpandCells, enableScrollButtons, setupFilterToggle, onFilterChanged } from "./ui.js?v=3";
import { initCrumbs, applyUrlFilters, equipmentParams, equipmentSteps, EQUIPMENT_PAGES } from "./crumbs.js?v=2";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let currentRows = [];
let dashboardStarted = false;
let repeatStatusByCod = new Map(); // cod -> { fs, repeat_configured, repeat_missing }
let machineTypes = []; // [{id, name}] — справочник типов машин (public.machine_type)
let isAdmin = false; // «+ тип» / «переименовать» — только администратору

const $ = (sel) => document.querySelector(sel);
const escHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const typeName = (id) => machineTypes.find((t) => t.id === id)?.name || "";

// ---------- типы машин ----------
async function loadMachineTypes() {
  const { data, error } = await supabase.from("machine_type").select("id,name").order("name");
  if (error) throw error;
  machineTypes = data || [];
  const opts = machineTypes.map((t) => `<option value="${t.id}">${escHtml(t.name)}</option>`).join("");
  const keepEq = $("#eqType").value, keepF = $("#filterType").value;
  $("#eqType").innerHTML = '<option value="">— без типа —</option>' + opts;
  $("#eqType").value = keepEq;
  $("#filterType").innerHTML = '<option value="">Все</option><option value="none">— без типа —</option>' + opts;
  $("#filterType").value = keepF;
}
async function saveMachineType(id) {
  const cur = id ? typeName(id) : "";
  const nv = (prompt(id ? `Новое название типа «${cur}»:` : "Название нового типа машины:", cur) || "").trim();
  if (!nv || nv === cur) return;
  const { data, error } = await supabase.rpc("machine_type_save", { p_id: id || null, p_name: nv });
  if (error) { showFormError(error.message); return; }
  await loadMachineTypes();
  $("#eqType").value = String(data ?? id);
  updateTypeScopeUI();
  applyFiltersAndRender();
}
// «Применить тип для одинаковых моделей» — как «Применить для одинаковых моделей» у повторных отказов,
// но без учёта FS: тип общий для модели. Модель сравнивается через trim + lower.
const curTypeId = () => ($("#eqType").value ? Number($("#eqType").value) : null);
const curTypeLabel = () => (curTypeId() ? `«${typeName(curTypeId())}»` : "«без типа»");
const curEo = () => $("#eqEo").checked;
const eoLabel = (on) => (on ? "ЕО есть" : "без ЕО");
// «тип «X» и ЕО будут назначены» / «тип «X» без ЕО будет назначен»
const eoPhrase = (on) => (on ? "и <b>ЕО</b> будут назначены" : "<b>без ЕО</b> будет назначен");
function typeModelMatches() {
  const cod = $("#eqCod").value ? Number($("#eqCod").value) : null;
  const model = $("#eqModel").value.trim().toLowerCase();
  return model ? currentRows.filter((r) => r.cod !== cod && (r.model || "").trim().toLowerCase() === model) : [];
}
function typeScopeMatches() {
  let m = typeModelMatches();
  if ($("#eqTypeApplyCustomer").checked) {
    const cust = $("#eqCustomerFullName").value.trim().toLowerCase();
    m = m.filter((r) => (r.customer_full_name || "").trim().toLowerCase() === cust);
  }
  return m;
}
function updateTypeScopeUI() {
  const model = $("#eqModel").value.trim();
  const cust = $("#eqCustomerFullName").value.trim();
  const modelMatches = typeModelMatches();
  $("#eqTypeApplyTypeName").textContent = curTypeLabel();
  $("#eqTypeApplyEo").innerHTML = eoPhrase(curEo());
  $("#eqTypeApplyModelName").textContent = model || "—";
  $("#eqTypeApplyModelCount").textContent = `(${modelMatches.length + 1} машин${modelMatches.length + 1 === 1 ? "а" : ""}${
    modelMatches.length ? ": борта " + [String($("#eqLocalCode").value || "?"), ...modelMatches.map((r) => r.local_code)].join(", ") : ""
  })`;
  const applyModel = $("#eqTypeApplyModel").checked;
  const custCheckbox = $("#eqTypeApplyCustomer");
  custCheckbox.disabled = !applyModel || !cust;
  if (custCheckbox.disabled) custCheckbox.checked = false;
  $("#eqTypeApplyCustL").classList.toggle("eq-na", !applyModel || !cust);
  $("#eqTypeApplyCustName").textContent = cust || "(заказчик не указан)";
  const custMatches = modelMatches.filter((r) => (r.customer_full_name || "").trim().toLowerCase() === cust.toLowerCase());
  $("#eqTypeApplyCustCount").textContent = `(${custMatches.length + 1} машин${custMatches.length + 1 === 1 ? "а" : ""})`;
  const n = custCheckbox.checked ? custMatches.length : modelMatches.length;
  $("#eqTypeScopeNote").textContent = !applyModel || !n
    ? "Тип сохранится только для этой машины."
    : `При сохранении тип будет назначен ещё ${n} машин${n === 1 ? "е" : "ам"} этой модели${custCheckbox.checked ? " у заказчика" : ""}. Перед сохранением покажем список.`;
}
// Каким машинам назначить тип: этой (если тип изменился или машина новая с типом) и, если отмечено, машинам модели.
function computeTypeCods() {
  const cod = $("#eqCod").value ? Number($("#eqCod").value) : null;
  const row = cod ? currentRows.find((r) => r.cod === cod) : null;
  const origType = row?.machine_type_id ?? null, origEo = !!row?.has_eo;
  const others = $("#eqTypeApplyModel").checked ? typeScopeMatches().map((r) => r.cod) : [];
  // Эта машина — если изменились тип или ЕО (у новой — если выбран тип или отмечено ЕО), или назначаем модели.
  const self = curTypeId() !== origType || curEo() !== origEo || others.length ? [cod ?? "__NEW__"] : [];
  return [...self, ...others];
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

function populateSelect(sel, values) {
  const el = $(sel);
  const existing = new Set(Array.from(el.options).map((o) => o.value));
  for (const v of values) {
    if (v == null || v === "" || existing.has(String(v))) continue;
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    el.appendChild(opt);
    existing.add(String(v));
  }
}

function dateLabel(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

async function loadFilterOptions() {
  const objects = [...new Set(currentRows.map((r) => r.object).filter(Boolean))].sort();
  const mines = [...new Set(currentRows.map((r) => r.mine).filter(Boolean))].sort();
  const models = [...new Set(currentRows.map((r) => r.model).filter(Boolean))].sort();
  const localCodes = [...new Set(currentRows.map((r) => r.local_code).filter(Boolean))].sort();
  populateSelect("#filterObject", objects);
  populateSelect("#filterMine", mines);
  populateSelect("#filterModel", models);
  populateSelect("#filterLocalCode", localCodes);
}

// Suggestion lists for the "Новая машина" modal's free-text fields — sourced from
// what's already in local_code, but typing a new value is still allowed.
function updateModalDatalists() {
  const distinct = (key) => [...new Set(currentRows.map((r) => r[key]).filter(Boolean))].sort();
  const fill = (id, values) => {
    $(id).innerHTML = values.map((v) => `<option value="${v}"></option>`).join("");
  };
  fill("#modelOptions", distinct("model"));
  fill("#objectOptions", distinct("object"));
  fill("#mineOptions", distinct("mine"));
  fill("#customerOptions", distinct("customer_full_name"));
  fill("#contractorOptions", distinct("contractor_full_name"));
}

async function loadRepeatStatus() {
  const { data, error } = await supabase.from("v_equipment_repeat_status").select("*");
  if (error) return;
  repeatStatusByCod = new Map(data.map((r) => [r.cod, r]));
}

// "Справочник ТО (PM)" — opened from inside the equipment modal, which stays open
// behind it (both modal-overlays visible at once; this one is later in the DOM so it
// renders on top). Each period (a-g) is its own ordered list; position in the list is
// the step number, and cycle_lenght (for the future ТО-forecast generator) is just the
// count of steps — no separate "ПМ"/length field for the user to manage.
async function loadPmTable() {
  $("#pmEditError").hidden = true;
  const period = $("#pmPeriodSelect").value;
  const { data, error } = await supabase.from("v_pm_steps").select("*").eq("period", period).order("position");
  if (error) {
    $("#pmDataTableBody").innerHTML = `<tr><td colspan="3">Ошибка загрузки: ${error.message}</td></tr>`;
    return;
  }
  renderPmTable(data);
}

function renderPmTable(rows) {
  $("#pmDataTableBody").innerHTML = rows.length
    ? rows
        .map(
          (r) => `
    <tr data-pm-id="${r.id}">
      <td>${r.position}</td>
      <td><input type="text" class="inline-edit-input" data-pm-field="descr" value="${r.descr ?? ""}" /></td>
      <td class="row-actions">
        <button type="button" class="btn-secondary btn-small pm-save-btn" data-pm-id="${r.id}">Сохранить</button>
        <button type="button" class="btn-danger btn-small pm-delete-btn" data-pm-id="${r.id}">Удалить</button>
      </td>
    </tr>`
        )
        .join("")
    : `<tr><td colspan="3">Для этого периода пока нет ни одного ТО</td></tr>`;

  for (const btn of $("#pmDataTableBody").querySelectorAll(".pm-save-btn")) {
    btn.addEventListener("click", () => savePmStep(Number(btn.dataset.pmId), btn));
  }
  for (const btn of $("#pmDataTableBody").querySelectorAll(".pm-delete-btn")) {
    btn.addEventListener("click", () => deletePmStep(Number(btn.dataset.pmId)));
  }
}

async function savePmStep(id, btn) {
  const row = $(`tr[data-pm-id="${id}"]`);
  const descr = row.querySelector('[data-pm-field="descr"]').value.trim();

  btn.disabled = true;
  $("#pmEditError").hidden = true;
  const { error } = await supabase.rpc("update_pm_step", { p_id: id, p_descr: descr });
  btn.disabled = false;
  if (error) {
    const el = $("#pmEditError");
    el.textContent = error.message;
    el.hidden = false;
    return;
  }
  await loadPmTable();
}

async function deletePmStep(id) {
  const row = $(`tr[data-pm-id="${id}"]`);
  const descr = row.querySelector('[data-pm-field="descr"]').value;
  if (!confirm(`Удалить ТО "${descr}"? Все следующие шаги этого периода сдвинутся на одну позицию вверх.`)) return;

  const { error } = await supabase.rpc("delete_pm_step", { p_id: id });
  if (error) {
    const el = $("#pmEditError");
    el.textContent = error.message;
    el.hidden = false;
    return;
  }
  await loadPmTable();
}

async function addPmStep() {
  const descr = $("#pmNewDescr").value.trim();
  if (!descr) {
    const el = $("#pmEditError");
    el.textContent = "Название ТО обязательно";
    el.hidden = false;
    return;
  }
  const btn = $("#pmAddBtn");
  btn.disabled = true;
  $("#pmEditError").hidden = true;

  const { error } = await supabase.rpc("create_pm_step", { p_period: $("#pmPeriodSelect").value, p_descr: descr });
  btn.disabled = false;
  if (error) {
    const el = $("#pmEditError");
    el.textContent = error.message;
    el.hidden = false;
    return;
  }
  $("#pmNewDescr").value = "";
  await loadPmTable();
}

function openPmTableModal() {
  // Справочник открывается на периоде, выбранном у машины в «Период ТО (маска)» (даже несохранённом):
  // сначала система TR, иначе первая заполненная из FS машины. Пусто — период по умолчанию.
  const mask = [eqPm.TR?.mask, ...(SYS[eqFs] || []).map((sys) => eqPm[sys]?.mask)].find((m) => m);
  if (mask) $("#pmPeriodSelect").value = String(mask).trim().toLowerCase();
  $("#pmTableModal").hidden = false;
  $("#pmTableModal").classList.remove("minimized");
  setPmMinimizeIcon(false);
  loadPmTable();
}

function closePmTableModal() {
  $("#pmTableModal").hidden = true;
  $("#pmTableModal").classList.remove("minimized");
  setPmMinimizeIcon(false);
}

function setPmMinimizeIcon(minimized) {
  const btn = $("#pmTableModalMinimize");
  btn.textContent = minimized ? "▢" : "−";
  btn.title = minimized ? "Развернуть" : "Свернуть";
  btn.setAttribute("aria-label", minimized ? "Развернуть" : "Свернуть");
}

function togglePmMinimize() {
  const minimized = $("#pmTableModal").classList.toggle("minimized");
  setPmMinimizeIcon(minimized);
}

async function loadData() {
  clearError();
  setLoading(true);
  try {
    const { data, error } = await supabase.from("v_equipment_full").select("*").order("cod");
    if (error) throw error;
    currentRows = data;
    await Promise.all([loadFilterOptions(), loadRepeatStatus()]);
    applyUrlFilters(equipmentSteps("#filterLocalCode")); // пришли по крошкам с другой формы (один раз)
    updateModalDatalists();
    applyFiltersAndRender();
  } catch (e) {
    showError("Ошибка загрузки данных: " + e.message);
  } finally {
    setLoading(false);
  }
}

function applyFiltersAndRender() {
  const object = $("#filterObject").value;
  const mine = $("#filterMine").value;
  const model = $("#filterModel").value;
  const localCode = $("#filterLocalCode").value;
  const status = $("#filterStatus").value;
  const unconfiguredOnly = $("#filterUnconfiguredOnly").checked;
  const mtype = $("#filterType").value;

  let rows = currentRows;
  if (mtype === "none") rows = rows.filter((r) => r.machine_type_id == null);
  else if (mtype) rows = rows.filter((r) => r.machine_type_id === Number(mtype));
  if (object) rows = rows.filter((r) => r.object === object);
  if (mine) rows = rows.filter((r) => r.mine === mine);
  if (model) rows = rows.filter((r) => r.model === model);
  if (localCode) rows = rows.filter((r) => r.local_code === localCode);
  if (status === "active") rows = rows.filter((r) => !r.notrun);
  else if (status === "inactive") rows = rows.filter((r) => r.notrun);
  if (unconfiguredOnly) rows = rows.filter((r) => !repeatStatusByCod.get(r.cod)?.repeat_configured);

  renderSummary(rows);
  renderTable(rows);
}

function renderSummary(rows) {
  const active = currentRows.filter((r) => !r.notrun).length;
  const inactive = currentRows.filter((r) => r.notrun).length;
  $("#summaryCards").innerHTML = `
    <div class="summary-card"><div class="label">Всего техники</div><div class="value">${currentRows.length}</div></div>
    <div class="summary-card"><div class="label">Активна</div><div class="value">${active}</div></div>
    <div class="summary-card"><div class="label">Деактивирована</div><div class="value">${inactive}</div></div>
    <div class="summary-card"><div class="label">Показано (с фильтром)</div><div class="value">${rows.length}</div></div>
  `;
}

function repeatStatusCell(cod) {
  const s = repeatStatusByCod.get(cod);
  if (!s || !s.fs) return `<span class="repeat-cfg-no" title="FS не выбран — окна повторного отказа не заданы">⚙ не настроено</span>`;
  if (s.repeat_configured) return `<span class="repeat-cfg-ok">✓</span>`;
  const missing = (s.repeat_missing || []).join(", ");
  return `<span class="repeat-cfg-no" title="${missing ? "Не задано: " + missing : ""}">⚙ не настроено</span>`;
}

// Полное значение ячейки — в title: в узкой таблице длинный текст обрезается «…», нажатие раскрывает ячейку.
const cellTitle = (v) => (v ? ` title="${escHtml(v)}"` : "");
function renderTable(rows) {
  $("#dataTableBody").innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${r.cod}</td>
      <td${cellTitle(r.local_code)}>${r.local_code ?? "—"}</td>
      <td${cellTitle(r.model)}>${r.model ?? "—"}</td>
      <td${cellTitle((r.machine_type_id ? typeName(r.machine_type_id) : "") + (r.has_eo ? " · ЕО" : ""))}>${r.machine_type_id ? escHtml(typeName(r.machine_type_id)) : "—"}${r.has_eo ? ' <span class="eq-note" title="ЕО (ежедневный осмотр)">· ЕО</span>' : ""}</td>
      <td>${r.fs ?? "—"}</td>
      <td${cellTitle(r.mine)}>${r.mine ?? "—"}</td>
      <td${cellTitle(r.object)}>${r.object ?? "—"}</td>
      <td${cellTitle(r.manufacture_number)}>${r.manufacture_number ?? "—"}</td>
      <td${cellTitle(r.serial_number)}>${r.serial_number ?? "—"}</td>
      <td>${dateLabel(r.commissioning_date)}</td>
      <td>${r.notrun ? '<span class="status-badge status-inactive">Деактивирована</span>' : '<span class="status-badge status-active">Активна</span>'}</td>
      <td>${repeatStatusCell(r.cod)}</td>
      <td class="row-actions">
        <button class="btn-secondary btn-small edit-btn" data-cod="${r.cod}">Изменить</button>
        <button class="btn-secondary btn-small toggle-btn" data-cod="${r.cod}" data-active="${!r.notrun}">${r.notrun ? "Активировать" : "Деактивировать"}</button>
        ${r.notrun ? `<button class="btn-danger btn-small hard-delete-btn" data-cod="${r.cod}">Удалить безвозвратно</button>` : ""}
      </td>
    </tr>`
    )
    .join("");

  for (const btn of $("#dataTableBody").querySelectorAll(".edit-btn")) {
    btn.addEventListener("click", () => openEquipmentModal(Number(btn.dataset.cod)));
  }
  for (const btn of $("#dataTableBody").querySelectorAll(".toggle-btn")) {
    btn.addEventListener("click", () => toggleActive(Number(btn.dataset.cod), btn.dataset.active === "true"));
  }
  for (const btn of $("#dataTableBody").querySelectorAll(".hard-delete-btn")) {
    btn.addEventListener("click", () => openHardDeleteModal(Number(btn.dataset.cod)));
  }
}

async function toggleActive(cod, currentlyActive) {
  const row = currentRows.find((r) => r.cod === cod);
  const label = row ? row.local_code : cod;
  const action = currentlyActive ? "деактивировать" : "активировать";
  if (!confirm(`Точно ${action} машину "${label}" (код ${cod})? Данные не удаляются, статус можно вернуть обратно.`)) return;

  const { error } = await supabase.rpc("set_equipment_active", { p_cod: cod, p_active: !currentlyActive });
  if (error) {
    showError("Ошибка изменения статуса: " + error.message);
    return;
  }
  await loadData();
}

let hardDeleteCod = null;

async function openHardDeleteModal(cod) {
  const row = currentRows.find((r) => r.cod === cod);
  if (!row) return;
  hardDeleteCod = cod;

  $("#hardDeleteExpected").textContent = row.local_code;
  $("#hardDeleteConfirmInput").value = "";
  $("#hardDeleteConfirmBtn").disabled = true;
  $("#hardDeleteError").hidden = true;
  $("#hardDeletePreview").innerHTML = "Загрузка данных для удаления…";
  $("#hardDeleteModal").hidden = false;

  const { data, error } = await supabase.rpc("preview_equipment_deletion", { p_cod: cod });
  if (error) {
    $("#hardDeletePreview").innerHTML = `Ошибка загрузки предпросмотра: ${error.message}`;
    return;
  }
  $("#hardDeletePreview").innerHTML = `
    <ul class="delete-preview-list">
      <li>Наряды на ремонт (13wza_details): <strong>${data.repair_days}</strong></li>
      <li>Строки плана (4wza_plan): <strong>${data.plan_rows}</strong></li>
      <li>Записи простоя (work): <strong>${data.work_orders}</strong></li>
      <li>Наработка SMH_IN_TL: <strong>${data.smh_in_tl_rows}</strong></li>
      <li>Записи персонала: <strong>${data.staff_rows}</strong></li>
    </ul>
  `;
}

function closeHardDeleteModal() {
  $("#hardDeleteModal").hidden = true;
  hardDeleteCod = null;
}

async function confirmHardDelete() {
  if (hardDeleteCod == null) return;
  const btn = $("#hardDeleteConfirmBtn");
  btn.disabled = true;
  $("#hardDeleteError").hidden = true;

  const { data, error } = await supabase.rpc("hard_delete_equipment", { p_cod: hardDeleteCod });
  if (error) {
    const el = $("#hardDeleteError");
    el.textContent = error.message;
    el.hidden = false;
    btn.disabled = false;
    return;
  }
  closeHardDeleteModal();
  alert(
    `Машина удалена безвозвратно.\n` +
      `Нарядов удалено: ${data.repair_days_deleted}\n` +
      `Строк плана: ${data.plan_rows_deleted}\n` +
      `Записей простоя: ${data.work_orders_deleted}\n` +
      `SMH_IN_TL: ${data.smh_in_tl_rows_deleted}\n` +
      `Записей персонала: ${data.staff_rows_deleted}`
  );
  await loadData();
}

// =====================================================================================
// Окно повторного отказа (repeat-failures-spec.md §2) — состояние формы машины.
// =====================================================================================

const SYS = { TR: ["TR"], DR1: ["TR", "DR1"], DR2: ["TR", "DR1", "DR2"] };
const FS_NOTE = {
  TR: "Машина отслеживает одну систему — TR. ТО и окна повторного отказа задаются только для TR.",
  DR1: "Машина отслеживает две системы — TR и DR1. ТО и окна задаются для каждой системы отдельно: верхняя строка — TR, нижняя — DR1.",
  DR2: "Машина отслеживает три системы — TR, DR1 и DR2. ТО и окна задаются для каждой системы: верхняя строка — TR, средняя — DR1, нижняя — DR2.",
};
const NEW_MACHINE_EXCLUDE_TYPE = /ЕО|daily|ежесмен/i;

function emptyPmState() {
  return { TR: { mask: "", step: "" }, DR1: { mask: "", step: "" }, DR2: { mask: "", step: "" } };
}
function emptyWinState() {
  return { TR: { d: "", h: "" }, DR1: { d: "", h: "" }, DR2: { d: "", h: "" } };
}

// Global dictionaries (loaded once) + per-machine state for the currently open modal.
let dictWorkTypes = [];
let dictReasons = [];
let dictInitiators = [];

let eqFs = "";
let eqPm = emptyPmState();
let eqWinPm = emptyWinState();
let eqWinRp = emptyWinState();
let eqLists = { types: [], reason: [], init: [] };
let eqListFilter = { reason: "", init: "" };

async function loadRepeatDicts() {
  const [wt, rs, ini] = await Promise.all([
    supabase.from("v_repeat_work_types_dict").select("work_type_id,work_type"),
    supabase.from("v_repeat_reasons_dict").select("reason_id,reason"),
    supabase.from("v_repair_initiators").select("initiator_id,initiator"),
  ]);
  dictWorkTypes = (wt.data || []).map((r) => ({ id: r.work_type_id, label: r.work_type }));
  dictReasons = (rs.data || []).map((r) => ({ id: r.reason_id, label: r.reason }));
  dictInitiators = (ini.data || []).map((r) => ({ id: r.initiator_id, label: r.initiator }));
}

// Загружает окна + "Что учитывать" + счётчики за 12 мес для машины cod (или дефолты
// для новой машины при cod=null) и заполняет eqPm/eqWinPm/eqWinRp/eqLists.
async function loadRepeatConfigForCod(cod, row) {
  eqPm = {
    TR: { mask: row?.period ?? "", step: row?.coff != null ? row.coff * 5 : "" },
    DR1: { mask: row?.period_dr1 ?? "", step: row?.coff_dr1 != null ? row.coff_dr1 * 5 : "" },
    DR2: { mask: row?.period_dr2 ?? "", step: row?.coff_dr2 != null ? row.coff_dr2 * 5 : "" },
  };

  if (cod == null) {
    eqWinPm = emptyWinState();
    eqWinRp = emptyWinState();
    eqLists = {
      types: dictWorkTypes.map((v) => ({ id: v.id, label: v.label, count: 0, checked: !NEW_MACHINE_EXCLUDE_TYPE.test(v.label), isNew: false })),
      reason: dictReasons.map((v) => ({ id: v.id, label: v.label, count: 0, checked: true, isNew: false })),
      init: dictInitiators.map((v) => ({ id: v.id, label: v.label, count: 0, checked: true, isNew: false })),
    };
    return;
  }

  const [winRes, wtRes, rsRes, iniRes, cWtRes, cRsRes, cIniRes] = await Promise.all([
    supabase.from("equipment_repeat_window").select("*").eq("equipment_id", cod),
    supabase.from("equipment_repeat_work_types").select("*").eq("equipment_id", cod),
    supabase.from("equipment_repeat_reasons").select("*").eq("equipment_id", cod),
    supabase.from("equipment_repeat_initiators").select("*").eq("equipment_id", cod),
    supabase.from("v_equipment_worktype_counts").select("*").eq("cod", cod),
    supabase.from("v_equipment_reason_counts").select("*").eq("cod", cod),
    supabase.from("v_equipment_initiator_counts").select("*").eq("cod", cod),
  ]);

  const winBySys = new Map((winRes.data || []).map((w) => [w.fs_system, w]));
  eqWinPm = emptyWinState();
  eqWinRp = emptyWinState();
  for (const sys of ["TR", "DR1", "DR2"]) {
    const w = winBySys.get(sys);
    if (!w) continue;
    eqWinPm[sys] = { d: w.after_pm_days ?? "", h: w.after_pm_meter ?? "" };
    eqWinRp[sys] = { d: w.after_repair_days ?? "", h: w.after_repair_meter ?? "" };
  }

  const wtMap = new Map((wtRes.data || []).map((r) => [r.work_type_id, r.starts_window]));
  const rsMap = new Map((rsRes.data || []).map((r) => [r.reason_id, r.counted]));
  const iniMap = new Map((iniRes.data || []).map((r) => [r.damage_id, r.counted]));
  const wtCount = new Map((cWtRes.data || []).map((r) => [r.work_type_id, r.cnt12m]));
  const rsCount = new Map((cRsRes.data || []).map((r) => [r.reason_id, r.cnt12m]));
  const iniCount = new Map((cIniRes.data || []).map((r) => [r.initiator_id, r.cnt12m]));

  eqLists = {
    types: dictWorkTypes.map((v) => ({ id: v.id, label: v.label, count: wtCount.get(v.id) || 0, checked: wtMap.has(v.id) ? wtMap.get(v.id) : true, isNew: !wtMap.has(v.id) })),
    reason: dictReasons.map((v) => ({ id: v.id, label: v.label, count: rsCount.get(v.id) || 0, checked: rsMap.has(v.id) ? rsMap.get(v.id) : true, isNew: !rsMap.has(v.id) })),
    init: dictInitiators.map((v) => ({ id: v.id, label: v.label, count: iniCount.get(v.id) || 0, checked: iniMap.has(v.id) ? iniMap.get(v.id) : true, isNew: !iniMap.has(v.id) })),
  };
}

function renderFsToggle() {
  for (const b of $("#eqFsToggle").querySelectorAll("button")) b.classList.toggle("on", b.dataset.fs === eqFs);
  $("#eqFs").value = eqFs;
  $("#eqFsNote").textContent = eqFs ? FS_NOTE[eqFs] : "Выберите FS: от него зависят строки ТО и окон ниже.";
}

const sysTag = (s) => `<span class="eq-sys eq-sys-${s}">${s}</span>`;

function renderPmMaskTable() {
  const S = SYS[eqFs] || [];
  $("#eqPmTable").innerHTML = S.length
    ? '<tr><th style="width:70px">Система</th><th>Период ТО (маска)</th><th>Шаг ТО, ч</th></tr>' +
      S.map(
        (s) => `<tr><td>${sysTag(s)}</td>
    <td><select data-pmsys="${s}" data-pmfield="mask"><option value="">Не выбрано</option>${"abcdefg"
      .split("")
      .map((x) => `<option value="${x}" ${eqPm[s].mask === x ? "selected" : ""}>${x}</option>`)
      .join("")}</select></td>
    <td><input type="number" step="any" min="0" data-pmsys="${s}" data-pmfield="step" value="${eqPm[s].step}" placeholder="например 250, 500"></td></tr>`
      ).join("")
    : '<tr><td>Выберите FS выше</td></tr>';
}

function windowEffText(sys, w) {
  if (w.d) return `→ ${w.d} дней (наработка не используется)`;
  if (w.h) return `→ ${w.h} ч наработки ${sys}`;
  return `⚙ не задано — повторы по ${sys} не считаются`;
}

function renderWindowTable(tableId, state) {
  const S = SYS[eqFs] || [];
  $(tableId).innerHTML = S.length
    ? '<tr><th style="width:70px">Система</th><th style="width:110px">Дни</th><th style="width:140px">Наработка, ч</th><th>Итоговое окно</th></tr>' +
      S.map((s) => {
        const w = state[s];
        const eff = windowEffText(s, w);
        const cls = w.d || w.h ? "eq-eff" : "eq-eff eq-eff-def";
        return `<tr><td>${sysTag(s)}</td>
      <td><input type="number" data-winsys="${s}" data-winfield="d" value="${w.d}" placeholder="—"></td>
      <td><input type="number" data-winsys="${s}" data-winfield="h" value="${w.h}" placeholder="—"></td>
      <td class="${cls}">${eff}</td></tr>`;
      }).join("")
    : '<tr><td>Выберите FS выше</td></tr>';
}

function renderRepeatStatusBadge() {
  const S = SYS[eqFs] || [];
  const missing = [];
  for (const s of S) {
    const pmOk = !!(eqWinPm[s].d || eqWinPm[s].h);
    const rpOk = !!(eqWinRp[s].d || eqWinRp[s].h);
    if (!pmOk) missing.push(`после ТО ${s}`);
    if (!rpOk) missing.push(`после ремонта ${s}`);
  }
  const el = $("#eqRepeatStatus");
  if (!S.length) {
    el.className = "";
    el.textContent = "";
  } else if (missing.length) {
    el.className = "repeat-cfg-no";
    el.textContent = `⚙ не настроено: ${missing.join(", ")} — повторы не считаются, показатели серые`;
  } else {
    el.className = "repeat-cfg-ok";
    el.textContent = "✓ настроено";
  }
}

function drawList(key, listWrapId) {
  const q = (eqListFilter[key] || "").toLowerCase();
  $(listWrapId).innerHTML = eqLists[key]
    .map((x, i) => {
      if (q && !x.label.toLowerCase().includes(q)) return "";
      return `<label class="eq-li ${x.checked ? "" : "eq-off"}"><input type="checkbox" data-lkey="${key}" data-lidx="${i}" ${x.checked ? "checked" : ""}> ${x.label} ${
        x.isNew ? '<span class="eq-tagn" title="Не проверено для этой машины — проверьте, учитывать ли это значение">новое</span>' : ""
      }<span class="eq-n">${x.count.toLocaleString("ru-RU")}</span></label>`;
    })
    .join("");
}
function renderLists() {
  drawList("types", "#eqL-types");
  drawList("reason", "#eqL-reason");
  drawList("init", "#eqL-init");
}

function updateCopyFromDropdown() {
  const cod = $("#eqCod").value ? Number($("#eqCod").value) : null;
  const model = $("#eqModel").value.trim().toLowerCase();
  const sel = $("#eqCopyFrom");
  const candidates = currentRows.filter((r) => r.cod !== cod && (r.model || "").trim().toLowerCase() === model && model);
  sel.innerHTML =
    '<option value="">— выберите машину той же модели —</option>' +
    candidates.map((r) => `<option value="${r.cod}">${r.model} · ${r.local_code ?? "—"} (${r.customer_full_name || "без заказчика"})</option>`).join("");
}

function updateScopeUI() {
  const cod = $("#eqCod").value ? Number($("#eqCod").value) : null;
  const model = $("#eqModel").value.trim();
  const cust = $("#eqCustomerFullName").value.trim();
  $("#eqApplyModelName").textContent = model || "—";
  const modelMatches = currentRows.filter((r) => r.cod !== cod && (r.model || "").trim().toLowerCase() === model.toLowerCase() && r.fs === eqFs);
  $("#eqApplyModelCount").textContent = `(${modelMatches.length + 1} машин${modelMatches.length + 1 === 1 ? "а" : ""}${
    modelMatches.length ? ": борта " + [String($("#eqLocalCode").value || "?"), ...modelMatches.map((r) => r.local_code)].join(", ") : ""
  })`;

  const applyModel = $("#eqApplyModel").checked;
  const custCheckbox = $("#eqApplyCustomer");
  custCheckbox.disabled = !applyModel || !cust;
  if (custCheckbox.disabled) custCheckbox.checked = false;
  $("#eqApplyCustL").classList.toggle("eq-na", !applyModel || !cust);
  $("#eqApplyCustName").textContent = cust || "(заказчик не указан)";
  const custMatches = modelMatches.filter((r) => (r.customer_full_name || "").trim().toLowerCase() === cust.toLowerCase());
  $("#eqApplyCustCount").textContent = `(${custMatches.length + 1} машин${custMatches.length + 1 === 1 ? "а" : ""})`;

  const note = $("#eqScopeNote");
  if (!applyModel) note.textContent = "Изменения сохранятся только для этой машины.";
  else if (custCheckbox.checked) note.textContent = `При сохранении настройки будут скопированы в ${custMatches.length} машин${custMatches.length === 1 ? "у" : ""} этой модели у заказчика. Перед сохранением покажем список.`;
  else note.textContent = `При сохранении настройки будут скопированы во все ${modelMatches.length} машин${modelMatches.length === 1 ? "у" : ""} этой модели с таким же FS. Перед сохранением покажем список.`;
}

function updateValidation() {
  const missingFields = ["eqLocalCode", "eqModel", "eqObject", "eqMine"].filter((id) => !$("#" + id).value.trim()).length;
  const missing = missingFields + (eqFs ? 0 : 1);
  $("#eqReqNote").textContent = missing ? `Не заполнено обязательных полей: ${missing}` : "";
  $("#eqSaveBtn").disabled = !!missing;
  $("#eqSaveBtn").style.opacity = missing ? 0.5 : 1;
}

function renderRepeatSection() {
  renderFsToggle();
  renderPmMaskTable();
  renderWindowTable("#eqWinPm", eqWinPm);
  renderWindowTable("#eqWinRp", eqWinRp);
  renderRepeatStatusBadge();
  renderLists();
  updateCopyFromDropdown();
  updateScopeUI();
  updateTypeScopeUI();
  updateValidation();
}

function fillForm(row) {
  $("#eqCod").value = row ? row.cod : "";
  $("#eqLocalCode").value = row ? row.local_code ?? "" : "";
  $("#eqModel").value = row ? row.model ?? "" : "";
  $("#eqObject").value = row ? row.object ?? "" : "";
  $("#eqMine").value = row ? row.mine ?? "" : "";
  $("#eqManufactureNumber").value = row ? row.manufacture_number ?? "" : "";
  $("#eqSerialNumber").value = row ? row.serial_number ?? "" : "";
  $("#eqCommissioningDate").value = row && row.commissioning_date ? row.commissioning_date.slice(0, 10) : "";
  $("#eqOwnerNumber").value = row ? row.owner_number ?? "" : "";
  $("#eqCustomerFullName").value = row ? row.customer_full_name ?? "" : "";
  $("#eqContractorFullName").value = row ? row.contractor_full_name ?? "" : "";
  $("#eqType").value = row?.machine_type_id ? String(row.machine_type_id) : "";
  $("#eqEo").checked = !!row?.has_eo;
  $("#eqApplyModel").checked = false;
  $("#eqApplyCustomer").checked = false;
  $("#eqTypeApplyModel").checked = false;
  $("#eqTypeApplyCustomer").checked = false;
  eqListFilter = { reason: "", init: "" };
  eqFs = row ? row.fs ?? "" : "";
}

async function openEquipmentModal(cod) {
  const row = cod ? currentRows.find((r) => r.cod === cod) : null;
  $("#equipmentModalTitle").textContent = row ? `Изменить оборудование №${row.cod}` : "Новая машина";
  $("#equipmentFormError").hidden = true;
  fillForm(row);
  await loadRepeatConfigForCod(row ? row.cod : null, row);
  renderRepeatSection();
  $("#equipmentModal").hidden = false;
}

function closeEquipmentModal() {
  $("#equipmentModal").hidden = true;
}

function formToParams() {
  return {
    p_local_code: $("#eqLocalCode").value.trim(),
    p_model: $("#eqModel").value.trim(),
    p_fs: eqFs,
    p_mine: $("#eqMine").value.trim(),
    p_object: $("#eqObject").value.trim(),
    p_manufacture_number: $("#eqManufactureNumber").value.trim() || null,
    p_serial_number: $("#eqSerialNumber").value.trim() || null,
    p_commissioning_date: $("#eqCommissioningDate").value || null,
    p_owner_number: $("#eqOwnerNumber").value.trim() || null,
    p_customer_full_name: $("#eqCustomerFullName").value.trim() || null,
    p_contractor_full_name: $("#eqContractorFullName").value.trim() || null,
    p_period: eqPm.TR.mask || null,
    p_coff: eqPm.TR.step === "" ? null : Number(eqPm.TR.step) / 5,
    p_period_dr1: eqPm.DR1.mask || null,
    p_coff_dr1: eqPm.DR1.step === "" ? null : Number(eqPm.DR1.step) / 5,
    p_period_dr2: eqPm.DR2.mask || null,
    p_coff_dr2: eqPm.DR2.step === "" ? null : Number(eqPm.DR2.step) / 5,
  };
}

function buildWindowsPayload() {
  return (SYS[eqFs] || []).map((sys) => ({
    fs_system: sys,
    after_pm_days: eqWinPm[sys].d === "" ? null : Number(eqWinPm[sys].d),
    after_pm_meter: eqWinPm[sys].h === "" ? null : Number(eqWinPm[sys].h),
    after_repair_days: eqWinRp[sys].d === "" ? null : Number(eqWinRp[sys].d),
    after_repair_meter: eqWinRp[sys].h === "" ? null : Number(eqWinRp[sys].h),
  }));
}

function computeScopeCods() {
  const cod = $("#eqCod").value ? Number($("#eqCod").value) : null;
  if (!$("#eqApplyModel").checked) return cod ? [cod] : ["__NEW__"];
  const model = $("#eqModel").value.trim().toLowerCase();
  const custOnly = $("#eqApplyCustomer").checked;
  const cust = $("#eqCustomerFullName").value.trim().toLowerCase();
  let matches = currentRows.filter((r) => r.cod !== cod && (r.model || "").trim().toLowerCase() === model && r.fs === eqFs);
  if (custOnly) matches = matches.filter((r) => (r.customer_full_name || "").trim().toLowerCase() === cust);
  const cods = matches.map((r) => r.cod);
  cods.push(cod ?? "__NEW__");
  return cods;
}

let pendingScopeCods = null;
let pendingTypeCods = null;

// Одно окно подтверждения на оба «Применить для одинаковых моделей»: повторные отказы и тип машины.
function openScopeConfirmModal(scopeCods, typeCods) {
  pendingScopeCods = scopeCods;
  pendingTypeCods = typeCods;
  const self = $("#eqCod").value ? Number($("#eqCod").value) : null;
  const othersOf = (cods) => cods.filter((c) => c !== "__NEW__" && c !== self);
  const repRows = currentRows.filter((r) => othersOf(scopeCods).includes(r.cod));
  const typeRows = currentRows.filter((r) => othersOf(typeCods).includes(r.cod));
  const parts = [];
  if (repRows.length) parts.push(`
    <div class="eq-confirm-h">Окно повторного отказа</div>
    <p>Окно повторного отказа и «Что учитывать» будут скопированы, кроме текущей, ещё в ${repRows.length} машин${repRows.length === 1 ? "у" : ""}:</p>
    <ul>${repRows.map((r) => `<li>${escHtml(r.model)} · борт ${escHtml(r.local_code ?? "—")} (${escHtml(r.customer_full_name || "без заказчика")})</li>`).join("")}</ul>
    <p>У каждой из них текущие значения окна и списков будут заменены.</p>`);
  if (typeRows.length) parts.push(`
    <div class="eq-confirm-h">Тип машины и ЕО</div>
    <p>Тип ${escHtml(curTypeLabel())} ${eoPhrase(curEo())}, кроме текущей, ещё ${typeRows.length} машин${typeRows.length === 1 ? "е" : "ам"}:</p>
    <ul>${typeRows.map((r) => `<li>${escHtml(r.model)} · борт ${escHtml(r.local_code ?? "—")} (${escHtml(r.customer_full_name || "без заказчика")}) — сейчас ${r.machine_type_id ? "«" + escHtml(typeName(r.machine_type_id)) + "»" : "без типа"}, ${eoLabel(!!r.has_eo)}</li>`).join("")}</ul>`);
  $("#repeatScopeConfirmTitle").textContent = repRows.length && typeRows.length ? "Подтвердите сохранение" : typeRows.length ? "Подтвердите назначение типа" : "Подтвердите копирование настроек";
  $("#repeatScopeConfirmText").innerHTML = parts.join("") + "<p>Продолжить?</p>";
  $("#repeatScopeConfirmModal").hidden = false;
}

async function doSaveEquipment(scopeCods, typeCods = []) {
  const codRaw = $("#eqCod").value;
  const params = formToParams();
  const typeId = curTypeId();
  const submitBtn = $("#eqSaveBtn");
  submitBtn.disabled = true;

  let cod;
  if (codRaw) {
    cod = Number(codRaw);
    const { error } = await supabase.rpc("update_equipment", { p_cod: cod, ...params });
    if (error) {
      showFormError(error.message);
      submitBtn.disabled = false;
      return;
    }
  } else {
    const { data, error } = await supabase.rpc("create_equipment", params);
    if (error) {
      showFormError(error.message);
      submitBtn.disabled = false;
      return;
    }
    cod = data;
  }

  const finalCods = scopeCods.map((c) => (c === "__NEW__" ? cod : c));
  const { data: userData } = await supabase.auth.getUser();
  const { error: cfgError } = await supabase.rpc("save_equipment_repeat_config", {
    p_equipment_ids: finalCods,
    p_windows: buildWindowsPayload(),
    p_work_types: eqLists.types.map((x) => ({ work_type_id: x.id, starts_window: x.checked })),
    p_reasons: eqLists.reason.map((x) => ({ reason_id: x.id, counted: x.checked })),
    p_initiators: eqLists.init.map((x) => ({ damage_id: x.id, counted: x.checked })),
    p_updated_by: userData?.user?.email || null,
  });

  if (cfgError) {
    submitBtn.disabled = false;
    showFormError(cfgError.message);
    return;
  }

  // Тип машины — отдельным вызовом: этой машине (у новой cod известен только сейчас) и, если отмечено, машинам модели.
  const typeFinal = typeCods.map((c) => (c === "__NEW__" ? cod : c));
  if (typeFinal.length) {
    let { error: tErr } = await supabase.rpc("set_equipment_type", { p_cods: typeFinal, p_type: typeId });
    if (!tErr) ({ error: tErr } = await supabase.rpc("set_equipment_eo", { p_cods: typeFinal, p_on: curEo() }));
    if (tErr) {
      submitBtn.disabled = false;
      showFormError("Машина сохранена, но тип или ЕО не назначены: " + tErr.message);
      await loadData();
      return;
    }
  }
  submitBtn.disabled = false;
  closeEquipmentModal();
  await loadData();
}

function showFormError(msg) {
  const el = $("#equipmentFormError");
  el.textContent = msg;
  el.hidden = false;
}

async function submitEquipmentForm(e) {
  e.preventDefault();
  updateValidation();
  if ($("#eqSaveBtn").disabled) return;
  $("#equipmentFormError").hidden = true;

  const self = $("#eqCod").value ? Number($("#eqCod").value) : null;
  const scopeCods = computeScopeCods();
  const typeCods = computeTypeCods();
  const hasOthers = (cods) => cods.some((c) => c !== "__NEW__" && c !== self);
  if (hasOthers(scopeCods) || hasOthers(typeCods)) {
    openScopeConfirmModal(scopeCods, typeCods);
    return;
  }
  await doSaveEquipment(scopeCods, typeCods);
}

function excelDateToIso(value) {
  if (!value) return null;
  if (typeof value === "number") {
    const d = XLSX.SSF.parse_date_code(value);
    if (!d) return null;
    return `${d.y}-${String(d.m).padStart(2, "0")}-${String(d.d).padStart(2, "0")}`;
  }
  const d = new Date(value);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

const TEMPLATE_HEADERS = [
  "Борт", "Модель", "FS", "Объект", "Шахта", "Заводской номер", "Серийный номер",
  "Дата ввода в эксплуатацию", "Номер владельца", "Заказчик", "Подрядчик",
  "Период ТО", "Шаг ТО", "Период ТО DR1", "Шаг ТО DR1", "Период ТО DR2", "Шаг ТО DR2",
];

function downloadTemplate() {
  const exampleRow = {
    "Борт": "104",
    "Модель": "CAT773E",
    "FS": "TR",
    "Объект": "ЕХУ",
    "Шахта": "Аралтобе",
    "Заводской номер": "MFG-12345",
    "Серийный номер": "SN-67890",
    "Дата ввода в эксплуатацию": "2024-01-15",
    "Номер владельца": "",
    "Заказчик": "",
    "Подрядчик": "",
    "Период ТО": "",
    "Шаг ТО": "",
    "Период ТО DR1": "",
    "Шаг ТО DR1": "",
    "Период ТО DR2": "",
    "Шаг ТО DR2": "",
  };
  const ws = XLSX.utils.json_to_sheet([exampleRow], { header: TEMPLATE_HEADERS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Оборудование");
  XLSX.writeFile(wb, "equipment_import_template.xlsx");
}

async function handleExcelFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  $("#importModal").hidden = false;
  $("#importSummary").innerHTML = `Импорт ${rows.length} строк…`;

  let created = 0;
  const errors = [];
  for (const [i, row] of rows.entries()) {
    const localCode = String(row["Борт"] ?? row["local_code"] ?? "").trim();
    const model = String(row["Модель"] ?? row["model"] ?? "").trim();
    const fs = String(row["FS"] ?? row["fs"] ?? "").trim();
    const object = String(row["Объект"] ?? row["object"] ?? "").trim();
    const mine = String(row["Шахта"] ?? row["mine"] ?? "").trim();
    if (!localCode || !model) {
      errors.push(`Строка ${i + 2}: не заполнены обязательные поля (Борт/Модель)`);
      continue;
    }
    const { error } = await supabase.rpc("create_equipment", {
      p_local_code: localCode,
      p_model: model,
      p_fs: fs || null,
      p_mine: mine || null,
      p_object: object || null,
      p_manufacture_number: String(row["Заводской номер"] ?? "").trim() || null,
      p_serial_number: String(row["Серийный номер"] ?? "").trim() || null,
      p_commissioning_date: excelDateToIso(row["Дата ввода в эксплуатацию"]),
      p_owner_number: String(row["Номер владельца"] ?? "").trim() || null,
      p_customer_full_name: String(row["Заказчик"] ?? "").trim() || null,
      p_contractor_full_name: String(row["Подрядчик"] ?? "").trim() || null,
      p_period: String(row["Период ТО"] ?? "").trim() || null,
      p_coff: row["Шаг ТО"] === "" || row["Шаг ТО"] == null ? null : Number(row["Шаг ТО"]) / 5,
      p_period_dr1: String(row["Период ТО DR1"] ?? "").trim() || null,
      p_coff_dr1: row["Шаг ТО DR1"] === "" || row["Шаг ТО DR1"] == null ? null : Number(row["Шаг ТО DR1"]) / 5,
      p_period_dr2: String(row["Период ТО DR2"] ?? "").trim() || null,
      p_coff_dr2: row["Шаг ТО DR2"] === "" || row["Шаг ТО DR2"] == null ? null : Number(row["Шаг ТО DR2"]) / 5,
    });
    if (error) errors.push(`Строка ${i + 2} (${localCode}): ${error.message}`);
    else created++;
  }

  $("#importSummary").innerHTML = `
    <p>Добавлено машин: <strong>${created}</strong> из ${rows.length}</p>
    ${errors.length ? `<p class="import-errors-title">Ошибки:</p><ul class="import-errors-list">${errors.map((e) => `<li>${e}</li>`).join("")}</ul>` : ""}
  `;
  await loadData();
}

function initDashboard() {
  if (dashboardStarted) return;
  dashboardStarted = true;
  enableTapToExpandCells();
  enableScrollButtons();

  setupFilterToggle(applyFiltersAndRender);
  initCrumbs($("#crumbs"), EQUIPMENT_PAGES, "equipment.html", equipmentParams("#filterLocalCode"));
  for (const id of ["#filterObject", "#filterMine", "#filterModel", "#filterLocalCode", "#filterStatus"]) {
    $(id).addEventListener("change", () => {
      onFilterChanged(applyFiltersAndRender);
    });
  }
  $("#filterUnconfiguredOnly").addEventListener("change", applyFiltersAndRender);
  $("#resetFilters").addEventListener("click", () => {
    $("#filterObject").value = "";
    $("#filterMine").value = "";
    $("#filterModel").value = "";
    $("#filterLocalCode").value = "";
    $("#filterType").value = "";
    $("#filterStatus").value = "active";
    $("#filterUnconfiguredOnly").checked = false;
    applyFiltersAndRender();
    $("#filterPanel").classList.remove("open");
  });

  $("#addEquipmentBtn").addEventListener("click", () => openEquipmentModal(null));
  $("#equipmentModalClose").addEventListener("click", closeEquipmentModal);
  $("#equipmentCancelBtn").addEventListener("click", closeEquipmentModal);
  $("#equipmentModal").addEventListener("click", (e) => {
    if (e.target.id === "equipmentModal") closeEquipmentModal();
  });
  $("#equipmentForm").addEventListener("submit", submitEquipmentForm);

  $("#eqFsToggle").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-fs]");
    if (!b) return;
    eqFs = b.dataset.fs;
    renderRepeatSection();
  });

  $("#equipmentForm").addEventListener("input", (e) => {
    const t = e.target;
    if (t.dataset.pmsys) {
      eqPm[t.dataset.pmsys][t.dataset.pmfield] = t.value;
      renderRepeatStatusBadge();
    } else if (t.dataset.winsys) {
      const state = t.closest("#eqWinPm") ? eqWinPm : eqWinRp;
      state[t.dataset.winsys][t.dataset.winfield] = t.value;
      renderWindowTable("#eqWinPm", eqWinPm);
      renderWindowTable("#eqWinRp", eqWinRp);
      renderRepeatStatusBadge();
    } else if (["eqLocalCode", "eqModel", "eqObject", "eqMine"].includes(t.id)) {
      updateValidation();
      if (t.id === "eqModel") updateCopyFromDropdown();
      if (t.id === "eqModel" || t.id === "eqLocalCode") { updateScopeUI(); updateTypeScopeUI(); }
    } else if (t.id === "eqCustomerFullName") {
      updateScopeUI();
      updateTypeScopeUI();
    } else if (t.dataset.l !== undefined && t.tagName === "INPUT" && t.type !== "checkbox") {
      eqListFilter[t.dataset.l] = t.value;
      drawList(t.dataset.l === "reason" ? "reason" : "init", t.dataset.l === "reason" ? "#eqL-reason" : "#eqL-init");
    }
  });
  $("#equipmentForm").addEventListener("change", (e) => {
    const t = e.target;
    if (t.dataset.pmsys) {
      eqPm[t.dataset.pmsys][t.dataset.pmfield] = t.value;
    } else if (t.dataset.lkey && t.dataset.lidx !== undefined) {
      eqLists[t.dataset.lkey][Number(t.dataset.lidx)].checked = t.checked;
      const wrap = t.dataset.lkey === "types" ? "#eqL-types" : t.dataset.lkey === "reason" ? "#eqL-reason" : "#eqL-init";
      drawList(t.dataset.lkey, wrap);
    } else if (t.id === "eqApplyModel" || t.id === "eqApplyCustomer") {
      updateScopeUI();
    } else if (t.id === "eqTypeApplyModel" || t.id === "eqTypeApplyCustomer" || t.id === "eqType" || t.id === "eqEo") {
      updateTypeScopeUI();
    }
  });
  $("#equipmentForm").addEventListener("click", (e) => {
    const b = e.target.closest("button[data-a]");
    if (!b) return;
    e.preventDefault();
    const key = b.dataset.l === "reason" ? "reason" : "init";
    for (const x of eqLists[key]) x.checked = b.dataset.a === "on";
    drawList(key, key === "reason" ? "#eqL-reason" : "#eqL-init");
  });

  $("#eqCopyFromBtn").addEventListener("click", async () => {
    const srcCod = $("#eqCopyFrom").value;
    if (!srcCod) return;
    const [winRes, wtRes, rsRes, iniRes] = await Promise.all([
      supabase.from("equipment_repeat_window").select("*").eq("equipment_id", Number(srcCod)),
      supabase.from("equipment_repeat_work_types").select("*").eq("equipment_id", Number(srcCod)),
      supabase.from("equipment_repeat_reasons").select("*").eq("equipment_id", Number(srcCod)),
      supabase.from("equipment_repeat_initiators").select("*").eq("equipment_id", Number(srcCod)),
    ]);
    const winBySys = new Map((winRes.data || []).map((w) => [w.fs_system, w]));
    for (const sys of ["TR", "DR1", "DR2"]) {
      const w = winBySys.get(sys);
      eqWinPm[sys] = w ? { d: w.after_pm_days ?? "", h: w.after_pm_meter ?? "" } : { d: "", h: "" };
      eqWinRp[sys] = w ? { d: w.after_repair_days ?? "", h: w.after_repair_meter ?? "" } : { d: "", h: "" };
    }
    const wtMap = new Map((wtRes.data || []).map((r) => [r.work_type_id, r.starts_window]));
    const rsMap = new Map((rsRes.data || []).map((r) => [r.reason_id, r.counted]));
    const iniMap = new Map((iniRes.data || []).map((r) => [r.damage_id, r.counted]));
    for (const x of eqLists.types) if (wtMap.has(x.id)) x.checked = wtMap.get(x.id);
    for (const x of eqLists.reason) if (rsMap.has(x.id)) x.checked = rsMap.get(x.id);
    for (const x of eqLists.init) if (iniMap.has(x.id)) x.checked = iniMap.get(x.id);
    renderRepeatSection();
  });

  $("#repeatScopeConfirmClose").addEventListener("click", () => {
    $("#repeatScopeConfirmModal").hidden = true;
    pendingScopeCods = null;
  });
  $("#repeatScopeConfirmCancel").addEventListener("click", () => {
    $("#repeatScopeConfirmModal").hidden = true;
    pendingScopeCods = null;
  });
  $("#repeatScopeConfirmOk").addEventListener("click", async () => {
    $("#repeatScopeConfirmModal").hidden = true;
    const cods = pendingScopeCods, tcods = pendingTypeCods || [];
    pendingScopeCods = pendingTypeCods = null;
    if (cods) await doSaveEquipment(cods, tcods);
  });

  $("#eqTypeAdd").addEventListener("click", () => saveMachineType(null));
  $("#eqTypeRename").addEventListener("click", () => {
    const id = Number($("#eqType").value);
    if (!id) { showFormError("Выберите тип, который нужно переименовать."); return; }
    saveMachineType(id);
  });
  $("#filterType").addEventListener("change", () => onFilterChanged(applyFiltersAndRender));

  $("#openPmTableBtn").addEventListener("click", openPmTableModal);
  $("#pmTableModalClose").addEventListener("click", closePmTableModal);
  $("#pmTableModalMinimize").addEventListener("click", togglePmMinimize);
  $("#pmPeriodSelect").addEventListener("change", loadPmTable);
  $("#pmAddBtn").addEventListener("click", addPmStep);

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

  $("#hardDeleteModalClose").addEventListener("click", closeHardDeleteModal);
  $("#hardDeleteCancelBtn").addEventListener("click", closeHardDeleteModal);
  $("#hardDeleteModal").addEventListener("click", (e) => {
    if (e.target.id === "hardDeleteModal") closeHardDeleteModal();
  });
  $("#hardDeleteConfirmInput").addEventListener("input", (e) => {
    const row = currentRows.find((r) => r.cod === hardDeleteCod);
    $("#hardDeleteConfirmBtn").disabled = !row || e.target.value.trim() !== String(row.local_code).trim();
  });
  $("#hardDeleteConfirmBtn").addEventListener("click", confirmHardDelete);

  $("#filterStatus").value = "active";
  loadRepeatDicts();
  supabase.rpc("my_access").then(({ data }) => {
    isAdmin = data?.role === "admin";
    $("#eqTypeAdd").hidden = $("#eqTypeRename").hidden = !isAdmin;
  });
  // Типы — до таблицы, чтобы столбец «Тип» сразу был с названиями.
  loadMachineTypes().catch((e) => showError("Не удалось загрузить типы машин: " + e.message)).finally(loadData);
}

setupAuth(supabase, "equipment.html", () => initDashboard());
