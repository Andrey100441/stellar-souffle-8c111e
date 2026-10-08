// Shared navigation config — dashboards grouped by category so the topbar
// stays compact no matter how many pages get added later.
// To add a new dashboard later: create its HTML/JS pair, then add one entry
// to the matching group's `items` array below.
export const NAV_GROUPS = [
  {
    key: "analytics",
    label: "Аналитика",
    items: [
      { href: "fleet-status.html", label: "Состояние парка оборудования" },
      { href: "index.html", label: "Доступность и надёжность" },
      { href: "repair-details.html", label: "Журнал ремонтов и запчастей" },
      { href: "staff-details.html", label: "Персонал" },
      { href: "staff-objects.html", label: "Персонал по объектам" },
      { href: "pm-history.html", label: "История ТО" },
      { href: "smh-history.html", label: "Наработка техники (SMH)" },
    ],
  },
  {
    key: "planning",
    label: "Планирование",
    items: [
      { href: "equipment.html", label: "Оборудование" },
      { href: "plan-indicators.html", label: "Плановые показатели оборудования" },
      { href: "autostock-plan.html", label: "Плановые наработки запасных частей" },
      { href: "to-forecast.html", label: "Прогноз ТО" },
    ],
  },
  {
    key: "settings",
    label: "Настройки",
    items: [
      { href: "staff-roster.html", label: "Персонал" },
      { href: "price-list.html", label: "Ценовой справочник" },
      // Показывается только администратору (см. revealAdminItems / auth.js).
      { href: "users.html", label: "Пользователи", adminOnly: true },
      { href: "parse-rules.html", label: "Словарь разбора ремонтов", adminOnly: true },
    ],
  },
  {
    key: "data-entry",
    label: "Ввод данных",
    items: [
      // Показывается редактору, администратору и роли «Ввод ремонтов» (см. revealRoleItems / auth.js).
      { href: "repair-entry.html", label: "Ввод ремонтов", entryOnly: true },
    ],
  },
];

let docCloseListenerAttached = false;

// Пункты только для администратора скрыты по умолчанию; показываются, когда база
// подтвердила роль (auth.js -> my_access). Доступ к данным всё равно проверяет база.
export function revealAdminItems(container) {
  container.querySelectorAll("[data-admin-only]").forEach((el) => (el.style.display = ""));
}

// Пункты по роли: ввод ремонтов — editor/admin/repair_entry; у роли «Ввод ремонтов»
// остаётся только группа «Ввод данных». Доступ к данным всё равно проверяет база.
export function revealRoleItems(container, role) {
  if (role === "admin") revealAdminItems(container);
  if (["editor", "admin", "repair_entry"].includes(role)) {
    container.querySelectorAll("[data-entry-only]").forEach((el) => (el.style.display = ""));
  }
  if (role === "repair_entry") {
    container.querySelectorAll(".nav-group").forEach((g) => {
      if (!g.querySelector('[data-group="data-entry"]')) g.style.display = "none";
    });
  }
}

export function renderNavTabs(container, activeHref) {
  container.innerHTML = NAV_GROUPS.map((g) => {
    const isActiveGroup = g.items.some((i) => i.href === activeHref);
    const disabled = g.items.length === 0;
    return `
      <div class="nav-group">
        <button type="button" class="nav-group-btn${isActiveGroup ? " active" : ""}" data-group="${g.key}"${disabled ? " disabled" : ""}>
          ${g.label}${disabled ? "" : " ▾"}
        </button>
        <div class="nav-dropdown" data-dropdown="${g.key}" hidden>
          ${g.items
            .map(
              (i) =>
                `<a class="nav-dropdown-item${i.href === activeHref ? " active" : ""}" href="${i.href}"${i.adminOnly ? ' data-admin-only style="display:none"' : ""}${i.entryOnly ? ' data-entry-only style="display:none"' : ""}>${i.label}</a>`
            )
            .join("")}
        </div>
      </div>`;
  }).join("");

  const closeAllDropdowns = () => {
    container.querySelectorAll(".nav-dropdown").forEach((d) => (d.hidden = true));
  };

  for (const btn of container.querySelectorAll(".nav-group-btn:not([disabled])")) {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const dropdown = container.querySelector(`[data-dropdown="${btn.dataset.group}"]`);
      const wasHidden = dropdown.hidden;
      closeAllDropdowns();
      dropdown.hidden = !wasHidden;
    });
  }

  if (!docCloseListenerAttached) {
    document.addEventListener("click", () => {
      document.querySelectorAll(".nav-dropdown").forEach((d) => (d.hidden = true));
    });
    docCloseListenerAttached = true;
  }
}
