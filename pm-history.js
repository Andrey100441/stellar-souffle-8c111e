import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { setupAuth } from "./auth.js?v=36";
import { loadEquipmentList, populateSelect, updateMineOptions, updateModelAndCodeOptions } from "./filters.js?v=1";
import { initCrumbs, applyUrlFilters, equipmentParams, equipmentSteps, EQUIPMENT_PAGES } from "./crumbs.js?v=2";
import { enableTapToExpandCells, enableScrollButtons, setupFilterToggle, onFilterChanged } from "./ui.js?v=3";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const TABLE_PAGE_SIZE = 200;
let currentRows = [];
let currentPage = 1;
let equipmentList = [];
let dashboardStarted = false;
let categoryFilter = "all";

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

async function loadFilterOptions() {
  try {
    equipmentList = await loadEquipmentList(supabase);
  } catch (e) {
    showError("Не удалось загрузить справочники: " + e.message);
    return;
  }
  const objects = [...new Set(equipmentList.map((d) => d.object).filter(Boolean))].sort();
  populateSelect("#filterObject", objects);
  updateMineOptions(equipmentList);
  updateModelAndCodeOptions(equipmentList);
}

function buildQuery(selectOpts) {
  const from = $("#filterFrom").value;
  const to = $("#filterTo").value;
  const object = $("#filterObject").value;
  const mine = $("#filterMine").value;
  const model = $("#filterModel").value;
  const code = $("#filterCode").value;

  let q = supabase.from("v_pm_history").select("*", selectOpts).order("pm_date", { ascending: false }).order("id", { ascending: false });
  if (from) q = q.gte("pm_date", from);
  if (to) q = q.lte("pm_date", to);
  if (object) q = q.eq("object", object);
  if (mine) q = q.eq("mine", mine);
  if (model) q = q.eq("model", model);
  if (code) q = q.eq("local_code", code);
  return q;
}

// Guards against a slower, older request resolving after a newer, narrower one and
// silently overwriting the UI with stale data — rapid successive filter changes can
// race the paginated fetches below out of order.
let loadRequestId = 0;

// Удобочитаемый номер наряда (Т-000123) — из функции БД wo_labels; ключом остаётся числовой номер.
const woLabel = new Map();
const lbl = (no) => woLabel.get(Number(no)) || no;
async function loadWoLabels(orders) {
  const need = [...new Set(orders.filter((o) => o != null && !woLabel.has(Number(o))).map(Number))];
  const chunks = [];
  for (let i = 0; i < need.length; i += 2000) chunks.push(need.slice(i, i + 2000));
  const res = await Promise.all(chunks.map((c) => supabase.rpc("wo_labels", { p_orders: c })));
  for (const { data, error } of res) {
    if (error) continue; // без номеров — показываем числовые
    for (const [k, v] of Object.entries(data || {})) woLabel.set(Number(k), v);
  }
}

async function loadData() {
  const myRequestId = ++loadRequestId;
  clearError();
  setLoading(true);
  try {
    const PAGE_SIZE = 1000;
    // Первая страница и общий count — одним запросом (count в заголовке Content-Range),
    // а не отдельным head-запросом перед выгрузкой: минус одно последовательное ожидание.
    const first = await buildQuery({ count: "exact" }).range(0, PAGE_SIZE - 1);
    if (first.error) throw first.error;

    let data = first.data || [];
    const total = first.count ?? data.length;
    if (total > PAGE_SIZE) {
      const pageCount = Math.ceil(total / PAGE_SIZE);
      const pages = await Promise.all(
        Array.from({ length: pageCount - 1 }, (_, i) => {
          const from = (i + 1) * PAGE_SIZE;
          return buildQuery().range(from, from + PAGE_SIZE - 1);
        })
      );
      for (const { data: page, error } of pages) {
        if (error) throw error;
        data = data.concat(page);
      }
    }

    if (myRequestId !== loadRequestId) return;
    await loadWoLabels(data.map((r) => r.wo));
    if (myRequestId !== loadRequestId) return;
    currentRows = data;
    currentPage = 1;
    renderSummary(currentRows);
    renderTable(getFilteredRows(currentRows));
  } catch (e) {
    if (myRequestId !== loadRequestId) return;
    showError("Ошибка загрузки данных: " + e.message);
  } finally {
    if (myRequestId === loadRequestId) setLoading(false);
  }
}

