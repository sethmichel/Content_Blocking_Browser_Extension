/*
 * Focus Blocker - content script. Runs at document_start on YouTube and Amazon.
 *
 * The blocking itself lives in youtube.css / amazon.css, which the browser injects
 * before the page paints. Every rule in those files is gated behind a flag attribute
 * on <html>, so this script only has four jobs:
 *
 *   1. Set the flag immediately, so blocked content never flashes on screen.
 *   2. Clear it if the site has been switched off in the popup (and re-set it live
 *      when the popup is toggled back on).
 *   3. Keep a data-cb-path / data-cb-home marker on <html> in sync with the URL, so
 *      the CSS can tell the home page apart from a watch page even though YouTube
 *      never reloads the document.
 *   4. On the Amazon home page, mark every DOM branch that isn't the top nav, which
 *      backs up the static CSS in case Amazon reshuffles its layout.
 */

(() => {
  "use strict";

  /* Every module-level constant has to be declared before the setup call below
     reaches it - `const` is not hoisted the way a function declaration is. */

  const DEFAULTS = { youtube: true, amazon: true };

  // Amazon's home is "/" when you land on it, "/ref=nav_logo" when you click the logo.
  const AMAZON_HOME = /^\/(ref=[^/]*)?$|^\/gp\/(css\/)?homepage\.html$/;

  // Nav flyouts, popovers and modals get rendered as their own top-level branches.
  // Hiding those would break the hamburger menu and the delivery-address dialog.
  const KEEP_ID = /^(a-popover|a-modal|nav-flyout|nav-cart-flyout|hmenu|skiplink)/;
  const KEEP_TAG = /^(SCRIPT|STYLE|NOSCRIPT|LINK|META|HEAD|TEMPLATE)$/;

  // Run whenever the URL changes, after the <html> markers have been updated.
  const NAV_HOOKS = [];

  const SITE = detectSite(location.hostname);
  if (!SITE) return;

  const FLAG_ATTR = SITE === "youtube" ? "data-cb-yt" : "data-cb-amz";

  withRoot((root) => {
    // Optimistic: assume blocking is on. Reading storage is async, and waiting for it
    // would let a frame of recommendations through. Storage corrects us a tick later
    // in the rare case the site is switched off.
    root.setAttribute(FLAG_ATTR, "on");

    markLocation(root);
    if (SITE === "youtube") silenceShorts();
    watchLocation(root);
    if (SITE === "amazon") hideBranchesOutsideNavbar(root);
    followSettings(root);
  });

  function detectSite(host) {
    if (/(^|\.)youtube\.com$/.test(host)) return "youtube";
    if (/(^|\.)amazon\.(com|ca)$/.test(host)) return "amazon";
    return null;
  }

  /* <html> normally exists by document_start, but don't assume it. */
  function withRoot(fn) {
    if (document.documentElement) {
      fn(document.documentElement);
      return;
    }
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return;
      observer.disconnect();
      fn(document.documentElement);
    });
    observer.observe(document, { childList: true });
  }

  /* ---------------------------------------------------------------- location */

  function isHome(path) {
    return SITE === "youtube" ? path === "/" : AMAZON_HOME.test(path);
  }

  function isShorts(path) {
    return path.startsWith("/shorts");
  }

  function markLocation(root) {
    root.setAttribute("data-cb-path", location.pathname);
    root.setAttribute("data-cb-home", isHome(location.pathname) ? "1" : "0");
    for (const hook of NAV_HOOKS) hook();
  }

  function watchLocation(root) {
    if (SITE !== "youtube") return; // Amazon does real page loads

    let last = location.href;
    const check = () => {
      if (location.href === last) return;
      last = location.href;
      markLocation(root);
    };

    // YouTube fires these itself on every client-side navigation.
    document.addEventListener("yt-navigate-start", check, true);
    document.addEventListener("yt-navigate-finish", check, true);
    window.addEventListener("popstate", check);

    // Backstop, in case those event names ever change. The primary CSS selectors key
    // off YouTube's own ytd-browse[page-subtype] / ytd-watch-flexy elements, so this
    // marker is a second line of defence and a slow poll is plenty.
    setInterval(check, 400);
  }

  /* ------------------------------------------------------------------ shorts */

  /*
   * youtube.css blanks the Shorts page, but a display:none <video> keeps playing
   * its audio, so playback has to be stopped here as well.
   *
   * Media events don't bubble, which is why this listens in the capture phase -
   * capture still reaches document on the way down to the target. Catching
   * loadeddata/canplay as well as play means the element is paused before it ever
   * gets as far as making a sound.
   */
  function silenceShorts() {
    const muted = new Set();

    const handler = (event) => {
      const el = event.target;
      if (!isShorts(location.pathname) || !el || typeof el.pause !== "function") return;
      muted.add(el);
      el.muted = true;
      el.pause();
    };

    for (const type of ["loadeddata", "canplay", "play", "playing"]) {
      document.addEventListener(type, handler, true);
    }

    // Un-mute on the way out, so a normal video never inherits a muted element.
    NAV_HOOKS.push(() => {
      if (isShorts(location.pathname)) return;
      for (const el of muted) el.muted = false;
      muted.clear();
    });
  }

  /* ------------------------------------------------------------------ amazon */

  /*
   * Walk from the navbar up to <body>, marking every sibling along the way. That
   * leaves exactly the nav's ancestor chain plus the nav itself visible and hides
   * every other branch of the page, without depending on Amazon's container ids.
   */
  function hideBranchesOutsideNavbar(root) {
    if (root.getAttribute("data-cb-home") !== "1") return;

    const run = () => {
      const nav = document.getElementById("navbar") || document.getElementById("nav-belt");
      if (!nav) return;
      for (let node = nav; node && node !== document.body; node = node.parentElement) {
        const parent = node.parentElement;
        if (!parent) break;
        for (const sibling of parent.children) {
          if (sibling === node || shouldKeep(sibling)) continue;
          sibling.classList.add("cb-blocked");
        }
      }
    };

    let scheduled = false;
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        run();
      });
    };

    run();
    const observer = new MutationObserver(schedule);
    observer.observe(root, { childList: true, subtree: true });

    // The homepage is fully built well before this; stop watching so carousels
    // mutating inside already-hidden branches don't keep waking us up.
    const stop = () => setTimeout(() => observer.disconnect(), 5000);
    if (document.readyState === "complete") stop();
    else window.addEventListener("load", stop, { once: true });
  }

  function shouldKeep(el) {
    if (KEEP_TAG.test(el.tagName)) return true;
    if (KEEP_ID.test(el.id || "")) return true;
    return el.classList.contains("a-popover");
  }

  /* ---------------------------------------------------------------- settings */

  function followSettings(root) {
    const apply = (enabled) => {
      if (enabled === false) root.removeAttribute(FLAG_ATTR);
      else root.setAttribute(FLAG_ATTR, "on");
    };

    chrome.storage.local.get(DEFAULTS, (settings) => apply(settings[SITE]));

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && SITE in changes) apply(changes[SITE].newValue);
    });
  }
})();
