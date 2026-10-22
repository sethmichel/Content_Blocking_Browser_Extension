/*
 * Focus Blocker - content script. Runs at document_start on YouTube, Amazon,
 * LinkedIn, Instagram and Facebook.
 *
 * The blocking itself lives in the per-site CSS files, which the browser injects
 * before the page paints. Every rule in those files is gated behind a flag
 * attribute on <html>, so this script only has seven jobs:
 *
 *   1. Set the flag immediately, so blocked content never flashes on screen.
 *   2. Clear it if the site has been switched off in the popup (and re-set it live
 *      when the popup is toggled back on).
 *   3. Keep a data-cb-path / data-cb-home marker on <html> in sync with the URL, so
 *      the CSS can tell the home page apart from a watch page even though YouTube
 *      and LinkedIn never reload the document.
 *   4. On the Amazon home page, mark every DOM branch that isn't the top nav, which
 *      backs up the static CSS in case Amazon reshuffles its layout.
 *   5. On the LinkedIn feed, mark the right-hand rail cards, found by the links
 *      inside them rather than by class name.
 *   6. On the Instagram and Facebook home feeds, let the first few posts through
 *      and end the feed after them.
 *   7. In Instagram's Reels tab, count the reels watched and block the tab once
 *      the count is used up, until there has been a long enough break.
 */

