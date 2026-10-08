import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { setupAuth } from "./auth.js?v=36";
import { enableTapToExpandCells, enableScrollButtons, setupFilterToggle, onFilterChanged } from "./ui.js?v=3";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

let currentRows = [];
let dashboardStarted = false;
let searchDebounceTimer = null;

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

function isIncomplete(r) {
  return r.tr_hours == null || r.dr1_hours == null || r.dr2_hours == null;
}

async function loadData() {
  clearError();
  setLoading(true);
  try {
    const { data, error } = await supabase.from("v_autostock_plan").select("*");
    if (error) throw error;
    currentRows = data;
    updateSpareOptions();
    applyFiltersAndRender();
  } catch (e) {
    showError("Ошибка загрузки данных: " + e.message);
  } finally {
    setLoading(false);
  }
}

function updateSpareOptions() {
  const spares = [...new Set(currentRows.map((r) => r.spare).filter(Boolean))].sort();
  $("#spareOptions").innerHTML = spares.map((s) => `<option value="${s}"></option>`).join("");
}

function applyFiltersAndRender() {
  const term = $("#filterSearch").value.trim().toLowerCase();
  const incompleteOnly = $("#filterIncomplete").value === "incomplete";

  let rows = currentRows;
  if (term) {
    rows = rows.filter(
      (r) => (r.spare ?? "").toLowerCase().includes(term) || (r.descr ?? "").toLowerCase().includes(term)
    );
  }
  if (incompleteOnly) rows = rows.filter(isIncomplete);

  renderSummary(rows);
  renderTable(rows);
}

function renderSummary(rows) {
  const incomplete = currentRows.filter(isIncomplete).length;
  $("#summaryCards").innerHTML = `
    <div class="summary-card"><div class="label">Всего запчастей</div><div class="value">${currentRows.length}</div></div>
    <div class="summary-card"><div class="label">С незаполненными типами</div><div class="value">${incomplete}</div></div>
    <div class="summary-card"><div class="label">Показано (с фильтром)</div><div class="value">${rows.length}</div></div>
  `;
}

function hoursCell(v) {
  return v == null ? "—" : Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
}

function renderTable(rows) {
  $("#dataTableBody").innerHTML = rows
    .map(
      (r) => `
    <tr class="${isIncomplete(r) ? "plan-missing-row" : ""}">
      <td>${r.spare ?? "—"}</td>
      <td title="${r.descr ?? ""}">${r.descr ?? "—"}</td>
      <td>${hoursCell(r.tr_hours)}</td>
      <td>${hoursCell(r.dr1_hours)}</td>
      <td>${hoursCell(r.dr2_hours)}</td>
      <td title="${r.comment ?? ""}">${r.comment ?? "—"}</td>
      <td class="row-actions">
        <button class="btn-secondary btn-small edit-btn" data-spare="${r.spare}">Изменить</button>
        <button class="btn-danger btn-small delete-btn" data-spare="${r.spare}">Удалить</button>
      </td>
    </tr>`
    )
    .join("");

  for (const btn of $("#dataTableBody").querySelectorAll(".edit-btn")) {
    btn.addEventListener("click", () => openPlanModal(btn.dataset.spare));
  }
  for (const btn of $("#dataTableBody").querySelectorAll(".delete-btn")) {
    btn.addEventListener("click", () => deletePlan(btn.dataset.spare));
  }
}

async function deletePlan(spare) {
  const row = currentRows.find((r) => r.spare === spare);
  if (!row) return;
  if (!confirm(`Удалить все заполненные типы наработки (TR/DR1/DR2) для "${spare}"? Действие необратимо.`)) return;

  const rowIds = [row.tr_row_id, row.dr1_row_id, row.dr2_row_id].filter((id) => id != null);
  for (const id of rowIds) {
    const { error } = await supabase.rpc("delete_autostock_plan", { p_row_id: id });
    if (error) {
      showError("Ошибка удаления: " + error.message);
      return;
    }
  }
  await loadData();
}

