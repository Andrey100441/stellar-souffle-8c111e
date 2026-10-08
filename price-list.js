import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as XLSX from "https://esm.sh/xlsx@0.18.5";
import { setupAuth } from "./auth.js?v=36";
import { guardUnsaved, snapshot } from "./unsaved.js?v=1";
import { enableTapToExpandCells, enableScrollButtons, setupFilterToggle, onFilterChanged } from "./ui.js?v=3";
import { populateSelect } from "./filters.js?v=1";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const PAGE_SIZE = 200;
let currentRows = [];
let currentPage = 1;
let totalRows = 0;
let dashboardStarted = false;
let searchDebounceTimer = null;
// Шахты (с объектом) — у каждой шахты свой ценник.
let priceMines = [];

const $ = (sel) => document.querySelector(sel);
// Тексты из базы и из загружаемых файлов вставляются в HTML — экранируем.
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

function formatPrice(v) {
  return v == null ? "—" : Number(v).toLocaleString("ru-RU", { maximumFractionDigits: 2 });
}

async function loadYearOptions() {
  const { data, error } = await supabase.from("v_price_years").select("price_for_year");
  if (error) return;
  const currentYear = new Date().getFullYear();
  const yearSet = new Set([...data.map((y) => y.price_for_year), currentYear, currentYear + 1]);
  populateSelect("#filterYear", [...yearSet].sort((a, b) => b - a));
  $("#pfYear").innerHTML = [...yearSet]
    .sort((a, b) => b - a)
    .map((y) => `<option value="${y}">${y}</option>`)
    .join("");
}

async function loadMines() {
  const { data, error } = await supabase.from("v_price_mines").select("object, mine");
  if (error) {
    showError("Ошибка загрузки списка шахт: " + error.message);
    return;
  }
  priceMines = data;
  populateSelect("#filterObject", [...new Set(data.map((m) => m.object).filter(Boolean))].sort());
  updateFilterMineOptions();
  // В форме шахты сгруппированы по объектам.
  const byObject = new Map();
  for (const m of data) {
    const key = m.object ?? "—";
    if (!byObject.has(key)) byObject.set(key, []);
    byObject.get(key).push(m.mine);
  }
  $("#pfMine").innerHTML =
    '<option value="">— выберите шахту —</option>' +
    [...byObject.entries()]
      .map(([obj, mines]) => `<optgroup label="${esc(obj)}">${mines.map((mn) => `<option value="${esc(mn)}">${esc(mn)}</option>`).join("")}</optgroup>`)
      .join("");
}

function updateFilterMineOptions() {
  const obj = $("#filterObject").value;
  const sel = $("#filterMine");
  const prev = sel.value;
  const mines = priceMines.filter((m) => !obj || m.object === obj).map((m) => m.mine).sort();
  sel.innerHTML = '<option value="">Все</option>' + mines.map((m) => `<option value="${esc(m)}">${esc(m)}</option>`).join("");
  sel.value = mines.includes(prev) ? prev : "";
}

function buildQuery(opts) {
  let q = supabase
    .from("v_price_list")
    .select("*", opts)
    .order("spare", { ascending: true })
    .order("price_for_year", { ascending: false })
    .order("mine", { ascending: true });
  const obj = $("#filterObject").value;
  const mine = $("#filterMine").value;
  if (obj) q = q.eq("object", obj);
  if (mine) q = q.eq("mine", mine);
  const year = $("#filterYear").value;
  const term = $("#filterSearch").value.trim().replace(/,/g, "");
  if (year) q = q.eq("price_for_year", Number(year));
  if (term) q = q.or(`spare.ilike.%${term}%,description.ilike.%${term}%`);
  return q;
}

// Guards against a slower, older request resolving after a newer, narrower one and
// silently overwriting the UI with stale data — rapid successive filter changes can
// race the fetch below out of order.
let loadRequestId = 0;

