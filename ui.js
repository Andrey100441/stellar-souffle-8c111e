// Truncated table cells (max-width + ellipsis) rely on the `title` attribute
// for the full text via hover — but touch devices have no hover, so on
// mobile a tap on a truncated cell never reveals anything. Toggle the text
// in place instead: tap expands to full wrapped text, tap again collapses.
let enabled = false;

export function enableTapToExpandCells() {
  if (enabled) return;
  enabled = true;
  document.addEventListener("click", (e) => {
    const td = e.target.closest("td[title]");
    if (!td || !td.title) return;
    td.classList.toggle("cell-expanded");
  });
}

// Matches the breakpoint in style.css where #filterPanel becomes a
// toggleable mobile overlay instead of always being visible inline.
const MOBILE_BREAKPOINT = 860;
function isMobileFilterPanel() {
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
}

// Wires up "#filterToggle" (the "☰ Фильтры" button). On desktop the panel
// is always visible, so this just shows/hides it. On mobile, picking one
// filter used to immediately apply it and close the panel — annoying when
// you want to set several filters in a row. Now on mobile the panel stays
// open while you pick values, and filters are applied only when you close
// the panel (tapping the button again).
export function setupFilterToggle(onApply) {
  const toggleBtn = document.querySelector("#filterToggle");
  const panel = document.querySelector("#filterPanel");
  if (!toggleBtn || !panel) return;
  toggleBtn.addEventListener("click", () => {
    const wasOpen = panel.classList.contains("open");
    panel.classList.toggle("open");
    if (wasOpen && isMobileFilterPanel()) onApply();
  });
}

// Call this from each filter's "change" handler (after updating any
// dependent dropdowns). On desktop applies immediately, as before. On
// mobile, defers — the actual apply happens when the filter panel closes
// (see setupFilterToggle above).
export function onFilterChanged(onApply) {
  if (isMobileFilterPanel()) return;
  onApply();
  const panel = document.querySelector("#filterPanel");
  if (panel) panel.classList.remove("open");
}

// Floating "jump to top/bottom of the table" buttons — long tables mean a lot of manual
// scrolling to get back to the header or check the last row, so this shortcuts it.
// `target` is the element to jump around (default #dataTable), or a function returning it
// for pages that switch between several tables (tabs). If the target sits inside its own
// scrolling box (see enableStickyTableWrap), that box is scrolled to its top/bottom too.
let scrollButtonsEnabled = false;

export function enableScrollButtons(target = "#dataTable") {
  if (scrollButtonsEnabled) return;
  const resolve = () => (typeof target === "function" ? target() : document.querySelector(target));
  if (!resolve()) return;
  scrollButtonsEnabled = true;

  const wrap = document.createElement("div");
  wrap.className = "scroll-nav-buttons";
  wrap.innerHTML = `
    <button type="button" class="scroll-nav-btn" aria-label="Наверх таблицы" title="Наверх таблицы">▲</button>
    <button type="button" class="scroll-nav-btn" aria-label="Вниз таблицы" title="Вниз таблицы">▼</button>
  `;
  document.body.appendChild(wrap);
  const [upBtn, downBtn] = wrap.querySelectorAll(".scroll-nav-btn");

  const topbarHeight = () =>
    parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--topbar-height")) || 60;
  const innerScroller = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const oy = getComputedStyle(n).overflowY;
      if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight) return n;
    }
    return null;
  };

  upBtn.addEventListener("click", () => {
    const table = resolve();
    if (!table) return;
    const box = innerScroller(table);
    if (box) box.scrollTo({ top: 0, behavior: "smooth" });
    const top = (box || table).getBoundingClientRect().top + window.scrollY - topbarHeight() - 12;
    window.scrollTo({ top, behavior: "smooth" });
  });
  downBtn.addEventListener("click", () => {
    const table = resolve();
    if (!table) return;
    const box = innerScroller(table);
    if (box) box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
    const bottom = (box || table).getBoundingClientRect().bottom + window.scrollY - window.innerHeight + 12;
    window.scrollTo({ top: bottom, behavior: "smooth" });
  });
}

// Sticky table header for a wide table inside an overflow-x wrapper. A wrapper with
// overflow becomes the sticky containing block, so the header can only stick to the page
// when the table fits and the wrapper drops its overflow (class "tbl-fit"). When the table
// is wider than the wrapper, the wrapper instead becomes a height-limited scroll box and the
// header sticks to its top (CSS: .tbl / .tbl.tbl-fit). Re-checked whenever sizes change.
export function enableStickyTableWrap(wrapEl) {
  if (!wrapEl) return;
  const check = () => {
    const table = wrapEl.querySelector("table");
    if (!table) return;
    wrapEl.classList.toggle("tbl-fit", table.offsetWidth <= wrapEl.clientWidth + 1);
  };
  const ro = new ResizeObserver(check);
  ro.observe(wrapEl);
  const table = wrapEl.querySelector("table");
  if (table) ro.observe(table);
  check();
}
