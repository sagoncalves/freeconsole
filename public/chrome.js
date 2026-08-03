/**
 * Shared page chrome: the nav bar, footer, and atmosphere layers.
 *
 * Every page calls mountChrome() rather than hand-copying markup, so a nav change lands
 * everywhere at once. The nav reflects auth state - an admin sees the Admin link and their
 * email; everyone else sees a Sign in link. Players never need an account, so nothing here
 * pushes them toward one.
 */
import {
  getAuth,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";

const LINKS = [
  { href: "/", label: "Games", match: (p) => p === "/" || p === "/index.html" },
  { href: "/play.html", label: "Join a game", match: (p) => p === "/play.html" },
  { href: "/docs.html", label: "Build a game", match: (p) => p === "/docs.html" },
];

/* ------------------------------------------------------------------ toasts */

let toastHost = null;

/**
 * Transient confirmation that an action happened.
 *
 * Use for outcomes ("Saved", "Deleted"); keep inline .msg for validation detail that needs
 * to sit next to the field it's about.
 *
 * @param {string} title
 * @param {object} [opts]
 * @param {'ok'|'error'|'info'} [opts.kind='ok']
 * @param {string} [opts.note] second line with detail
 * @param {number} [opts.duration] ms before auto-dismiss; errors default to longer
 */
export function toast(title, opts = {}) {
  const { kind = "ok", note = null } = opts;
  const duration = opts.duration ?? (kind === "error" ? 6500 : 3600);

  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toasts";
    toastHost.setAttribute("role", "status");
    toastHost.setAttribute("aria-live", "polite");
    document.body.appendChild(toastHost);
  }

  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.textContent = kind === "ok" ? "✓" : kind === "error" ? "!" : "i";

  const body = document.createElement("div");
  body.className = "toast-body";
  const titleEl = document.createElement("div");
  titleEl.className = "toast-title";
  titleEl.textContent = title;
  body.appendChild(titleEl);
  if (note) {
    const noteEl = document.createElement("div");
    noteEl.className = "toast-note";
    noteEl.textContent = note;
    body.appendChild(noteEl);
  }

  const close = document.createElement("button");
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";

  el.append(icon, body, close);
  toastHost.appendChild(el);

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };
  close.addEventListener("click", dismiss);
  timer = setTimeout(dismiss, duration);

  return dismiss;
}

/**
 * @param {object} opts
 * @param {import('firebase/app').FirebaseApp} [opts.app] Firebase app, if the page has one.
 *   Without it the nav still renders, just without account state.
 * @param {boolean} [opts.footer=true]
 */
export function mountChrome(opts = {}) {
  const { app, footer = true } = opts;
  const path = location.pathname;

  if (!document.querySelector(".atmosphere")) {
    const atmosphere = document.createElement("div");
    atmosphere.className = "atmosphere";
    atmosphere.setAttribute("aria-hidden", "true");
    document.body.prepend(atmosphere);
  }

  const skip = document.createElement("a");
  skip.className = "skip-link";
  skip.href = "#main";
  skip.textContent = "Skip to content";

  const nav = document.createElement("nav");
  nav.className = "nav";
  nav.innerHTML = `
    <a class="brand" href="/">
      <span class="brand-mark" aria-hidden="true">FC</span>
      <span class="brand-name">FreeConsole</span>
    </a>
    <div class="nav-links">
      ${LINKS.map(
        (l) => `<a class="nav-link${l.match(path) ? " active" : ""}" href="${l.href}">${l.label}</a>`
      ).join("")}
      <span class="nav-account"></span>
    </div>`;

  document.body.prepend(nav);
  document.body.prepend(skip);

  if (footer && !document.querySelector(".footer")) {
    const el = document.createElement("footer");
    el.className = "footer";
    el.innerHTML = `
      <span>FreeConsole — the browser is the screen, phones are the controllers.</span>
      <span class="push faint">No installs. No accounts to play.</span>`;
    document.body.appendChild(el);
  }

  if (app) wireAccount(app, nav.querySelector(".nav-account"));
}

/**
 * Renders account state into the nav.
 *
 * Anonymous sessions are how players join, so they are deliberately treated as "signed
 * out" here - a player must never see their throwaway session presented as an account.
 */
function wireAccount(app, host) {
  const auth = getAuth(app);

  onAuthStateChanged(auth, async (user) => {
    host.innerHTML = "";

    if (!user || user.isAnonymous) {
      const link = document.createElement("a");
      link.className = "nav-link";
      link.href = "/signup.html";
      link.textContent = "Sign in";
      host.appendChild(link);
      return;
    }

    const token = await user.getIdTokenResult().catch(() => null);
    const isAdmin = token?.claims?.admin === true;

    if (isAdmin) {
      const adminLink = document.createElement("a");
      adminLink.className = "nav-link" + (location.pathname === "/signup.html" ? " active" : "");
      adminLink.href = "/signup.html";
      adminLink.textContent = "Admin";
      host.appendChild(adminLink);
    }

    const menu = document.createElement("span");
    menu.className = "nav-link";
    menu.style.color = "var(--text-faint)";
    menu.textContent = user.email || "account";
    host.appendChild(menu);

    const out = document.createElement("button");
    out.className = "nav-link";
    out.style.cssText = "background:none;border:0;cursor:pointer;font:inherit";
    out.textContent = "Sign out";
    out.addEventListener("click", () => signOut(auth));
    host.appendChild(out);
  });
}