async function loadData() {
  const myRequestId = ++loadRequestId;
  clearError();
  setLoading(true);
  try {
    // Страница и общий count — одним запросом (count приходит в заголовке Content-Range),
    // а не отдельным head-запросом перед ней. Если после удаления/фильтра текущая
    // страница оказалась за концом списка — один дозапрос уже правильной страницы.
    currentPage = Math.max(1, currentPage);
    let from = (currentPage - 1) * PAGE_SIZE;
    let res = await buildQuery({ count: "exact" }).range(from, from + PAGE_SIZE - 1);
    if (res.error && res.status !== 416) throw res.error;
    totalRows = res.count ?? 0;
    const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));
    if (currentPage > totalPages) {
      currentPage = totalPages;
      from = (currentPage - 1) * PAGE_SIZE;
      res = await buildQuery({ count: "exact" }).range(from, from + PAGE_SIZE - 1);
      totalRows = res.count ?? totalRows;
    }
    const { data, error } = res;
    if (error) throw error;
    if (myRequestId !== loadRequestId) return;
    currentRows = data;
    updateSpareOptions();
    renderSummary();
    renderTable(currentRows);
    renderPagination(totalPages);
  } catch (e) {
    if (myRequestId !== loadRequestId) return;
    showError("Ошибка загрузки данных: " + e.message);
  } finally {
    if (myRequestId === loadRequestId) setLoading(false);
  }
}

function updateSpareOptions() {
  const spares = [...new Set(currentRows.map((r) => r.spare).filter(Boolean))].sort();
  $("#spareOptions").innerHTML = spares.map((s) => `<option value="${s}"></option>`).join("");
}

function renderSummary() {
  $("#summaryCards").innerHTML = `
    <div class="summary-card"><div class="label">Всего записей ценника</div><div class="value">${totalRows}</div></div>
  `;
}

function renderTable(rows) {
  $("#dataTableBody").innerHTML = rows
    .map(
      (r) => `
    <tr>
      <td>${esc(r.object ?? "—")}</td>
      <td>${esc(r.mine ?? "—")}</td>
      <td>${r.spare ?? "—"}</td>
      <td title="${r.description ?? ""}">${r.description ?? "—"}</td>
      <td>${formatPrice(r.price)}</td>
      <td>${r.unit ?? "—"}</td>
      <td>${r.price_for_year ?? "—"}</td>
      <td class="row-actions">
        <button class="btn-secondary btn-small edit-btn" data-cod="${r.cod}">Изменить</button>
        <button class="btn-danger btn-small delete-btn" data-cod="${r.cod}">Удалить</button>
      </td>
    </tr>`
    )
    .join("");

  for (const btn of $("#dataTableBody").querySelectorAll(".edit-btn")) {
    btn.addEventListener("click", () => openPriceModal(Number(btn.dataset.cod)));
  }
  for (const btn of $("#dataTableBody").querySelectorAll(".delete-btn")) {
    btn.addEventListener("click", () => deletePrice(Number(btn.dataset.cod)));
  }
}

function renderPagination(totalPages) {
  const el = $("#pagination");
  if (totalRows === 0) {
    el.innerHTML = "";
    return;
  }
  const start = (currentPage - 1) * PAGE_SIZE + 1;
  const end = Math.min(currentPage * PAGE_SIZE, totalRows);
  el.innerHTML = `
    <button id="pagePrev" class="btn-secondary" ${currentPage <= 1 ? "disabled" : ""}>← Назад</button>
    <span class="page-info">${start}–${end} из ${totalRows} (стр. ${currentPage} из ${totalPages})</span>
    <button id="pageNext" class="btn-secondary" ${currentPage >= totalPages ? "disabled" : ""}>Вперёд →</button>
  `;
  $("#pagePrev")?.addEventListener("click", () => {
    currentPage--;
    loadData();
  });
  $("#pageNext")?.addEventListener("click", () => {
    currentPage++;
    loadData();
  });
}

async function deletePrice(cod) {
  const row = currentRows.find((r) => r.cod === cod);
  if (!row) return;
  if (!confirm(`Удалить цену на "${row.spare}" за ${row.price_for_year} год для шахты ${row.mine}? Действие необратимо.`)) return;

  const { error } = await supabase.rpc("delete_price_entry", { p_cod: cod });
  if (error) {
    showError("Ошибка удаления: " + error.message);
    return;
  }
  await loadData();
}

function fillForm(row) {
  $("#pfCod").value = row ? row.cod : "";
  // Новая цена — по умолчанию на шахту из фильтра.
  $("#pfMine").value = row ? row.mine ?? "" : $("#filterMine").value;
  $("#pfSpare").value = row ? row.spare ?? "" : "";
  $("#pfDescription").value = row ? row.description ?? "" : "";
  $("#pfPrice").value = row && row.price != null ? row.price : "";
  $("#pfUnit").value = row ? row.unit ?? "" : "";
  $("#pfYear").value = row ? row.price_for_year ?? "" : new Date().getFullYear();
}