(() => {
  "use strict";

  /* Every module-level constant has to be declared before the setup call below
     reaches it - `const` is not hoisted the way a function declaration is. */

  const DEFAULTS = { youtube: true, amazon: true, linkedin: true, instagram: true, facebook: true };

  const FLAG_ATTRS = {
    youtube: "data-cb-yt",
    amazon: "data-cb-amz",
    linkedin: "data-cb-li",
    instagram: "data-cb-ig",
    facebook: "data-cb-fb",
  };

  // Amazon's home is "/" when you land on it, "/ref=nav_logo" when you click the logo.
  const AMAZON_HOME = /^\/(ref=[^/]*)?$|^\/gp\/(css\/)?homepage\.html$/;

  // LinkedIn's home is "/feed/"; "/" bounces there when you are signed in.
  const LINKEDIN_HOME = /^\/(feed\/?)?$/;

  // The right-hand rail. LinkedIn's messaging overlay is an <aside> as well, and a
  // message can quote a news link, so it is excluded rather than searched.
  const RAIL = 'aside:not([id*="msg"]):not([class*="msg-"]), .scaffold-layout__aside';

  // The two rail modules, identified by where their contents link to: news stories
  // to /news/..., each of the day's puzzles to /games/....
  const RAIL_LINK = 'a[href*="/news/"], a[href*="/games/"]';

  const INSTAGRAM_HOME = /^\/$/;
  const FACEBOOK_HOME = /^\/(home\.php)?$/;

  // How many posts each home feed shows before it ends. Counted afresh on every
  // page load.
  const FEED_CAP = { instagram: 10, facebook: 10 };

  // Instagram's own end of the posts from accounts you follow, and the heading of
  // the suggested posts it shows after that. Each must be a whole text node outside
  // any post, so a caption that happens to say the same thing can't trip it.
  const IG_CAUGHT_UP = /^\s*you['’]re all caught up\s*$/i;
  const IG_SUGGESTED = /^\s*suggested posts\s*$/i;

  // Instagram's infinite-scroll spinner, which sits just outside the feed's list.
  const IG_SPINNER = '[data-visualcompletion="loading-state"]';

  // The Reels tab: "/reels/" itself, and "/reels/CODE/" for each reel as you scroll.
  // A reel sent in a message opens as "/p/CODE/" on its own and is never counted.
  const IG_REELS = /^\/reels(?:\/([^/?#]+))?\/?$/;

  // How many reels the Reels tab plays before it is blocked, and how long it has to
  // go without counting a new one before the count starts over. Kept in storage,
  // so reloading the page or opening another tab doesn't reset it.
  const REELS_CAP = 10;
  const REELS_BREAK = 10 * 60 * 1000;
  const REELS_KEY = "instagramReels"; // { seen: [shortcode, ...], last: ms }

  // "ok" or "over" on <html> while on the Reels tab; unset while the count is still
  // being read from storage. instagram.css hides the tab unless it says "ok".
  const REELS_ATTR = "data-cb-reels";
  const NOTE_ATTR = "data-cb-note";

  // Markers content.js puts on feed elements for instagram.css / facebook.css.
  // Attributes rather than classes, because React rewrites className on re-render.
  const OK = "data-cb-ok"; //     a post that is let through
  const HIDE = "data-cb-hide"; // a post past the end of the feed
  const END = "data-cb-end"; //   the end of the feed and its ancestors; the CSS
  //                              hides every sibling that comes after one
  const LAST = "data-cb-last"; // the post the end-of-feed note hangs off
  const MARKERS = [OK, HIDE, END, LAST];

  // What capFeed needs to know about each feed. See the instagram / facebook
  // section for what each of these finds.
  const FEEDS = {
    instagram: {
      posts: instagramPosts,
      key: instagramKey,
      end: instagramEnd,
      stop: instagramStop,
    },
    facebook: {
      posts: facebookPosts,
      key: (post) => "pos" + post.getAttribute("aria-posinset"),
      end: () => null,
      stop: (posts, anchor) => anchor.closest('[role="main"]'),
    },
  };

  // Nav flyouts, popovers and modals get rendered as their own top-level branches.
  // Hiding those would break the hamburger menu and the delivery-address dialog.
  const KEEP_ID = /^(a-popover|a-modal|nav-flyout|nav-cart-flyout|hmenu|skiplink)/;
  const KEEP_TAG = /^(SCRIPT|STYLE|NOSCRIPT|LINK|META|HEAD|TEMPLATE)$/;

  // Run whenever the URL changes, after the <html> markers have been updated.
  const NAV_HOOKS = [];

  const SITE = detectSite(location.hostname);
  if (!SITE) return;

  const FLAG_ATTR = FLAG_ATTRS[SITE];

  withRoot((root) => {
    // Optimistic: assume blocking is on. Reading storage is async, and waiting for it
    // would let a frame of recommendations through. Storage corrects us a tick later
    // in the rare case the site is switched off.
    root.setAttribute(FLAG_ATTR, "on");

    markLocation(root);
    if (SITE === "youtube") silence(() => isShorts(location.pathname));
    watchLocation(root);
    if (SITE === "amazon") hideBranchesOutsideNavbar(root);
    if (SITE === "linkedin") hideRailModules(root);
    if (SITE in FEEDS) capFeed(root, FEEDS[SITE]);
    if (SITE === "instagram") capReels(root);
    followSettings(root);
  });

  function detectSite(host) {
    if (/(^|\.)youtube\.com$/.test(host)) return "youtube";
    if (/(^|\.)amazon\.(com|ca)$/.test(host)) return "amazon";
    if (/(^|\.)linkedin\.com$/.test(host)) return "linkedin";
    if (/(^|\.)instagram\.com$/.test(host)) return "instagram";
    if (/(^|\.)facebook\.com$/.test(host)) return "facebook";
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
    if (SITE === "youtube") return path === "/";
    if (SITE === "amazon") return AMAZON_HOME.test(path);
    if (SITE === "linkedin") return LINKEDIN_HOME.test(path);
    if (SITE === "instagram") return INSTAGRAM_HOME.test(path);
    return FACEBOOK_HOME.test(path);
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
    if (SITE === "amazon") return; // Amazon does real page loads

    let last = location.href;
    const check = () => {
      if (location.href === last) return;
      last = location.href;
      markLocation(root);
    };

    // YouTube fires these itself on every client-side navigation.
    if (SITE === "youtube") {
      document.addEventListener("yt-navigate-start", check, true);
      document.addEventListener("yt-navigate-finish", check, true);
    }
    window.addEventListener("popstate", check);

    // Backstop, in case those event names ever change, and the only signal there is
    // for LinkedIn's, Instagram's and Facebook's own client-side routing. Either site's primary CSS selectors key
    // off elements the site renders itself (ytd-browse[page-subtype], the LinkedIn
    // share box), so this marker is a second line of defence and a poll is plenty.
    setInterval(check, 400);
  }

  /* ------------------------------------------------------- shorts and reels */

  /*
   * youtube.css blanks the Shorts page and instagram.css the Reels tab, but a
   * display:none <video> keeps playing its audio, so playback has to be stopped
   * here as well, for as long as `blocked()` says so.
   *
   * Media events don't bubble, which is why this listens in the capture phase -
   * capture still reaches document on the way down to the target. Catching
   * loadeddata/canplay as well as play means the element is paused before it ever
   * gets as far as making a sound.
   *
   * Returns hush(), which stops whatever is already playing, and release(), which
   * un-mutes everything this muted.
   */
  function silence(blocked) {
    const muted = new Set();

    const hushOne = (el) => {
      muted.add(el);
      el.muted = true;
      el.pause();
    };

    const handler = (event) => {
      const el = event.target;
      if (!blocked() || !el || typeof el.pause !== "function") return;
      hushOne(el);
    };

    for (const type of ["loadeddata", "canplay", "play", "playing"]) {
      document.addEventListener(type, handler, true);
    }

    const release = () => {
      for (const el of muted) el.muted = false;
      muted.clear();
    };

    // Un-mute on the way out, so a normal video never inherits a muted element.
    NAV_HOOKS.push(() => {
      if (!blocked()) release();
    });

    return {
      hush: () => document.querySelectorAll("video").forEach(hushOne),
      release,
    };
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

  /* ---------------------------------------------------------------- linkedin */

  /*
   * The right-hand rail: LinkedIn News and Today's puzzles. Each is found from a
   * link inside it, then hidden at whichever ancestor sits directly in the <aside>,
   * so the whole card goes rather than one row of it. linkedin.css does the same in
   * pure CSS; this covers the case where a module ends up nested deeper in the rail
   * than a direct child.
   *
   * The rail arrives after first paint and is rebuilt when LinkedIn routes
   * client-side, so the search repeats for a while after every URL change.
   */
  function hideRailModules(root) {
    let observer = null;
    let stop = null;
    let scheduled = false;

    const run = () => {
      if (root.getAttribute("data-cb-home") !== "1") return;
      for (const aside of document.querySelectorAll(RAIL)) {
        for (const link of aside.querySelectorAll(RAIL_LINK)) {
          const card = childOf(aside, link);
          if (card) card.classList.add("cb-blocked");
        }
      }
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        run();
      });
    };

    const watch = () => {
      run();
      if (!observer) observer = new MutationObserver(schedule);
      observer.observe(root, { childList: true, subtree: true });
      clearTimeout(stop);
      stop = setTimeout(() => observer.disconnect(), 10000);
    };

    watch();
    NAV_HOOKS.push(watch);
  }

  /* The ancestor of `node` that is a direct child of `parent`, or null. */
  function childOf(parent, node) {
    let el = node;
    while (el && el.parentElement !== parent) el = el.parentElement;
    return el;
  }

  /* ------------------------------------------------------ instagram, facebook */

  /*
   * Both home feeds end after FEED_CAP posts, and Instagram's ends earlier still if
   * it reaches "You're all caught up". The CSS hides every post on the home page
   * until it is marked, so nothing flashes; this marks the first ones data-cb-ok and
   * everything after them data-cb-hide.
   *
   * Marked, not counted on screen: both sites drop posts from the DOM as they scroll
   * out of view and build new elements when they scroll back, so an allowed post is
   * remembered by its key (the permalink on Instagram, the feed position on Facebook)
   * and re-marked on its return.
   *
   * Once the feed has ended, everything after it is hidden as well - the loading
   * spinner, Instagram's suggested posts. This marks the end of the feed and each of
   * its ancestors data-cb-end, and the CSS hides every sibling after a marked element,
   * so whatever the site adds there later is hidden before it is ever painted. That
   * also takes the infinite scroll's trigger out of view; the page is short by then,
   * and with the trigger visible the site would fetch posts nobody will see for as
   * long as the tab is open.
   *
   * Opening a post or photo changes the URL but leaves the feed mounted behind the
   * viewer, so the feed is followed for as long as it is still in the document, not
   * only while the URL says home. Once it's gone the count starts over, so coming
   * back to home later gets its own posts.
   */
  function capFeed(root, feed) {
    const cap = FEED_CAP[SITE];
    let allowed = new Set(); // keys of the posts let through
    let count = 0; //            how many posts were let through
    let done = false;
    let byCap = false; //       ended by the count rather than by Instagram's marker
    let anchor = null; //       the last thing on the feed that stays visible
    let scheduled = false;

    const alive = () =>
      document.querySelector(`[${OK}]`) !== null || (anchor !== null && anchor.isConnected);

    const reset = () => {
      const selector = MARKERS.map((attr) => `[${attr}]`).join(",");
      for (const el of document.querySelectorAll(selector)) {
        for (const attr of MARKERS) el.removeAttribute(attr);
      }
      allowed = new Set();
      count = 0;
      done = byCap = false;
      anchor = null;
    };

    const run = () => {
      const started = count > 0 || done;
      if (started && !alive()) reset();
      if (root.getAttribute("data-cb-home") !== "1" && !(started && alive())) return;

      // Looked for again even after the feed has ended there, in case Instagram has
      // rebuilt the notice as a new element.
      const end = byCap ? null : feed.end();
      if (end) for (const el of end.hide) if (!el.hasAttribute(HIDE)) el.setAttribute(HIDE, "");
      const cutoff = end && end.anchor;

      const posts = feed.posts();
      for (const post of posts) {
        const key = feed.key(post);
        if (post.hasAttribute(OK)) {
          allowed.add(key); // its permalink may only have rendered since it was let in
          continue;
        }
        if (allowed.has(key)) {
          post.setAttribute(OK, "");
          continue;
        }
        if (post.hasAttribute(HIDE)) continue;

        const open = !done && count < cap && !(cutoff && follows(cutoff, post));
        if (open) {
          allowed.add(key);
          count++;
          post.setAttribute(OK, "");
        } else {
          post.setAttribute(HIDE, "");
        }
      }

      if (!done && (cutoff || count >= cap)) {
        done = true;
        byCap = !cutoff;
      }
      if (!done) return;

      const lastOk = posts.filter((post) => post.hasAttribute(OK)).pop();
      if (cutoff) anchor = cutoff;
      else if (byCap && lastOk) anchor = lastOk;
      if (!anchor || !anchor.isConnected) return;

      const stop = feed.stop(posts, anchor);
      if (stop && stop !== anchor && stop.contains(anchor)) markEnd(anchor, stop);

      if (byCap && !anchor.hasAttribute(LAST)) {
        for (const el of document.querySelectorAll(`[${LAST}]`)) el.removeAttribute(LAST);
        anchor.setAttribute(LAST, `Focus Blocker: that's your ${cap} posts`);
      }
    };

    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        run();
      });
    };

    // Unlike LinkedIn's rail, a feed never finishes building - it virtualises as you
    // scroll - so this watches for as long as the tab is open.
    run();
    new MutationObserver(schedule).observe(root, { childList: true, subtree: true });
    NAV_HOOKS.push(schedule);
  }

  /*
   * Mark `anchor` and each of its ancestors up to (not including) `stop`; the CSS
   * then hides every sibling that follows any of them.
   */
  function markEnd(anchor, stop) {
    for (let node = anchor; node && node !== stop; node = node.parentElement) {
      if (!node.hasAttribute(END)) node.setAttribute(END, "");
    }
  }

  function follows(a, b) {
    return (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
  }

  /* The deepest element that contains every one of `nodes`. */
  function commonAncestor(nodes) {
    let el = nodes[0];
    while (el && !nodes.every((node) => el.contains(node))) el = el.parentElement;
    return el;
  }

  /* `el`'s widest ancestor, below `scope`, that holds nothing matching `selector`. */
  function widestWithout(el, selector, scope) {
    while (el.parentElement && el.parentElement !== scope && !el.parentElement.querySelector(selector)) {
      el = el.parentElement;
    }
    return el;
  }

  /* `el`, or the wrapper around it that holds nothing else. */
  function soleWrapper(el, scope) {
    while (el.parentElement && el.parentElement !== scope && el.parentElement.childElementCount === 1) {
      el = el.parentElement;
    }
    return el;
  }

  /*
   * Instagram: every post is an <article> in <main>. An opened post is an <article>
   * too, but it sits in a dialog, and is never part of the count.
   */
  function instagramPosts() {
    const main = document.querySelector("main");
    if (!main) return [];
    return [...main.querySelectorAll("article")].filter((a) => !a.closest('[role="dialog"]'));
  }

  /* A post's shortcode, from its timestamp link (/p/CODE/ or /reel/CODE/). */
  function instagramKey(post) {
    for (const link of post.querySelectorAll('a[href*="/p/"], a[href*="/reel/"]')) {
      const match = link.getAttribute("href").match(/\/(?:p|reel)\/([^/?#]+)/);
      if (match) return match[1];
    }
    return post;
  }

  /*
   * "You're all caught up", and the "Suggested Posts" heading after it, found by
   * their text since neither has a stable name. The walk skips over posts entirely,
   * which is both what keeps a caption from matching and what keeps it cheap.
   *
   * The feed ends at the widest wrapper around the notice that holds no post, so the
   * notice itself stays on screen as the end of the feed. The heading may share that
   * wrapper, so it is hidden by itself as well.
   */
  function instagramEnd() {
    const main = document.querySelector("main");
    if (!main) return null;

    let caughtUp = null;
    const headings = [];
    const walker = document.createTreeWalker(main, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        return node.tagName === "ARTICLE" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP;
      },
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const el = node.parentElement;
      if (!el) continue;
      if (!caughtUp && IG_CAUGHT_UP.test(node.nodeValue)) caughtUp = el;
      else if (IG_SUGGESTED.test(node.nodeValue)) headings.push(soleWrapper(el, main));
    }

    const marker = caughtUp || headings[0];
    if (!marker) return null;
    return { anchor: widestWithout(marker, "article", main), hide: headings };
  }

  /*
   * What gets hidden after the end of the feed stays inside the feed's own column:
   * the smallest element holding every post and the spinner below them. The spinner
   * sits a level outside the list of posts, and has to be inside the bound, since it
   * is what triggers the next load. Stories sit above, and the right-hand column well
   * outside, so neither is touched.
   */
  function instagramStop(posts, anchor) {
    const main = document.querySelector("main");
    if (!main) return null;
    const spinner = [...main.querySelectorAll(IG_SPINNER)].find((el) => follows(anchor, el));
    const column = commonAncestor(spinner ? [...posts, anchor, spinner] : [...posts, anchor]);
    return column && column !== main && main.contains(column) ? column.parentElement : main;
  }

  /*
   * Facebook: every post is a div[aria-posinset], numbered by its place in the feed,
   * inside [role="main"] - the middle column, with both side columns outside it.
   * There is no feed container to speak of; the posts sit about ten wrappers deep in
   * a list of their own. Only the outermost count, in case a post ever quotes one.
   *
   * If an allowed post is still in the document, the feed is the one holding it, so
   * a photo viewer's URL doesn't send this looking in a different column.
   */
  function facebookPosts() {
    const ok = document.querySelector(`[${OK}]`);
    const main = (ok && ok.closest('[role="main"]')) || document.querySelector('[role="main"]');
    if (!main) return [];
    return [...main.querySelectorAll("[aria-posinset]")].filter(
      (post) => !post.parentElement.closest('[aria-posinset], [role="dialog"]')
    );
  }

  /* ---------------------------------------------------------- instagram reels */

  /*
   * The Reels tab plays REELS_CAP reels, then is blocked until REELS_BREAK has
   * passed since the last one it counted. Reels are counted by URL: the tab
   * rewrites it to /reels/CODE/ for each reel you scroll onto, and that outlives
   * any change to Instagram's markup. A reel is counted once however often you
   * scroll back to it.
   *
   * The count lives in storage, shared by every tab and kept across reloads. Until
   * it has been read, instagram.css keeps the tab hidden without a note; once it is,
   * this marks <html> "ok" or "over".
   */
  function capReels(root) {
    let state = null; // { seen, last }, once read from storage
    let timer = null;

    const quiet = silence(
      () =>
        root.hasAttribute(FLAG_ATTR) &&
        IG_REELS.test(location.pathname) &&
        root.getAttribute(REELS_ATTR) === "over"
    );

    const fresh = (saved) =>
      saved && Date.now() - saved.last < REELS_BREAK ? saved : { seen: [], last: 0 };

    const run = () => {
      const match = location.pathname.match(IG_REELS);
      if (!match) {
        root.removeAttribute(REELS_ATTR);
        root.removeAttribute(NOTE_ATTR);
        quiet.release();
        return;
      }
      if (!state) return;

      state = fresh(state);
      const code = match[1];
      if (code && !state.seen.includes(code) && state.seen.length < REELS_CAP && root.hasAttribute(FLAG_ATTR)) {
        state = { seen: [...state.seen, code], last: Date.now() };
        chrome.storage.local.set({ [REELS_KEY]: state });
      }

      const over = state.seen.length >= REELS_CAP && !state.seen.includes(code);
      root.setAttribute(REELS_ATTR, over ? "over" : "ok");
      clearTimeout(timer);
      if (!over) {
        root.removeAttribute(NOTE_ATTR);
        quiet.release();
        return;
      }

      // Lift the block by itself when the break is up, without needing a reload.
      const back = state.last + REELS_BREAK;
      const at = new Date(back).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      root.setAttribute(NOTE_ATTR, `Focus Blocker: that's your ${REELS_CAP} reels. Reels are back at ${at}.`);
      quiet.hush();
      timer = setTimeout(run, Math.max(0, back - Date.now()) + 100);
    };

    chrome.storage.local.get({ [REELS_KEY]: null }, (saved) => {
      state = fresh(saved[REELS_KEY]);
      run();
    });

    // Another tab counting a reel.
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !(REELS_KEY in changes) || !changes[REELS_KEY].newValue) return;
      state = fresh(changes[REELS_KEY].newValue);
      run();
    });

    run();
    NAV_HOOKS.push(run);
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
