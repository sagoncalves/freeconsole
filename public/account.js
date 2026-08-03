/**
 * Fills the account slot in the server-rendered nav.
 *
 * This is all that remains of chrome.js' mountChrome(): the nav, footer and atmosphere are
 * now static markup in BaseLayout, because they never depended on anything but the current
 * path. Auth state is the one genuinely runtime-only bit, so it is the one thing still
 * written from JS.
 *
 * Anonymous sessions are how players join, so they are deliberately treated as "signed
 * out" - a player must never see their throwaway session presented as an account.
 */
import {
  getAuth,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/11.1.0/firebase-auth.js";

/**
 * @param {import('firebase/app').FirebaseApp} app Firebase app. Without one the nav still
 *   renders (server-side); the account slot just stays as its static "Sign in" fallback.
 */
export function mountAccount(app) {
  if (!app) return;
  const host = document.querySelector("[data-account]");
  if (!host) return;

  const auth = getAuth(app);

  onAuthStateChanged(auth, async (user) => {
    if (!user || user.isAnonymous) {
      render(host, null, false, auth);
      return;
    }
    const token = await user.getIdTokenResult().catch(() => null);
    render(host, user, token?.claims?.admin === true, auth);
  });
}

function render(host, user, isAdmin, auth) {
  host.textContent = "";

  if (!user) {
    const link = document.createElement("a");
    link.className = "nav-link";
    link.href = "/signup.html";
    link.textContent = "Sign in";
    host.appendChild(link);
    return;
  }

  if (isAdmin) {
    const adminLink = document.createElement("a");
    adminLink.className =
      "nav-link" + (location.pathname === "/signup.html" ? " active" : "");
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
}