function openPriceModal(cod) {
  const row = cod ? currentRows.find((r) => r.cod === cod) : null;
  $("#priceModalTitle").textContent = row ? "Изменить цену" : "Новая цена";
  $("#priceFormError").hidden = true;
  fillForm(row);
  $("#priceModal").hidden = false;
  priceFormOrig = snapshot($("#priceForm")); // для «есть несохранённые изменения»
}
// Открыта форма с изменёнными полями, а пользователь уходит со страницы — предложить сохранить.
let priceFormOrig = null;
const priceFormDirty = () => !$("#priceModal").hidden && priceFormOrig != null && snapshot($("#priceForm")) !== priceFormOrig;
guardUnsaved({
  isDirty: priceFormDirty,
  describe: () => [$("#priceModalTitle").textContent + " — форма не сохранена"],
  save: () => submitPriceForm({ preventDefault() {}, target: $("#priceForm") }),
});

function closePriceModal() {
  $("#priceModal").hidden = true;
}

function formToParams() {
  return {
    p_spare: $("#pfSpare").value.trim(),
    p_description: $("#pfDescription").value.trim() || null,
    p_price: $("#pfPrice").value === "" ? null : Number($("#pfPrice").value),
    p_unit: $("#pfUnit").value.trim() || null,
    p_price_for_year: $("#pfYear").value === "" ? null : Number($("#pfYear").value),
    p_mine: $("#pfMine").value || null,
  };
}

async function submitPriceForm(e) {
  e.preventDefault();
  const cod = $("#pfCod").value;
  const params = formToParams();
  const submitBtn = e.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;

  const { error } = cod
    ? await supabase.rpc("update_price_entry", { p_cod: Number(cod), ...params })
    : await supabase.rpc("create_price_entry", params);

  submitBtn.disabled = false;
  if (error) {
    const el = $("#priceFormError");
    el.textContent = error.message;
    el.hidden = false;
    return;
  }
  closePriceModal();
  await loadData();
}