function getFilteredRows(rows) {
  switch (categoryFilter) {
    case "late":
      return rows.filter((r) => r.time_difference != null && r.time_difference > 0);
    case "early":
      return rows.filter((r) => r.time_difference != null && r.time_difference < 0);
    case "onTime":
      return rows.filter((r) => r.time_difference === 0);
    default:
      return rows;
  }
}

function renderSummary(rows) {
  const late = rows.filter((r) => r.time_difference != null && r.time_difference > 0).length;
  const early = rows.filter((r) => r.time_difference != null && r.time_difference < 0).length;
  const onTime = rows.filter((r) => r.time_difference === 0).length;
  const cardIsActive = (cat) => (categoryFilter === cat ? " active" : "");
  $("#summaryCards").innerHTML = `
    <div class="summary-card clickable${cardIsActive("all")}" data-category="all"><div class="label">Всего ТО</div><div class="value">${rows.length}</div></div>
    <div class="summary-card clickable${cardIsActive("late")}" data-category="late"><div class="label">Сделано позже плана</div><div class="value bad">${late}</div></div>
    <div class="summary-card clickable${cardIsActive("early")}" data-category="early"><div class="label">Сделано раньше плана</div><div class="value warn">${early}</div></div>
    <div class="summary-card clickable${cardIsActive("onTime")}" data-category="onTime"><div class="label">Точно в срок</div><div class="value good">${onTime}</div></div>
  `;
  $("#summaryCards")
    .querySelectorAll(".summary-card")
    .forEach((card) => {
      card.addEventListener("click", () => {
        const cat = card.dataset.category;
        categoryFilter = categoryFilter === cat ? "all" : cat;
        currentPage = 1;
        renderSummary(currentRows);
        renderTable(getFilteredRows(currentRows));
      });
    });
}