function fillForm(row) {
  $("#pfSpare").value = row ? row.spare ?? "" : "";
  $("#pfDescription").value = row ? row.descr ?? "" : "";
  $("#pfTr").value = row && row.tr_hours != null ? row.tr_hours : "";
  $("#pfDr1").value = row && row.dr1_hours != null ? row.dr1_hours : "";
  $("#pfDr2").value = row && row.dr2_hours != null ? row.dr2_hours : "";
  $("#pfComment").value = row ? row.comment ?? "" : "";
  $("#pfTrRowId").value = row && row.tr_row_id != null ? row.tr_row_id : "";
  $("#pfDr1RowId").value = row && row.dr1_row_id != null ? row.dr1_row_id : "";
  $("#pfDr2RowId").value = row && row.dr2_row_id != null ? row.dr2_row_id : "";
}

function openPlanModal(spare) {
  const row = spare ? currentRows.find((r) => r.spare === spare) : null;
  $("#planModalTitle").textContent = row ? `Изменить "${row.spare}"` : "Новая запись";
  $("#planFormError").hidden = true;
  fillForm(row);
  $("#pfSpare").readOnly = !!row; // editing an existing spare's plan — spare code itself isn't editable here, only its hour values
  $("#planModal").hidden = false;
}

function closePlanModal() {
  $("#planModal").hidden = true;
}

async function submitPlanForm(e) {
  e.preventDefault();
  const spare = $("#pfSpare").value.trim();
  const description = $("#pfDescription").value.trim() || null;
  const comment = $("#pfComment").value.trim() || null;
  const types = [
    { hourType: 1, value: $("#pfTr").value, rowId: $("#pfTrRowId").value },
    { hourType: 2, value: $("#pfDr1").value, rowId: $("#pfDr1RowId").value },
    { hourType: 3, value: $("#pfDr2").value, rowId: $("#pfDr2RowId").value },
  ];

  if (types.every((t) => t.value === "")) {
    const el = $("#planFormError");
    el.textContent = "Заполните хотя бы один тип наработки (TR, DR1 или DR2)";
    el.hidden = false;
    return;
  }

  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  for (const t of types) {
    if (t.value !== "") {
      const { error } = await supabase.rpc("set_autostock_plan", {
        p_spare: spare,
        p_description: description,
        p_hour_type: t.hourType,
        p_planned_hours: Number(t.value),
        p_comment: comment,
      });
      if (error) {
        submitBtn.disabled = false;
        const el = $("#planFormError");
        el.textContent = error.message;
        el.hidden = false;
        return;
      }
    } else if (t.rowId !== "") {
      // field was cleared while editing an existing entry — remove that type
      const { error } = await supabase.rpc("delete_autostock_plan", { p_row_id: Number(t.rowId) });
      if (error) {
        submitBtn.disabled = false;
        const el = $("#planFormError");
        el.textContent = error.message;
        el.hidden = false;
        return;
      }
    }
  }

  submitBtn.disabled = false;
  closePlanModal();
  await loadData();
}

const TEMPLATE_HEADERS = ["Запасная часть", "Описание", "TR (ч)", "DR1 (ч)", "DR2 (ч)", "Комментарий"];

