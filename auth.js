import { renderNavTabs, revealRoleItems } from "./nav.js?v=26";
import { resolveStartPage, SITE_INDEX, allowedPages, pageAllowed, startPageFor } from "./start-page.js?v=5";

// Shared passwordless (email OTP code) auth wiring, reused by every dashboard page.
// Expects the page's HTML to have: #loginScreen #loginForm #loginEmail #loginSubmit
// #codeForm #loginCode #codeSubmit #backToEmail #loginMessage #appContent #userEmail
// #logoutBtn #navTabs — same IDs/structure on every page.
export function setupAuth(supabase, activeHref, onLoggedIn) {
  const $ = (sel) => document.querySelector(sel);
  let pendingEmail = "";
  // Новый вход по коду: пока выясняем стартовую страницу, не запускаем текущую.
  let freshLogin = false;

  // Ссылка из письма-приглашения, если Supabase отправил её на Site URL (адрес accept.html
  // не в списке Redirect URLs), — передаём её странице принятия приглашения.
  const search = new URLSearchParams(window.location.search);
  if (search.get("token_hash") && search.get("type") === "invite") {
    window.location.replace("accept.html" + window.location.search);
    return;
  }

  // Вход с другого устройства по QR-коду — ссылка под формой входа. В шапке почта открывает
  // меню учётной записи: «Мои устройства» (подключение телефона по QR) и «Выйти».
  const loginCard = $("#loginScreen .login-card");
  if (loginCard && !loginCard.querySelector(".login-alt")) {
    loginCard.insertAdjacentHTML("beforeend", '<p class="login-alt"><a href="pair.html">Войти по QR-коду с другого устройства</a></p>');
  }
  const topRight = $(".topbar-right");
  if (topRight && !topRight.querySelector(".user-menu")) {
    const emailEl = $("#userEmail");
    const logoutBtn = $("#logoutBtn");
    const wrap = document.createElement("div");
    wrap.className = "user-menu";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "user-menu-btn";
    toggle.title = "Учётная запись";
    emailEl.replaceWith(wrap);
    toggle.append(emailEl, " ▾");
    const menu = document.createElement("div");
    menu.className = "nav-dropdown user-menu-dd";
    menu.hidden = true;
    menu.innerHTML = '<a class="nav-dropdown-item" href="devices.html">Мои устройства</a>';
    logoutBtn.className = "nav-dropdown-item user-menu-item";
    menu.append(logoutBtn);
    wrap.append(toggle, menu);
    toggle.addEventListener("click", (e) => {
      e.stopPropagation();
      menu.hidden = !menu.hidden;
    });
    document.addEventListener("click", (e) => {
      if (!wrap.contains(e.target)) menu.hidden = true;
    });
  }

  // Table headers use `position: sticky; top: var(--topbar-height)` so they stick right
  // below the sticky topbar instead of at top:0 (which would collide with it and hide
  // the header underneath). Topbar height varies (wraps onto 2 lines on narrow screens),
  // so it's measured live rather than hardcoded, and kept in sync on resize.
  function syncTopbarHeight() {
    const topbar = $(".topbar");
    if (!topbar) return;
    document.documentElement.style.setProperty("--topbar-height", topbar.getBoundingClientRect().height + "px");
  }
  window.addEventListener("resize", syncTopbarHeight);

  function loginMessage(text, kind) {
    const el = $("#loginMessage");
    el.textContent = text;
    el.className = "login-message " + kind;
    el.hidden = false;
  }

  function showLoggedIn(session) {
    $("#loginScreen").hidden = true;
    $("#appContent").hidden = false;
    $("#userEmail").textContent = session.user.email;
    renderNavTabs($("#navTabs"), activeHref);
    // Пункты меню по роли и списку «Доступ»; роль «Ввод ремонтов» видит только форму ремонтов.
    // Страница вне доступа (открыта по ссылке) — переход на стартовую.
    supabase.rpc("my_access").then(({ data }) => {
      if (!pageAllowed(data, activeHref)) {
        window.location.replace(startPageFor(data));
        return;
      }
      revealRoleItems($("#navTabs"), data?.role);
      hideClosedPages($("#navTabs"), data);
      renderScopePill(data);
    });
    syncTopbarHeight();
    onLoggedIn(session);
  }

  // Пункты, которых нет в «Доступ» пользователя, и опустевшие группы меню не показываем.
  function hideClosedPages(nav, access) {
    const allowed = new Set(allowedPages(access));
    nav.querySelectorAll(".nav-dropdown-item[href]").forEach((a) => {
      if (!allowed.has(a.getAttribute("href"))) a.style.display = "none";
    });
    nav.querySelectorAll(".nav-group").forEach((g) => {
      const items = [...g.querySelectorAll(".nav-dropdown-item")];
      if (items.length && items.every((a) => a.style.display === "none")) g.style.display = "none";
    });
  }

  // Локация в шапке — как в форме «Ввод ремонтов»: объект · шахта из прав пользователя.
  // На странице ввода ремонтов своя метка (#reScope) — там не добавляем.
  function renderScopePill(access) {
    const topbar = $(".topbar");
    if (!topbar || $("#reScope") || !access) return;
    const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
    let text;
    if (access.all_equipment) text = "Все объекты · все шахты";
    else {
      const obj = (access.objects || []).join(", "), mine = (access.mines || []).join(", ");
      text = obj && mine ? `${obj} · ${mine}` : obj ? `${obj} · все шахты` : mine || "Область не задана";
    }
    let box = $(".app-scope");
    if (!box) {
      box = document.createElement("div");
      box.className = "app-scope";
      topbar.insertBefore(box, $(".topbar-right"));
    }
    box.innerHTML = `<span class="app-scope-pill" title="Объект · шахта из прав пользователя">${esc(text)}</span>`;
    syncTopbarHeight();
  }

  function showLoggedOut() {
    $("#loginScreen").hidden = false;
    $("#appContent").hidden = true;
  }

  $("#loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const email = $("#loginEmail").value.trim();
    const btn = $("#loginSubmit");
    btn.disabled = true;
    btn.textContent = "Отправка…";
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { shouldCreateUser: false },
    });
    btn.disabled = false;
    btn.textContent = "Отправить код";
    if (error) {
      loginMessage("Не удалось отправить код: " + error.message, "error");
    } else {
      pendingEmail = email;
      loginMessage("Код отправлен на " + email + ". Введите его ниже.", "success");
      $("#loginForm").hidden = true;
      $("#codeForm").hidden = false;
      $("#loginCode").focus();
    }
  });

  $("#codeForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = $("#loginCode").value.trim();
    const btn = $("#codeSubmit");
    btn.disabled = true;
    btn.textContent = "Проверка…";
    freshLogin = true;
    const { data, error } = await supabase.auth.verifyOtp({
      email: pendingEmail,
      token: code,
      type: "email",
    });
    btn.disabled = false;
    btn.textContent = "Подтвердить";
    if (error) {
      freshLogin = false;
      loginMessage("Неверный или истекший код: " + error.message, "error");
    } else if (data && data.session) {
      // После нового входа открываем стартовую страницу пользователя (её задаёт администратор).
      const start = await resolveStartPage(supabase);
      if (start !== activeHref) {
        window.location.replace(start);
        return;
      }
      freshLogin = false;
      showLoggedIn(data.session);
    } else {
      freshLogin = false;
      loginMessage("Не удалось войти. Попробуйте запросить код ещё раз.", "error");
    }
  });

  $("#backToEmail").addEventListener("click", () => {
    $("#codeForm").hidden = true;
    $("#loginForm").hidden = false;
    $("#loginMessage").hidden = true;
  });

  $("#logoutBtn").addEventListener("click", async () => {
    await supabase.auth.signOut();
    $("#codeForm").hidden = true;
    $("#loginForm").hidden = false;
  });

  // Default to logged-out until a session is positively confirmed — never let the
  // dashboard shell show while auth state is unknown or broken.
  showLoggedOut();

  // Stale/used magic-link redirects land here as a URL hash with an error —
  // surface it on the login screen instead of leaving the UI in limbo.
  const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  if (hashParams.get("error")) {
    const desc = hashParams.get("error_description") || hashParams.get("error");
    loginMessage(
      "Ссылка недействительна или истекла (" + decodeURIComponent(desc).replace(/\+/g, " ") + "). Запросите новую.",
      "error"
    );
    history.replaceState(null, "", window.location.pathname + window.location.search);
  }

  // onAuthStateChange fires once immediately with the current session (INITIAL_SESSION)
  // and again on every future change — this alone is the recommended pattern.
  // A separate getSession() call here would race it: if getSession() resolves after
  // a fresh login, its stale result can revert the screen back to logged-out.
  supabase.auth.onAuthStateChange((event, session) => {
    if (session && freshLogin) return; // решит обработчик формы кода (стартовая страница)
    if (session && event === "INITIAL_SESSION" && isSiteEntry()) {
      // Вход на сайт с сохранённой сессией: сначала стартовая страница пользователя.
      freshLogin = true;
      $("#loginScreen").hidden = true;
      setTimeout(async () => {
        const start = await resolveStartPage(supabase);
        if (start !== activeHref) {
          window.location.replace(start);
          return;
        }
        freshLogin = false;
        showLoggedIn(session);
      });
      return;
    }
    if (session) showLoggedIn(session);
    else showLoggedOut();
  });

  // Открыт адрес сайта (index.html без параметров) извне: закладка, адресная строка, новая вкладка.
  // Переходы внутри сайта (меню, ссылки), ссылки с параметрами, перезагрузка и «Назад» не трогаем.
  function isSiteEntry() {
    if (activeHref !== SITE_INDEX || window.location.search) return false;
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav && nav.type !== "navigate") return false;
    try {
      if (document.referrer && new URL(document.referrer).origin === window.location.origin) return false;
    } catch {}
    return true;
  }
}