function dateLabel(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}.${d.getUTCFullYear()}`;
}

function fmtNum(v) {
  return v == null ? "—" : Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
}

function renderTable(rows) {
  const totalPages = Math.max(1, Math.ceil(rows.length / TABLE_PAGE_SIZE));
  currentPage = Math.min(Math.max(1, currentPage), totalPages);
  const start = (currentPage - 1) * TABLE_PAGE_SIZE;
  const pageRows = rows.slice(start, start + TABLE_PAGE_SIZE);

  $("#dataTableBody").innerHTML = pageRows
    .map(
      (r) => `
    <tr>
      <td>${dateLabel(r.pm_date)}</td>
      <td title="${r.total_duration ?? ""}">${r.total_duration ?? "—"}</td>
      <td>${esc(r.object ?? "—")}</td>
      <td>${esc(r.mine ?? "—")}</td>
      <td title="${esc(r.model ?? "")}">${esc(r.model ?? "—")}</td>
      <td>${esc(r.local_code ?? "—")}</td>
      <td>${esc(r.fs ?? "—")}</td>
      <td title="${esc(r.type_of_pm ?? "")}">${esc(r.type_of_pm ?? "—")}</td>
      <td>${r.pm_number != null && r.cycle_length != null ? `${r.pm_number}/${r.cycle_length}` : "—"}</td>
      <td>${
        r.time_difference != null
          ? `<button class="detail-btn diff-btn${r.time_difference > 0 ? " diff-late" : r.time_difference === 0 ? " diff-ontime" : ""}" data-wo="${r.wo ?? ""}" data-fp="${fmtNum(r.actual_time)} / ${fmtNum(r.scheduled_time)}" data-smh="${fmtNum(r.smh_at_pm)}">${fmtNum(r.time_difference)}</button>`
          : "—"
      }</td>
      <td>${
        r.staff_hours
          ? `<button class="detail-btn staff-btn" data-order="${r.wo}">${fmtNum(r.staff_hours)}</button>`
          : "—"
      }</td>
      <td>${
        r.parts_count
          ? `<button class="detail-btn cost-btn" data-order="${r.wo}">${fmtNum(r.total_cost)}</button>`
          : "—"
      }</td>
      <td title="${esc(r.comment ?? "")}">${esc(r.comment ?? "—")}</td>
    </tr>`
    )
    .join("");

  for (const btn of $("#dataTableBody").querySelectorAll(".diff-btn")) {
    btn.addEventListener("click", () => openDiffModal(btn.dataset.wo, btn.dataset.fp, btn.dataset.smh));
  }
  for (const btn of $("#dataTableBody").querySelectorAll(".staff-btn")) {
    btn.addEventListener("click", () => openStaffModal(btn.dataset.order));
  }
  for (const btn of $("#dataTableBody").querySelectorAll(".cost-btn")) {
    btn.addEventListener("click", () => openCostModal(btn.dataset.order));
  }

  renderPagination(totalPages, rows.length);
}

function renderPagination(totalPages, totalRows) {
  const el = $("#pagination");
  if (totalRows === 0) {
    el.innerHTML = "";
    return;
  }
  const start = (currentPage - 1) * TABLE_PAGE_SIZE + 1;
  const end = Math.min(currentPage * TABLE_PAGE_SIZE, totalRows);
  el.innerHTML = `
    <button id="pagePrev" class="btn-secondary" ${currentPage <= 1 ? "disabled" : ""}>← Назад</button>
    <span class="page-info">${start}–${end} из ${totalRows} (стр. ${currentPage} из ${totalPages})</span>
    <button id="pageNext" class="btn-secondary" ${currentPage >= totalPages ? "disabled" : ""}>Вперёд →</button>
  `;
  $("#pagePrev")?.addEventListener("click", () => {
    currentPage--;
    renderTable(getFilteredRows(currentRows));
  });
  $("#pageNext")?.addEventListener("click", () => {
    currentPage++;
    renderTable(getFilteredRows(currentRows));
  });
}

function openDiffModal(wo, periodFp, smhAtPm) {
  $("#diffTableBody").innerHTML = `
    <tr><td>№ наряда</td><td>${wo ? lbl(wo) : "—"}</td></tr>
    <tr><td>Период ТО ф/п</td><td>${periodFp}</td></tr>
    <tr><td>Наработка на момент проведения ТО, ч</td><td>${smhAtPm}</td></tr>
  `;
  $("#diffModal").hidden = false;
}

function closeDiffModal() {
  $("#diffModal").hidden = true;
}

const NO_STAFF_VALUES = ["нет данных", "Нет данных"];

async function openStaffModal(workOrder) {
  $("#staffModalTitle").textContent = `Персонал по наряду № ${lbl(workOrder)}`;
  $("#staffTableBody").innerHTML = `<tr><td colspan="2">Загрузка…</td></tr>`;
  $("#staffModal").hidden = false;

  const { data, error } = await supabase.from("v_staff_details").select("famaly, hours").eq("work_order", workOrder);
  if (error) {
    $("#staffTableBody").innerHTML = `<tr><td colspan="2">Ошибка загрузки: ${error.message}</td></tr>`;
    return;
  }

  const byPerson = new Map();
  for (const r of data) {
    if (!r.famaly || NO_STAFF_VALUES.includes(r.famaly)) continue;
    byPerson.set(r.famaly, (byPerson.get(r.famaly) || 0) + (Number(r.hours) || 0));
  }
  const people = [...byPerson.entries()].sort((a, b) => b[1] - a[1]);

  $("#staffTableBody").innerHTML = people.length
    ? people.map(([famaly, hours]) => `<tr><td>${famaly}</td><td>${fmtNum(hours)}</td></tr>`).join("")
    : `<tr><td colspan="2">Персонал не назначен</td></tr>`;
}

function closeStaffModal() {
  $("#staffModal").hidden = true;
}

async function openCostModal(workOrder) {
  $("#costModalTitle").textContent = `Запасные части по наряду № ${lbl(workOrder)}`;
  $("#costTableBody").innerHTML = `<tr><td colspan="4">Загрузка…</td></tr>`;
  $("#costTableFoot").innerHTML = "";
  $("#costModal").hidden = false;

  const { data, error } = await supabase
    .from("v_repair_details")
    .select("spare, spare_index, spare_descr, spare_qty, cost")
    .eq("work_order", workOrder)
    .not("spare", "is", null);
  if (error) {
    $("#costTableBody").innerHTML = `<tr><td colspan="4">Ошибка загрузки: ${error.message}</td></tr>`;
    return;
  }

  $("#costTableBody").innerHTML = data.length
    ? data
        .map(
          (r) => `
    <tr>
      <td>${esc(r.spare_descr ?? r.spare ?? "—")}</td>
      <td>${esc(r.spare_index ?? "—")}</td>
      <td>${r.spare_qty ?? "—"}</td>
      <td>${r.spare && r.cost == null ? '<span style="color:#999" title="В ценовом справочнике нет цены этой запчасти на год наряда">нет цены</span>' : fmtNum(r.cost)}</td>
    </tr>`
        )
        .join("")
    : `<tr><td colspan="4">Запасные части не указаны</td></tr>`;

  const totalCost = data.reduce((a, r) => a + (Number(r.cost) || 0), 0);
  $("#costTableFoot").innerHTML = `<tr><td colspan="3"><strong>Общая стоимость</strong></td><td><strong>${fmtNum(totalCost)}</strong></td></tr>`;
}

function closeCostModal() {
  $("#costModal").hidden = true;
}

function exportExcel() {
  const wsData = getFilteredRows(currentRows).map((r) => ({
    "Дата ТО": dateLabel(r.pm_date),
    "№ наряда": lbl(r.wo),
    "Время ремонта": r.total_duration,
    Объект: r.object,
    Шахта: r.mine,
    Модель: r.model,
    Борт: r.local_code,
    FS: r.fs,
    "Тип ТО": r.type_of_pm,
    "Шаг цикла": r.pm_number != null && r.cycle_length != null ? `${r.pm_number}/${r.cycle_length}` : "",
    "Период ТО ф/п": `${fmtNum(r.actual_time)} / ${fmtNum(r.scheduled_time)}`,
    "Разница, ч": r.time_difference,
    "Наработка на момент проведения ТО, ч": r.smh_at_pm,
    "Время работы": r.staff_hours ?? "",
    "Стоимость ремонта": r.parts_count ? r.total_cost : "",
    Комментарий: r.comment,
  }));
  const ws = XLSX.utils.json_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "История ТО");
  XLSX.writeFile(wb, `pm_history_${new Date().toISOString().slice(0, 10)}.xlsx`);
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

  setupFilterToggle(loadData);
  initCrumbs($("#crumbs"), EQUIPMENT_PAGES, "pm-history.html", equipmentParams());
  $("#filterFrom").addEventListener("change", () => onFilterChanged(loadData));
  $("#filterTo").addEventListener("change", () => onFilterChanged(loadData));
  $("#filterObject").addEventListener("change", () => {
    updateMineOptions(equipmentList);
    updateModelAndCodeOptions(equipmentList);
    onFilterChanged(loadData);
  });
  $("#filterMine").addEventListener("change", () => {
    updateModelAndCodeOptions(equipmentList);
    onFilterChanged(loadData);
  });
  $("#filterModel").addEventListener("change", () => {
    updateModelAndCodeOptions(equipmentList);
    onFilterChanged(loadData);
  });
  $("#filterCode").addEventListener("change", () => onFilterChanged(loadData));
  $("#resetFilters").addEventListener("click", () => {
    $("#filterFrom").value = "";
    $("#filterTo").value = "";
    $("#filterObject").value = "";
    $("#filterMine").value = "";
    $("#filterModel").value = "";
    $("#filterCode").value = "";
    categoryFilter = "all";
    updateMineOptions(equipmentList);
    updateModelAndCodeOptions(equipmentList);
    loadData();
    $("#filterPanel").classList.remove("open");
  });

  $("#exportExcel").addEventListener("click", exportExcel);

  $("#diffModalClose").addEventListener("click", closeDiffModal);
  $("#diffModal").addEventListener("click", (e) => {
    if (e.target.id === "diffModal") closeDiffModal();
  });
  $("#staffModalClose").addEventListener("click", closeStaffModal);
  $("#staffModal").addEventListener("click", (e) => {
    if (e.target.id === "staffModal") closeStaffModal();
  });
  $("#costModalClose").addEventListener("click", closeCostModal);
  $("#costModal").addEventListener("click", (e) => {
    if (e.target.id === "costModal") closeCostModal();
  });

  loadFilterOptions().then(() => {
    applyUrlFilters(equipmentSteps("#filterCode", cascade)); // пришли по крошкам с другой формы
    return loadData();
  });
}

setupAuth(supabase, "pm-history.html", () => initDashboard());