function downloadTemplate() {
  const exampleRow = {
    "Запасная часть": "0075500578",
    "Описание": "Шланг гидравлический",
    "TR (ч)": 4000,
    "DR1 (ч)": "",
    "DR2 (ч)": "",
    "Комментарий": "",
  };
  const ws = XLSX.utils.json_to_sheet([exampleRow], { header: TEMPLATE_HEADERS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Наработки");
  XLSX.writeFile(wb, "autostock_plan_import_template.xlsx");
}

async function handleExcelFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  $("#importModal").hidden = false;
  $("#importSummary").innerHTML = `Импорт ${rows.length} строк…`;

  // One Excel row = one spare with up to 3 hour columns. Collapse rows that repeat
  // the same spare within this file (last occurrence wins) before calling the RPC,
  // otherwise a repeated spare would be counted as "updated" twice for the same value.
  const parsed = [];
  const errors = [];
  for (const [i, row] of rows.entries()) {
    const spare = String(row["Запасная часть"] ?? row["spare"] ?? "").trim();
    if (!spare) {
      errors.push(`Строка ${i + 2}: не заполнено обязательное поле (Запасная часть)`);
      continue;
    }
    const trRaw = row["TR (ч)"] ?? row["tr"] ?? "";
    const dr1Raw = row["DR1 (ч)"] ?? row["dr1"] ?? "";
    const dr2Raw = row["DR2 (ч)"] ?? row["dr2"] ?? "";
    if (trRaw === "" && dr1Raw === "" && dr2Raw === "") {
      errors.push(`Строка ${i + 2} (${spare}): не заполнен ни один тип наработки (TR/DR1/DR2)`);
      continue;
    }
    parsed.push({
      rowNum: i + 2,
      spare,
      description: String(row["Описание"] ?? row["description"] ?? "").trim() || null,
      comment: String(row["Комментарий"] ?? row["comment"] ?? "").trim() || null,
      tr: trRaw === "" ? null : Number(trRaw),
      dr1: dr1Raw === "" ? null : Number(dr1Raw),
      dr2: dr2Raw === "" ? null : Number(dr2Raw),
      key: spare.toLowerCase(),
    });
  }

  const byKey = new Map();
  let duplicateRowsInFile = 0;
  for (const p of parsed) {
    if (byKey.has(p.key)) duplicateRowsInFile++;
    byKey.set(p.key, p); // last occurrence wins
  }

  // Classify each FILE ROW (one spare), not each TR/DR1/DR2 record, so the summary
  // matches what the user actually uploaded: was this part number new, or already there?
  const existingSpares = new Set(currentRows.map((r) => (r.spare ?? "").toLowerCase().trim()));

  let newPartRows = 0;
  let updatedPartRows = 0;
  for (const p of byKey.values()) {
    const alreadyExisted = existingSpares.has(p.key);
    let rowFailed = false;
    const types = [
      { hourType: 1, value: p.tr },
      { hourType: 2, value: p.dr1 },
      { hourType: 3, value: p.dr2 },
    ];
    for (const t of types) {
      if (t.value == null) continue;
      const { error } = await supabase.rpc("set_autostock_plan", {
        p_spare: p.spare,
        p_description: p.description,
        p_hour_type: t.hourType,
        p_planned_hours: t.value,
        p_comment: p.comment,
      });
      if (error) {
        errors.push(`Строка ${p.rowNum} (${p.spare}, тип ${t.hourType}): ${error.message}`);
        rowFailed = true;
      }
    }
    if (!rowFailed) {
      if (alreadyExisted) updatedPartRows++;
      else newPartRows++;
    }
  }

  $("#importSummary").innerHTML = `
    <p>Загружено строк: <strong>${newPartRows}</strong> из ${rows.length} (новые парт номера)</p>
    <p>Обновлены плановые наработки : <strong>${updatedPartRows}</strong> из ${rows.length} (обновлены наработки)</p>
    ${duplicateRowsInFile ? `<p>Повторяющихся строк в самом файле (та же запчасть): <strong>${duplicateRowsInFile}</strong> — учтена только последняя из них.</p>` : ""}
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
  $("#filterSearch").addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => onFilterChanged(applyFiltersAndRender), 300);
  });
  $("#filterIncomplete").addEventListener("change", () => onFilterChanged(applyFiltersAndRender));
  $("#resetFilters").addEventListener("click", () => {
    $("#filterSearch").value = "";
    $("#filterIncomplete").value = "";
    applyFiltersAndRender();
    $("#filterPanel").classList.remove("open");
  });

  $("#addPlanBtn").addEventListener("click", () => openPlanModal(null));
  $("#planModalClose").addEventListener("click", closePlanModal);
  $("#planCancelBtn").addEventListener("click", closePlanModal);
  $("#planModal").addEventListener("click", (e) => {
    if (e.target.id === "planModal") closePlanModal();
  });
  $("#planForm").addEventListener("submit", submitPlanForm);

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

  loadData();
}

setupAuth(supabase, "autostock-plan.html", () => initDashboard());
