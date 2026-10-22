# Focus Blocker

A Brave/Chrome (MV3) extension that strips recommendation feeds and comments out of
YouTube, Amazon and LinkedIn, and cuts the Instagram and Facebook home feeds short.

## Install

1. Open `brave://extensions`
2. Turn on **Developer mode** (top right)
3. Click **Load unpacked** and pick this folder (the one containing `manifest.json`)
4. Pin the extension so its icon is on the toolbar

Reload any YouTube/Amazon/LinkedIn/Instagram/Facebook tabs that were already open.

## Use

Blocking is always on by default. Click the toolbar icon for a popup with one switch
per site; flipping a switch takes effect immediately in every open tab.

## What it blocks

| Site | Blocked | Kept |
| --- | --- | --- |
| YouTube home | Video grid, Shorts shelves, the filter chip bar | Sidebar, logo, search, Create, bell, avatar |
| YouTube sidebar | The **Shorts** entry, expanded and collapsed | Home, Subscriptions, You, Explore, everything else |
| YouTube Shorts | `/shorts/…` pages render blank and stay silent | URL and history are untouched, so Back works normally |
| YouTube watch | Right-hand recommendations + their tag row, comments, end-screen/pause suggestions, in-video cards | Player, title, channel, description, live chat, playlist queue |
| Amazon home | Everything below the top menus | Search bar, category row, account, orders, cart, hamburger menu |
| LinkedIn feed | Posts, the "Start a post" box, LinkedIn News, Today's puzzles | Top nav, left profile card, footer links, messaging |
| Instagram home | Every post after the 10th, or after "You're all caught up" if that comes first, including the suggested posts below it | Stories, the first posts, left nav, right column |
| Instagram Reels tab | Every reel after the 10th, until 10 minutes have passed since the last one counted | Reels sent in messages, which open as `/p/…` and are never counted |
| Facebook home | Every post after the 10th | Post box, stories, the first posts, both side columns |

Amazon search results and product pages are untouched, as are LinkedIn profiles,
search, jobs and messaging, and every Instagram and Facebook page other than the
home feed and Instagram's Reels tab. The post count starts over on every page load;
change it in `FEED_CAP` at the top of `src/content.js`. The reel count is kept in
extension storage, so reloading or opening a new tab doesn't reset it; change it in
`REELS_CAP` and `REELS_BREAK`.

## How it works

| File | Role |
| --- | --- |
| `manifest.json` | Declares the five sites and what gets injected into them |
| `src/<site>.css` | The actual blocking. Injected by the browser at `document_start`, before first paint |
| `src/content.js` | Sets the flag attribute the CSS is gated on, tracks YouTube's and LinkedIn's client-side navigation, and walks Amazon's and LinkedIn's DOM as a backup, and decides which Instagram/Facebook posts make the cut |
| `src/popup.*` | The five on/off switches |

Robustness comes from layering rather than from any one selector:

- **CSS does the blocking**, so content is suppressed as it appears, however late the
  site loads it. No polling, nothing to "catch".
- **Every rule is gated on an attribute** (`html[data-cb-yt="on"]` /
  `html[data-cb-amz="on"]` / `html[data-cb-li="on"]`) that `content.js` sets
  synchronously at `document_start`. That is what makes always-on CSS toggleable
  without a flash of unblocked content.
- **Page detection is doubled up.** YouTube rules key primarily off YouTube's own
  state elements (`ytd-browse[page-subtype="home"]`, `ytd-watch-flexy`), with a
  URL-derived `data-cb-path` marker on `<html>` as a parallel fallback. Either one
  alone blocks; a rename of one doesn't take the blocking with it.
- **Amazon is handled three ways**: hide the navbar's siblings, hide known content
  container ids, and have `content.js` walk up from the navbar marking every branch
  that isn't the nav. The third is structure-agnostic and survives an id reshuffle.
- **LinkedIn avoids class names where it can.** The middle column is matched both by
  the share box it contains and by the URL. The two rail modules are matched by name,
  by the links inside them (`/news/…`, `/games/…`) via `:has()`, and by `content.js`
  walking up from those same links to the card that sits in the rail. Link targets
  outlive class names, and unlike the module headings they aren't translated.