async function exportPriceList() {
  const btn = $("#exportPriceBtn");
  btn.disabled = true;
  btn.textContent = "Выгрузка…";
  try {
    const FETCH_PAGE_SIZE = 1000;
    const { count, error: countError } = await buildQuery({ count: "exact", head: true });
    if (countError) throw countError;
    const total = count ?? 0;

    let rows = [];
    if (total > 0) {
      const pageCount = Math.ceil(total / FETCH_PAGE_SIZE);
      const pages = await Promise.all(
        Array.from({ length: pageCount }, (_, i) => {
          const from = i * FETCH_PAGE_SIZE;
          return buildQuery().range(from, from + FETCH_PAGE_SIZE - 1);
        })
      );
      for (const { data: page, error } of pages) {
        if (error) throw error;
        rows = rows.concat(page);
      }
    }

    const wsData = rows.map((r) => ({
      "Объект": r.object,
      "Шахта": r.mine,
      "Запасная часть": r.spare,
      "Описание": r.description,
      "Цена": r.price,
      "Единица измерения": r.unit,
      "Год": r.price_for_year,
    }));
    const ws = XLSX.utils.json_to_sheet(wsData, { header: ["Объект", ...TEMPLATE_HEADERS] });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Ценник");
    XLSX.writeFile(wb, `price_list_${new Date().toISOString().slice(0, 10)}.xlsx`);

    const obj = $("#filterObject").value;
    const mine = $("#filterMine").value;
    const year = $("#filterYear").value;
    const term = $("#filterSearch").value.trim();
    const filterNote = [obj ? `объект=${obj}` : null, mine ? `шахта=${mine}` : null, year ? `год=${year}` : null, term ? `поиск="${term}"` : null]
      .filter(Boolean)
      .join(", ");
    supabase.rpc("log_price_audit", {
      p_action: "export",
      p_spare: null,
      p_price_for_year: null,
      p_detail: `выгружено строк: ${rows.length}` + (filterNote ? ` (фильтр: ${filterNote})` : ""),
    }).then(() => {}, () => {}); // построитель запросов ленивый: без .then() запрос не уходит
  } catch (e) {
    showError("Ошибка выгрузки: " + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "⬇ Скачать справочник";
  }
}

function dateTimeLabel(ts) {
  if (!ts) return "—";
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm}.${d.getFullYear()} ${hh}:${mi}`;
}

const ACTION_LABELS = {
  view: "Просмотр",
  export: "Выгрузка",
  import: "Импорт из Excel",
  create: "Добавление",
  update: "Изменение",
  delete: "Удаление",
};

let currentAuditRows = [];

async function openAuditLogModal() {
  $("#auditLogModal").hidden = false;
  $("#auditLogTableBody").innerHTML = `<tr><td colspan="6">Загрузка…</td></tr>`;
  const { data, error } = await supabase.from("v_price_audit_log").select("*").limit(300);
  if (error) {
    $("#auditLogTableBody").innerHTML = `<tr><td colspan="6">Ошибка загрузки: ${error.message}</td></tr>`;
    return;
  }
  currentAuditRows = data;
  $("#auditLogTableBody").innerHTML = data.length
    ? data
        .map(
          (r) => `
    <tr>
      <td>${dateTimeLabel(r.created_at)}</td>
      <td>${r.user_email ?? "—"}</td>
      <td>${ACTION_LABELS[r.action] ?? r.action}</td>
      <td>${r.spare ?? "—"}</td>
      <td>${r.price_for_year ?? "—"}</td>
      <td>${r.detail ?? "—"}</td>
    </tr>`
        )
        .join("")
    : `<tr><td colspan="6">Записей пока нет</td></tr>`;
}

function closeAuditLogModal() {
  $("#auditLogModal").hidden = true;
}

function exportAuditLog() {
  const wsData = currentAuditRows.map((r) => ({
    "Дата/время": dateTimeLabel(r.created_at),
    "Пользователь": r.user_email,
    "Действие": ACTION_LABELS[r.action] ?? r.action,
    "Запчасть": r.spare,
    "Год": r.price_for_year,
    "Детали": r.detail,
  }));
  const ws = XLSX.utils.json_to_sheet(wsData);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Журнал");
  XLSX.writeFile(wb, `price_audit_log_${new Date().toISOString().slice(0, 10)}.xlsx`);
}

const TEMPLATE_HEADERS = ["Шахта", "Запасная часть", "Описание", "Цена", "Единица измерения", "Год"];

function downloadTemplate() {
  const exampleRow = {
    "Шахта": priceMines[0]?.mine ?? "Аралтобе",
    "Запасная часть": "0661102600",
    "Описание": "SEAL WASHER",
    "Цена": 0.73,
    "Единица измерения": "шт",
    "Год": new Date().getFullYear(),
  };
  const ws = XLSX.utils.json_to_sheet([exampleRow], { header: TEMPLATE_HEADERS });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Ценник");
  XLSX.writeFile(wb, "price_import_template.xlsx");
}

async function handleExcelFile(file) {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array" });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: "" });

  $("#importModal").hidden = false;
  $("#importSummary").innerHTML = `Импорт ${rows.length} строк…`;

  // Parse and validate every row first, then collapse rows that repeat the same
  // (Шахта, Запасная часть, Год) within THIS file — otherwise each repeat would call the
  // upsert RPC again and get counted as a separate "обновлено", even though only
  // one row in the DB is ever affected. The last occurrence in the file wins.
  const parsed = [];
  const errors = [];
  const knownMines = new Set(priceMines.map((m) => m.mine));
  for (const [i, row] of rows.entries()) {
    const mine = String(row["Шахта"] ?? row["mine"] ?? "").trim();
    const spare = String(row["Запасная часть"] ?? row["spare"] ?? "").trim();
    const description = String(row["Описание"] ?? row["description"] ?? "").trim();
    const priceRaw = row["Цена"] ?? row["price"] ?? "";
    const unit = String(row["Единица измерения"] ?? row["unit"] ?? "").trim();
    const yearRaw = row["Год"] ?? row["price_for_year"] ?? "";
    if (!mine || !spare || priceRaw === "" || yearRaw === "") {
      errors.push(`Строка ${i + 2}: не заполнены обязательные поля (Шахта/Запасная часть/Цена/Год)`);
      continue;
    }
    if (knownMines.size && !knownMines.has(mine)) {
      errors.push(`Строка ${i + 2}: шахта "${mine}" не найдена (есть: ${[...knownMines].sort().join(", ")})`);
      continue;
    }
    parsed.push({
      rowNum: i + 2,
      mine,
      spare,
      description,
      price: Number(priceRaw),
      unit,
      year: Number(yearRaw),
      key: `${mine}|${spare.toUpperCase()}|${yearRaw}`,
    });
  }

  const byKey = new Map();
  let duplicateRowsInFile = 0;
  for (const p of parsed) {
    if (byKey.has(p.key)) duplicateRowsInFile++;
    byKey.set(p.key, p); // last occurrence wins
  }

  let created = 0;
  let updated = 0;
  for (const p of byKey.values()) {
    const { data, error } = await supabase.rpc("upsert_price_entry", {
      p_spare: p.spare,
      p_description: p.description || null,
      p_price: p.price,
      p_unit: p.unit || null,
      p_price_for_year: p.year,
      p_mine: p.mine,
    });
    if (error) errors.push(`Строка ${p.rowNum} (${p.spare}): ${error.message}`);
    else if (data === "created") created++;
    else updated++;
  }

  $("#importSummary").innerHTML = `
    <p>Создано новых записей: <strong>${created}</strong>, обновлено существующих: <strong>${updated}</strong> (из ${rows.length} строк)</p>
    ${duplicateRowsInFile ? `<p>Повторяющихся строк в самом файле (та же шахта + запчасть + год): <strong>${duplicateRowsInFile}</strong> — учтена только последняя из них.</p>` : ""}
    ${errors.length ? `<p class="import-errors-title">Ошибки:</p><ul class="import-errors-list">${errors.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>` : ""}
  `;

  supabase.rpc("log_price_audit", {
    p_action: "import",
    p_spare: null,
    p_price_for_year: null,
    p_detail: `файл "${file.name}": создано ${created}, обновлено ${updated}, ошибок ${errors.length} (из ${rows.length} строк)`,
  }).then(() => {}, () => {});

  await loadData();
}

function initDashboard() {
  if (dashboardStarted) return;
  dashboardStarted = true;
  enableTapToExpandCells();
  enableScrollButtons();

  setupFilterToggle(() => {
    currentPage = 1;
    loadData();
  });
  $("#filterObject").addEventListener("change", () => {
    updateFilterMineOptions();
    currentPage = 1;
    onFilterChanged(loadData);
  });
  $("#filterMine").addEventListener("change", () => {
    currentPage = 1;
    onFilterChanged(loadData);
  });
  $("#filterYear").addEventListener("change", () => {
    currentPage = 1;
    onFilterChanged(loadData);
  });
  $("#filterSearch").addEventListener("input", () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      currentPage = 1;
      onFilterChanged(loadData);
    }, 400);
  });
  $("#resetFilters").addEventListener("click", () => {
    $("#filterObject").value = "";
    updateFilterMineOptions();
    $("#filterYear").value = "";
    $("#filterSearch").value = "";
    currentPage = 1;
    loadData();
    $("#filterPanel").classList.remove("open");
  });

  $("#addPriceBtn").addEventListener("click", () => openPriceModal(null));
  $("#priceModalClose").addEventListener("click", closePriceModal);
  $("#priceCancelBtn").addEventListener("click", closePriceModal);
  $("#priceModal").addEventListener("click", (e) => {
    if (e.target.id === "priceModal") closePriceModal();
  });
  $("#priceForm").addEventListener("submit", submitPriceForm);

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

  $("#exportPriceBtn").addEventListener("click", exportPriceList);

  $("#auditLogBtn").addEventListener("click", openAuditLogModal);
  $("#auditLogModalClose").addEventListener("click", closeAuditLogModal);
  $("#auditLogModal").addEventListener("click", (e) => {
    if (e.target.id === "auditLogModal") closeAuditLogModal();
  });
  $("#auditLogExportBtn").addEventListener("click", exportAuditLog);

  loadYearOptions();
  loadMines();
  loadData();
  supabase.rpc("log_price_audit", { p_action: "view", p_spare: null, p_price_for_year: null, p_detail: null }).then(() => {}, () => {});
}

setupAuth(supabase, "price-list.html", () => initDashboard());