- **Instagram and Facebook are capped, not blanked.** Their class names are
  machine-generated and change constantly, so nothing keys off them. The CSS hides
  every home-feed post (Instagram's `main article`, Facebook's `[aria-posinset]`,
  the screen-reader numbering of each post) from first paint; `content.js` marks
  the first ones `data-cb-ok` and the rest `data-cb-hide`. Allowed posts are
  remembered by permalink / feed position, because both sites delete posts that
  scroll out of view and rebuild them on the way back. Once the feed ends,
  `content.js` marks the end and its ancestors `data-cb-end` and a sibling selector
  (`[data-cb-end] ~ *`) hides everything after it, including whatever arrives
  later and the infinite-scroll spinner, so the site stops fetching posts that would
  never be shown. Instagram's "You're all caught up" notice is found by its text.

On the SPA question from the original notes: a content script is needed on YouTube
and LinkedIn, but only to keep the page marker in sync — the CSS itself never re-runs
and never needs re-injecting across client-side navigations.

## If something leaks through

Right-click the element → Inspect, and send the tag name plus its `id`/`class`. Adding
it is a one-line CSS change.

---

## Original design notes

I want to make a web browser extension (windows 11), which blocks web page content from select sites: youtube and amazon. the reason is I don't like that these sites try to distract me with targeted reccomendations, I simply want to go onto them to search for the thing I want and leave. 

youtube: 
    - the whole home page of youtube should be blank - as in the web page elements don't appear for home page video and post recommendations. only the side bar is visable. 
    - when watching a video, I want the comment section gone and the video reccomendations gone.
    - keep: the side menu, the youtube logo, the search bar, the user profile in the top right, the notification bell icon in the top right to the left of the profile picture.
    - I've provided an image called example_images/youtube_example_home_page.png. the elements in the red circles (which I drew) should be kept. everything else should be blocked. the vertical menu on the left of the screen is opened by clicking the 3 horizontal slashes above it. the youtube logo may or may not say "Premium" instead of "youtube" (this depends on if the user pays a subscription to youtube).
    - I've provide an image called example_images/youtube_example_watching_video.png. it shows what the screen looks like (zoomed out so we see everything we need to see) when watching a video. I want to block the elements circled in yellow. this is the right side video recommendations which also includes a horizontal "tag" menu above them at the top of the video recommendations. it also includes the comment section under the video description.

amazon: 
    - all home page elements should be gone except the top menus (search bar, site categories like grocery, coupons, todays deals..., my account, my cart, etc...)
    - look at example_images/amazon_example_home_page.png: notice that I've circled the top menu portion of the home page in red, keep that. so you could find the bottom of this and simply block everything under it.

linkedin (added later):
    - block the home post feed (the posts from around the community).
    - block the post option (the box where the user goes to make a post).
    - block the "LinkedIn News" side menu.
    - block the "Today's puzzles" side menu.
    - look at example_images/linkedin_example_home_page.png: the areas to block are circled in red. Totally blocked, same as the other sites — not visible at all.

browser: brave
system: windows 11
rule: blocking should always be active. but clicking the extension opens a small popup menu showing selectors for youtube, amazon and linkedin (1 for each). clicking the selector turns the blocking on and off for that site. 

My assumptions of the design:
- I assume brave works with manifest v3 (MV3)
- a manifest.json — declares which sites the extension touches (*.youtube.com, *.amazon.com) and what gets injected into them.
- A CSS file per site — this is the actual blocking mechanism. You inject a stylesheet that sets display: none on the elements you don't want to see. This is the key trick: CSS rules apply to elements as they appear, even if the site loads them in half a second later via JavaScript. You don't need to "catch" anything with a script — the stylesheet just sits there and suppresses matching elements forever, no polling required.
    - do you have any other recommendation? is this the best option?
- A small content script (JS), needed only for YouTube because youtube is a single page app. clicking a video doesn't reload the page, it swaps content via JavaScript and updates the URL with history.pushState

I used to have an extension that blocked youtube content, but I lost it years ago. it never stopped working so it's likely that if we can get this working then it will stay working. however we still need to design it robustly so it's hard for site updates to break it.