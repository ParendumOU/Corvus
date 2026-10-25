# Changelog

## v0.20.0

### Privacy & connections
- **Private windows** (menu → New private window, Ctrl+Shift+N, or a link's menu → Open link in
  private window): cookies, storage and cache live in memory only and go when the last private
  window closes; no history, no place in the saved session, the synced open tabs or "Find in my
  pages". Their downloads are listed while they are open and never saved to the list (the files
  stay). Extensions do not run in them and AI agents do not see them. They connect like their
  profile (its proxy too). The toolbar says **Private**, and so does the New Tab page.
- **Proxies** (Settings → Connections): send a profile through an HTTP, HTTPS, SOCKS4, SOCKS5 or PAC
  proxy, and each container through a different one. Proxies that ask for a sign-in get it from
  Corvus (the password is encrypted with the system keychain). **Site rules** send some sites
  another way (`*.example.com` direct, or through another proxy). A proxy that stops answering
  makes its pages fail instead of going out through your own connection, and WebRTC stays on the
  proxy so sites cannot see your real address. Downloads and extensions go the same way; sync,
  updates and AI services keep using the computer's connection. **Test** tries a proxy on its
  own, and **Check connection** shows the address sites see (it asks Cloudflare, only when you
  click it).

## v0.19.0

### Downloads
- **File hosts download in the background**: links to MEGA, MediaFire, Google Drive, Dropbox,
  OneDrive, WeTransfer, Gofile, Pixeldrain, Yandex Disk, SourceForge, 1fichier, KrakenFiles,
  SendSpace, Solidfiles, BuzzHeavier and the hosts built on XFileSharing (Send.cm, Katfile,
  DDownload and others) no longer open tabs: the download queue finds the file behind each page
  and downloads it with the rest of the package, with its progress in corvus://downloads. Folder
  links (MEGA, MediaFire, Google Drive, Gofile, Pixeldrain lists, OneDrive) become their files, in
  a package named after the folder. MEGA files are decrypted as they arrive, and the parts of a
  large one can come in parallel.
- **Waits and limits**: when a host asks to wait (a countdown, a free-download limit, MEGA's
  transfer quota, "busy, retry later"), the file waits in the queue with the time left and starts
  again on its own. Free hosts get one file at a time.
- **When a host needs you**: a CAPTCHA, a sign-in, a password or a premium-only file puts the file
  on **Needs you** with the reason; **Open page** opens its page, and what you download there lands
  in that file's place in the queue. A notification tells you when Corvus is in the background.
  Sites you are signed in to (premium accounts) work as in the browser. Corvus never solves
  CAPTCHAs.
- **Any page, from its menu**: right-click a link and choose **Add link to download queue**
  (Corvus finds the file on the page it leads to), or right-click a selection and choose
  **Grab download links in selection**. Shorteners that lead to a known host are followed.
- **Copied links**: the toolbar offer for copied download links has **Download** (straight to the
  queue), and the link grabber has **Detect links I copy** to turn it on or off where you use it.
- **The toolbar's downloads button** shows the queue too: its progress, the files left, and the
  ones that need you.
- Fixed: a file host's page named like an archive part (`….part1.rar.html`) was downloaded as if it
  were the archive.

### Extensions
- **`chrome.bookmarks` and `chrome.history`**: extensions that ask for them (bookmark and history
  managers, tab savers) now work in Corvus, over the profile's own bookmarks and history, with
  Chrome's events for changes made anywhere (by you, by sync or by an extension). Extensions may
  bookmark or add web and file addresses only, never `javascript:` bookmarklets.
- **`chrome.tabGroups` and `chrome.tabs.group` / `ungroup`**: tab managers can group, name, color,
  collapse and move Corvus's tab groups and hear about their changes. Groups keep Chrome's colors.
- **`chrome.sessions`**: recently closed tabs (restore reopens them where they were) and the tabs
  open on your other devices when sync is on.
- **`chrome.sidePanel`**: an extension's side panel (Bitwarden, AI sidebars, notes) docks on the
  right of the window under a bar with its name and ✕; its toolbar button opens and closes it when
  the extension asks for that.
- **Extension keyboard shortcuts** (`chrome.commands`): the shortcuts an extension suggests work
  in Corvus (its toolbar button for `_execute_action`, `onCommand` for the rest), unless Corvus
  already uses that key; `commands.getAll` says which ones work.
- **`chrome.downloads`**: download managers and "save all" extensions now work: what they start
  lands in your downloads list and folder (under the name they suggest, never outside the folder),
  and they can pause, resume, cancel, search and clear downloads and hear about them. A program an
  extension asks for waits for you, like one an agent asks for, and extensions never open programs.
- **`chrome.topSites`** answers with your most visited sites (it failed before).
- Extensions that ask for `search` now see it as missing (and the extension card lists it) instead
  of finding an API that never answered.

## v0.18.0

### Faster and smaller
- **Starts sooner**: the browser window is ready about a fifth sooner (about 0.35 s on the test
  machine). The app no longer builds its self-test data on every start (a 20 MB buffer), and the
  MCP server, the Anthropic SDK and the self-test code load only when they are needed.
- **Smaller downloads**: about 20 % smaller installers (Linux: AppImage 164 → 130 MB, deb 129 → 103
  MB). The PDF viewer's library is built into the viewer instead of shipping a second copy with
  native canvas binaries it never used (and that were Linux binaries even in the Windows build).
- `CORVUS_STARTUP_PROBE=1` prints how long a start took and quits, for measuring.

### AI agents in other apps (MCP)
- **Activity log**: Settings → AI agents keeps which tool each agent called, on which site, how it
  ended (with the tool's own error message) and how long it took, for 30 days on this device:
  per tool over the last 24 hours, then the latest calls filtered by agent or to the ones that
  failed, with **Export CSV** and **Clear**. Never what an agent typed or what pages said. On by
  default; **Keep an activity log** turns it off.
- **Rate limit**: choose how many tool calls each connected agent may make (Strict: 1 a second,
  bursts of 10; Standard: 5 a second, bursts of 30, as before; Relaxed: 20 a second, bursts of
  100). Calls over the limit show in the log, with a notice when there were any in the last day.

### Command Bar
- **Recent**: tasks you gave the agent and searches and addresses you typed in the Command Bar
  show under **Recent** when it opens empty. A task comes back as "> task" to read or change
  before Enter runs it again; × removes an entry. Settings → Command Bar agent → **Remember what
  you run** (on by default, per device) and **Clear**.

### Sync
- **Command Bar history** syncs end to end (Settings → Sync → **Sync Command Bar history**, on
  by default, per device; new collection `command_history`: self-hosted sync servers need this
  release's server, an older one keeps the history on each device).
- **Changes replaced by another device**: when you change a bookmark, a setting, a reading-list
  item, a watched page, a workspace or an annotation here while another device changes it too, the
  other device's newer change is used everywhere as before, but your version is no longer lost:
  Settings → Sync lists it next to the one in use, with **Use this device's version** (it syncs
  as a new change and wins) or **Keep the one in use**. Saved logins are left out (no passwords
  are kept outside the vault).

## v0.17.0

### Browser
- **Saved logins under the login field**: clicking a page's username or password field lists the
  logins saved for the site right under it, as other browsers do; picking one fills the form. The
  key button in the address bar still works as before.
- **The whole interface in Spanish**: with Settings → Language in Spanish (or a Spanish system),
  the browser bar, its popovers and the command bar, every Corvus page and its tab title, Assist,
  the reader and the native dialogs (agent approvals, spend and download prompts, crash recovery)
  are in Spanish too, not only Settings, the New Tab page and the menus.

## v0.16.0

### AI agents in other apps (MCP)
- **Every connector tool now works in Corvus**: the desktop controller implements the capabilities
  the MCP server registers tools for, so agents get screenshots of the viewport, one element or the
  full page (CSS-sized for the coordinate tools), element boxes and same-origin frames in
  `page_snapshot` (cross-origin frames listed as `frame`), `find`, `get_text`, `extract`,
  `get_html`, `wait_for`, `tab_wait_load`, `click_at`, `double_click_at`, `right_click_at`,
  `hover_at`, `drag`, `press_keys`, `type_text`, `scroll_at`, `hover`, `focus`, `check`,
  `select_option`, `fill_form`, `fill_fields`, `zoom`, `set_viewport` and, with Full access,
  `upload_file` (absolute paths, no programs, up to 20 files and 200 MB), `pdf` and
  `downloads_list`.
- **`request_user_action`**: the agent hands a step to the person (sign-in, a code) in a native
  Done/Cancel prompt next to the tab it brings forward.
- **`handle_dialog`**: an `alert`/`confirm` in a tab an agent works in shows in `page_snapshot`;
  other actions on that tab are refused until it is answered, by the agent or by the person in the
  native box (which closes either way). Corvus answers `prompt()` with Cancel, as before.
- **Spend gate**: clicks at coordinates, Enter/Space, line breaks typed into a field and accepting a
  page question that spends money (an amount, a purchase word, or a checkout page) ask the person in
  the same **Allow once / Deny** dialog; a click inside a payment iframe always asks.


## v0.15.0

### Your phone
- **Answer questions from Corvus on your phone**: questions asked in Corvus for mobile go to this
  computer, which answers them with Corvus's AI search and its own AI provider and writes the answer
  back as it streams in, with its sources and follow-up questions. Settings → Send to your phone →
  **Answer questions from Corvus on your phone** (on by default, per computer). Corvus has to be
  open; it looks for new questions every 5 seconds.
- **Send a page straight to your phone**: "Send to your phone…" in a tab's or a link's menu has a
  button for each phone paired with this profile's sync. The page shows on the phone's home screen.
- **Sync server**: the server now accepts questions from the phone (collection `asks`). If you host
  your own, update it; an older server refuses them and the phone says so.

### Browser
- **Search shortcuts**: a keyword and a space in the address bar search a site with the rest ("yt
  cats" searches YouTube); the first suggestion says which site. **Settings → Search shortcuts**
  adds or removes them; they travel with profile exports.
- **Import from another browser** brings search shortcuts too (Chromium's own site searches,
  Firefox's engines with an alias and its bookmark keywords) and lists each profile's extensions:
  the Chrome Web Store ones with **Add to Corvus**, Firefox's add-ons with a Web Store search.

## v0.14.0

### Browser
- **Default browser**: while Corvus is not your default browser, a bar under the toolbar offers
  **Make default** once per launch (**Not now**, **Don't ask again**), and **Settings → Default
  browser** shows where it stands. On Windows, Corvus adds itself to Default apps for links, web
  pages and PDFs and opens Default apps on Corvus, where you choose **Set default**; the
  uninstaller removes it. On Linux it sets itself with xdg-settings; on macOS the system asks you.
- **Open files with Corvus**: web pages (.html, .htm, .xhtml, .shtml), SVG and WebP images and PDFs
  you open from your files, and links from other apps, open in Corvus (PDFs in its viewer).
- **Import from another browser**: **Settings → Import** (and the welcome screen) finds Chrome, Edge,
  Brave, Vivaldi, Opera, Opera GX, Chromium and Firefox on this computer, lists each profile with
  how many bookmarks, history pages and open tabs it holds, and brings the kinds you pick into
  Corvus: bookmarks keep their folders, history merges with yours, and each open window becomes a
  workspace with its pinned tabs and tab groups. The other browser's files are only read, from
  copies, never changed.
- **Passwords from a CSV**: export your logins to a CSV in the other browser and pick it under
  **Settings → Import**; Corvus adds the ones it does not already have to its password manager. The
  file is plain text, so delete it when you are done.

### Downloads
- **Download with AI**: in corvus://downloads → Link grabber, **With AI** on a package; **AI** on the
  copied-links button in the toolbar; or right-click a tab and choose **Download with AI**. Corvus's
  agent opens the file-host pages and mirrors, uses their free download buttons, and hands the real
  file links (every volume of a split archive, with the archive password) to the download queue.
  The Command Bar always shows you the list of files first, and nothing downloads until you
  approve it. Programs are never downloaded for an agent.
- **When a file host needs you**: if a host shows a CAPTCHA, asks you to sign in or offers the file
  only to premium accounts, the agent stops on that file and asks you to deal with it in its tab;
  when you click Done it carries on with the rest. If Corvus is in the background, a notification
  tells you.
- **Who added it**: packages an AI agent queued say so in the queue.

### AI agents (MCP)
- **Download queue tools** (Full access): `download_queue` lists packages with their progress,
  checksums and extraction; `download_queue_add` queues files by direct link with a package name
  and password, after you allow it in a browser dialog; `download_queue_control` pauses, resumes,
  retries, removes or extracts a package or file. A file the server names as a program fails
  instead of downloading.

### Ad blocker
- **YouTube ads stay out**: hover previews on the home page and swiping Shorts could be taken for
  YouTube refusing to play without its ads, which made Corvus skip YouTube's ads for 24 hours
  instead of removing them. Only a real playback loop on a video's page counts now, the fallback
  lasts 2 hours, one left by 0.13.0 is dropped, and the shield on YouTube has **Remove them again**.
  The ad skipper also finds YouTube's newer skip buttons.

### Search
- The rating circle next to each result kept its shape while rating instead of stretching into an
  oval.

## v0.13.0

### Downloads
- **Link grabber**: right-click a tab and choose **Grab download links**, or paste a whole post in
  corvus://downloads → Link grabber. Corvus keeps the links to files, to file hosters and to the
  volumes of split archives, groups the volumes of one archive into a package in order
  (`.part1.rar`, `.r00`, `.7z.001`, `.z01`, `.001`), and keeps the archive password written next to
  them ("Password: …", "Contraseña: …"). With **Settings → Downloads → Offer copied download links**
  on, links you copy show up as a button in the toolbar.
- **Download queue**: packages download into their own folder, a few files at a time and at most
  two per site, through your own session (sites you are signed in to work). Pause, resume, retry,
  remove and reorder; a paused or interrupted file resumes where it stopped, failures retry on
  their own, and the queue survives a restart. corvus://downloads shows each package's progress,
  speed and time left.
- **Parallel connections**: a file of 16 MB or more on a server that supports it downloads over up
  to four connections at once (Settings → Downloads, 1 to 8), and each part resumes where it
  stopped after a pause, a failure or a restart.
- **Checksums**: when a package is complete, files listed in its `.sfv`, `.md5`, `.sha1` or
  `.sha256` are checked; a file that does not match is marked failed with both hashes, and
  retrying downloads it again from the start.
- **Extracting archives**: when a package is complete, Corvus joins split files (`.001`, `.002`, …)
  and extracts RAR, 7z and ZIP archives, multi-part ones too, into the package's folder, in the
  background. It tries the password found next to the links, then the package and archive names,
  then your list in **Settings → Downloads → Archive passwords**; when none opens it, the package
  asks you for one, and a password you type that works is added to the list. Optionally, the
  archives are deleted once extracted (**Delete archives after extracting**).

### Browser
- **Menus in Spanish**: the app, tab, group, profile, bookmarks and page menus follow the
  interface language.
- **Sites behind Cloudflare**: Corvus sends one consistent browser identity on every request
  (Chromium's user agent and client hints on navigations too), so sites stop challenging every
  visit and accept you once you pass the check. With the built-in blocker off, an installed
  extension that blocks requests (such as uBlock Origin Lite) keeps blocking; navigations then go
  out without the client hints.
- **window.open**: pages that open a tab and then write into it or post a form to it now work, as
  in any browser.
- **Easier tab closing**: the tab close button is twice as big.

### Claude Code plugin
- The connector's guide explains how to turn on auto-update for the Corvus marketplace, so the
  plugin updates on its own.

## v0.12.0

### Reading list
- **Read state**: corvus://reading has Mark read / Mark unread, synced with your other devices
  and the Corvus mobile app.
- **Links saved on your phone**: a link saved to the reading list from the mobile app arrives
  without its article; Corvus fetches the page (public addresses only, without your cookies) and
  keeps the reader-mode article, which then syncs back to the phone.

### Sync
- **Watched pages on your phone**: Corvus publishes what its page monitor last saw of each
  watched page (last check and change, the change summary, whether your "Notify me when…"
  condition holds), so the mobile app can show it. Watches added on the phone are monitored here.
- **Sync server**: the server now accepts that status (collection `watch_status`). If you host
  your own, update it; an older server simply leaves it out.

## v0.11.0

### Sync
- **Pair a phone**: Settings > Sync has "Pair a phone". After a confirmation it shows a QR code
  with your sync server's address and your recovery phrase for the Corvus mobile app to scan
  (it hides itself after two minutes). It warns when the server address is one a phone cannot
  reach, such as `localhost`.
- **Pages from your phone**: pages sent from the Corvus mobile app open as background tabs on
  the computer they were sent to, with a notification, usually within a minute while Corvus is
  running. Corvus looks for them with one small request every 30 seconds between syncs.
- **Sync server**: the server now accepts pages sent between devices (collection `sent_tabs`).
  If you host your own, update it; the phone tells you when the server is too old to send pages.

### Updates
- The beta channel now finds desktop releases past Corvus for mobile releases, which share the
  same GitHub repo (tags `mobile-v…`).

## v0.10.0

### Browser
- **Send to your phone**: "Send to your phone…" in a tab's menu (and "Send link to your phone…" in
  a link's menu) shows the page as a QR code to scan with your phone's camera. Link your own
  Telegram bot in Settings > Send to your phone to send pages there too, and to open the links you
  send to it from your phone; messages from anyone else are ignored.
- **Move a profile**: Settings > Profiles can export a profile to one password-protected file
  (bookmarks, history, reading list, annotations, workspaces, site settings, containers, watched
  pages, workflows and saved logins) and import it on another computer as a new profile.

### AI
- **Local models, found for you**: Settings > AI search notices Ollama, LM Studio or llama.cpp
  running on this computer and offers to use it in one click, so AI search and Corvus Assist stay
  on the device with no API key. With a local model, the model field lists the server's models.

## v0.9.0

### Corvus Assist
- **Write with Corvus AI in any text field**: right-click a page's text field to fix spelling and
  grammar, make the text shorter or longer, more formal or friendlier, translate it, or choose
  "Write…" and say what to write. The text appears in the Assist panel and goes into the field only
  when you click "Insert into the field" (Ctrl+Z undoes it). Password, one-time-code and card fields
  are never read.
- **Compare tabs**: "Compare tabs with Corvus AI…" in a tab's menu lets you pick two to six of the
  window's pages and say what matters ("battery and price"). Corvus reads each one, even tabs that
  are asleep, and answers with a table, one column per page, and a verdict. "Copy table" copies it
  as Markdown.

### Browser
- **Watched pages that notify on a condition**: give a watch in corvus://watches a condition in your
  own words ("the price is under 150 €", "it is back in stock") and Corvus tells you only when it
  comes true, with the fact that decided it, instead of on every change.

## v0.8.0

### Browser
- **Containers**: tabs in a container keep their own cookies and site data, so you can be signed
  in to two accounts of one site, or keep shopping and banking apart from everything else.
  Personal, Work, Shopping and Banking are there to start with (Settings > Containers adds,
  renames, recolours and removes them). Open one from the menu (New container tab), a link's menu
  (Open link in container tab) or a tab's menu (Reopen in container); pages a container tab opens
  stay in it. A container tab shows a line in the container's colour under its icon and the
  container's name in the address bar. Extensions do not run in container tabs.
- **Split view of up to four tabs**: two side by side, one beside two stacked, or a 2x2 grid,
  with both dividers to drag. "Add to split" and "Remove from split" are in a tab's menu.
- **A split waits while you look elsewhere**: showing a tab outside the split no longer ends it;
  showing any of its tabs brings the whole split back.
- **Automatic picture-in-picture**: when you switch away from a tab whose video is playing with
  sound, the video keeps playing in a small floating window, and returns to the page when you
  come back. Settings > Media turns it off.

## v0.7.0

### Privacy
- **Fingerprinting protection**: sites that read your canvas, graphics card, audio stack, CPU
  count or device memory to recognise you get slightly different values on each site and each
  session, so those readings no longer follow you from site to site. It is on by default
  (Settings > Ad & tracker blocker > "Block fingerprinting"), and sites you allow are left alone.
- **Forget a site when you close it**: "Forget this site when I close it" in the shield popover
  deletes that site's cookies, local storage, IndexedDB, caches and service workers once its last
  tab closes. Settings > Ad & tracker blocker lists these sites.

### Passwords
- **Password checkup**: corvus://passwords checks your saved passwords (and unlocked KeePass
  databases) for ones that appear in known data breaches, that you reuse or that are easy to
  guess, and marks each login "In N breaches", "Reused" or "Weak". The breach check runs when you
  ask and uses k-anonymity: only the first 5 characters of each password's SHA-1 hash are sent to
  Have I Been Pwned, and the match happens on your device.

### Performance
- **No more freeze when the ad blocker updates**: its filter lists are now parsed in a separate
  process, so the weekly update no longer stalls tabs and typing for a moment.

## v0.6.0

### Browser
- **Hide anything on a page**: right-click > "Hide this element…" (or "Hide an element…" in the
  shield popover) and pick it: a click chooses it, "Wider" or Up takes the element around it,
  Enter hides it. It stays hidden on that site, as a rule in your own filter list.
- **Your own filters**: Settings > Ad & tracker blocker > "My filters" lists your rules in
  uBlock Origin syntax, including every element you hid; edit them or add your own.
- **Sleeping tabs**: a background tab you have not looked at for an hour (Settings > Memory)
  goes to sleep and gives its memory back; it comes back where it was, with its history and what
  you typed in forms, when you return. Pinned tabs, tabs playing sound, tabs an AI agent uses
  and pages where you typed stay awake. "Sleep to save memory" in the tab menu puts one to sleep
  now, and hovering a tab shows the memory it uses.

### Corvus Assist
- **YouTube videos**: on a YouTube video, Summarize and Ask read what is said in it (its
  captions) instead of the page around it, and every point cites the moment it comes from:
  "▶ 1:10" plays the video from there.

## v0.5.0

### Browser
- **Translate pages**: a page written in another language shows a translate button in the
  address bar. One click translates the whole page in place, as you watch, with your AI
  provider; a second click shows the original. Choose the language in Settings > AI ("Translate
  pages into"), or turn the offer off. "Translate this page" in the right-click menu works on any
  page.
- **No more cookie notices**: the blocker hides cookie consent banners, newsletter pop-ups, app
  banners and similar clutter with the EasyList Cookie and uBlock Origin annoyances lists.
  Settings > Ad & tracker blocker > "Hide cookie notices and annoyances" (on by default).
- **Links without tracking**: pages open without their tracking parameters (utm_*, fbclid,
  gclid, msclkid and similar); the rest of the address stays exactly as it was. Settings > Ad &
  tracker blocker > "Remove tracking from links" (on by default).
- **The portable build updates itself**: from this version on, Corvus-Portable checks for
  updates like the installed app, downloads the next portable copy next to itself, verifies it
  against the release checksums and replaces itself when you restart. Coming from 0.4.2 or
  earlier, download this portable copy by hand once.

## v0.4.2

### Browser
- **YouTube keeps playing**: when signed in, YouTube can refuse to play a video whose ads were
  removed, restarting it over and over ("Experiencing interruptions?"). Corvus now notices that
  loop within seconds and switches YouTube to skipping its ads instead: they load, play muted at
  top speed, jump to their end and are skipped, and the video plays. It stays that way for a day,
  then the lists get another try. The shield popover tells you when this is on.
- Ads that still reach the YouTube player in normal mode are skipped the same way.
- "Add tab to new group" keeps the caret in the group's name.

## v0.4.1

### Browser
- **YouTube without ads**: the ad blocker now uses the lists uBlock Origin uses (its own filters
  and quick fixes, EasyList, EasyPrivacy and more), and runs their page scripts before the page's
  own, so YouTube videos start without video ads and the side ads are gone. Stand-ins for blocked
  scripts load as intended instead of failing, so video players keep working.
- **Bookmark by dragging the lock**: drag the site icon at the left of the address bar onto the
  bookmarks bar to bookmark the page with the tab's title, right where you drop it. Links dragged
  from a page onto the bar are bookmarked too.
- **Name a new group right away**: "Add tab to new group" opens the group's name editor at once.
- A click anywhere outside an open popover (also on the toolbar or the tabs) closes it, and the
  password panel of the address bar no longer opens behind the page.
- Tabs keep their site's icon while you browse within the site, and fall back to the site's
  `/favicon.ico` when the page's icon fails to load.
- The NASA background now comes from NASA's Image of the Day (the APOD service stopped working).

## v0.4.0

### Browser
- **The New Tab page is now a dashboard you can arrange**: press **Customize** to drag widgets,
  resize them from the corner, open their settings or remove them, add new ones from a gallery,
  undo, or go back to the original page. Out of the box it looks like before (greeting, search,
  shortcuts), so nothing changes until you customize.
- **Shortcuts you control**: add a shortcut by hand, edit its name and address, remove it (or hide
  one of your most visited sites), and drag tiles to reorder them.
- **Backgrounds**: the default grey, a color (swatches or any color), a picture of your own (kept
  on the device) or a daily picture from Bing, Wikimedia Commons, NASA or Lorem Picsum, with
  darken and blur. Text on the background stays readable.
- **Built-in widgets**: greeting, search box, shortcuts, a digital or analog clock with other time
  zones, and notes that save as you type.
- **Custom widgets for anything**: a custom widget draws its own HTML, CSS and JavaScript and reads
  the data sources you give it: any public address (JSON or text), an RSS or Atom feed, a site you
  are signed in to (its unread count and the text of a part of the page, only after you allow
  that site for that widget), or Corvus's own watched pages and most visited sites. The gallery
  starts you off with crypto prices, stock quotes, weather, a news feed, watched pages and unread
  counts; edit their sources and code, or write one from scratch.
- **Widgets run isolated**: no network, cookies, storage or access to the page; they only get the
  data Corvus reads for them, links open only on the hosts they declared, and widgets holding
  private data cannot load images from the web.

### For AI agents
- **Build the New Tab page over MCP**: `newtab_layout`, `newtab_add_widget`,
  `newtab_custom_widget`, `newtab_update_widget`, `newtab_remove_widget`, `newtab_set_background`
  and `newtab_undo`. Ask an agent for the dashboard you want and it builds it in Corvus's look; the
  page updates live, every change can be undone, and an agent can never allow a widget to read a
  site with your session: you do that on the page.
- **The Command Bar agent and Assist build widgets too**: ask them "add a widget with ..." and they
  use the same New Tab tools, no tab needed.

## v0.3.4

### For AI agents
- **Choose the Claude Code account Corvus uses**: with the Claude Code CLI provider, Settings >
  AI search > Claude Code account runs the CLI with your default login, a config folder of your
  choice (`CLAUDE_CONFIG_DIR`), or the account of the Claude Code session that drives Corvus over
  MCP. The connector reports that session's config folder when it connects, so tools that keep
  several accounts in separate folders work without extra setup, and a switch of account is
  picked up when the session reconnects. Only approved local clients, and only folders that exist.
- **Environment variables for the Claude Code CLI**: an optional list of `NAME=value` lines added
  to the CLI process (proxy, base URL and so on). Kept on the device, never synced.

### Browser
- **Command bar and address bar suggestions keep your selection**: a list that opened under a
  resting mouse pointer selected the row under it, so Enter could run another command or open a
  suggestion instead of what you typed. Hover now selects only when the pointer moves.

## v0.3.3

### For AI agents
- **Agents start Corvus when they need it**: the Claude Code plugin and the MCP connector use
  Corvus if it is running, and otherwise start it in a normal, visible window with its MCP server
  on (`--enable-mcp`, which also turns the server on in a Corvus that is already open). The first
  connection still asks you to approve the client. Corvus records where it runs from in
  `~/.corvus/app.json`, so the portable build and AppImage are found too; `CORVUS_BIN` overrides
  it and `CORVUS_MCP_NO_LAUNCH=1` turns starting off.
- **MCP connections survive a browser restart**: after Corvus restarted or dropped the session,
  every call failed with "Session not found" until the client reconnected by hand. The connector
  now finds Corvus again, opens a new session and retries the call.
- **Claude Code CLI provider on Windows**: a `.cmd` wrapper (npm's `claude.cmd`, or an account
  switcher such as `ccm`) set as the CLI path failed with "Claude Code CLI not found". Corvus now
  looks the command up on PATH like a terminal and runs batch wrappers through cmd.exe.

### Browser
- **Home button**: a house next to reload (Alt+Home, Ctrl+click or middle-click for a new tab)
  goes to Corvus's New Tab page with Corvus search, or to Google, Bing, DuckDuckGo, Yahoo, Ecosia,
  Brave Search, Startpage or an address of your own (Settings > Appearance > Home page).
- **Settings in English or Spanish**: Settings > Appearance > Language (System, English,
  Español) switches the settings page and the menu of Corvus pages at once; System follows the
  operating system language. Other Corvus pages stay in English for now.
- **Signing in to Google works**: Google refused the sign-in ("This browser or app may not be
  secure"). Corvus now tells Google's sign-in page that it is an Electron browser, which gets the
  sign-in flow for embedded browsers; every other site still sees a regular Chrome user agent.
- **No more security-key prompts out of nowhere**: on Windows, sites that try a passkey (Google
  does at every sign-in) opened the system "use your security key" dialog. Passkeys and security
  keys are now off by default; turn them on in Settings > Passwords > Passkeys and security keys.
- **Search results are easier to read**: a cleaner layout with an AI relevance ring per result,
  high-contrast titles, the AI summary set apart from the page snippet, snippets cut at three
  lines, cited sources as cards under the answer, and no empty rating column when the AI answer
  is off or fails.
- **Settings side menu**: its links no longer squeeze together in short windows, its scrollbar
  only shows on hover, and jumping to a section lands it below the search box instead of under it.

## v0.3.2

### For AI agents
- **The side panel assistant now acts, not just reads**: ask it to do something ("open my issues
  and summarize the ones assigned to me", "fill this form with…", "go to the next page and
  compare") and it works in your current tab: it navigates, clicks, types, scrolls, opens tabs and
  searches the web, then answers in the same chat. Each step shows as one line in the panel,
  approvals (Approve / Skip / Stop) appear inline, and follow-ups like "now do the same for the
  next one" work because the conversation carries the steps taken. Plain questions about the page
  still answer directly. Runs appear on `corvus://agent-runs` labelled Assist.
- **Visual browsing**: screenshots now reach the model as images (Claude Code CLI, Anthropic API,
  and local models that report vision), and agents can click, hover, scroll, press keys and type by
  position for canvas apps, maps and custom widgets. Position-based actions check what is under the
  point first, so "Buy now" and payment buttons still always ask.
- **Claude Code CLI provider**: Corvus's own instructions (site profiles, Assist rules, saved
  logins, workflows) now reach the CLI; before, they were dropped.
- **MCP: `console_messages` and `network_requests` work**: they failed with "not supported by
  this browser build". Corvus now records a tab's console and network requests from the first
  time an agent acts in it (status, type, size, timing, failures and blocked requests). Anything
  sent with, or right after, a saved password or 2FA code Corvus filled is hidden from the log.
- **MCP clients only see tools Corvus can run**: tools that this build does not implement yet
  (`find`, `wait_for`, `get_text`, `click_at` and others) are no longer offered, so agents stop
  calling tools that always fail.

### Browser
- **New tab puts the caret in the address bar**, for Ctrl+T, the + button, the Command Bar and a
  new window's first tab, so you can type right away.
- **Dark theme no longer darkens pages without a background** (for example boe.es): web pages are
  painted on a white base like in Chrome; only Corvus pages follow the theme.
- **Simpler workspaces**: clicking a workspace opens it as one tab group in the current window
  (or focuses that group if it is already open). Replace, Merge and open-in-new-window are gone.
  Right-click a group to "Save group as workspace" or "Update workspace"; the save button says how
  many tabs it saves, and delete asks first.
- **WebScope**: turning it off while tabs are still loading no longer fills the crash log with
  "target closed while handling command" errors.

## v0.3.1

### For AI agents
- **Spending money always asks, even in auto mode and for MCP clients**: a click on "Buy now",
  "Place order", "Pay" and the like (also in Spanish, Estonian and other common languages), or
  Enter in a checkout or payment form, now asks you every time, whatever "Ask before risky
  actions" says. Scheduled agents stop at that step until you answer, and saved workflows ask
  too. MCP clients get an "Allow once / Deny" dialog at every access level (click, type with
  submit, fill_fields and run_flow steps); Deny tells the agent you declined. Adding to a cart, a
  "Books" link or "Order history" do not ask. Settings now says exactly what auto mode does.

## v0.3.0

### Before you update
- **Update every device.** Saved logins can now carry a 2FA secret. If you edit a synced login on a
  device still running Corvus 0.2.0, that device saves the login without its 2FA secret and sync
  removes the secret everywhere. Update all your devices before you add 2FA secrets, and avoid
  editing logins on 0.2.0 in the meantime.
- **Self-hosted sync server**: update it as well to sync workflows and site memory. A 0.2.0 server
  does not know them yet: Corvus then keeps them on each device and everything else keeps syncing.
  Devices still on 0.2.0 simply ignore them, and pick them up when they update.

### Browser
- **Reusable workflows**: save a finished agent run as a workflow (from `corvus://agent-runs`, the
  Command Bar run panel, or when you tell the agent the task is repetitive), review it, turn typed
  values into `{{parameters}}`, and run it again by hand or let the agent use it. Nothing is saved
  without your review. The side panel's new Workflows view lists the workflows for the current
  site; `corvus://flows` is now the full manager, with origin and site filters and a "Needs
  attention" view for workflows whose steps stopped matching the page.
- **Site memory**: after each successful agent run, Corvus keeps a few compact hints per site
  (elements that worked, URL shapes with values removed, obstacles such as cookie banners, the
  usual order of steps). It learns only from steps that worked, never from page text, and never
  keeps typed values or secrets; about 2 KB per site. New tasks on that site start with the top
  hints, so the agent needs fewer steps on sites it has seen. See, edit and forget them in the
  panel's Learned view or on `corvus://flows`. On by default, with a switch in Settings.
- **Workflows and site memory sync**: saved workflows (recorded or saved from agent runs) and what
  Corvus learned about sites now sync end to end across your devices, each as its own category in
  Settings > Sync (on by default, per device; turning one off keeps that device's data). Edits
  follow the last change, run counts and learned hints add up across devices without counting
  anything twice, and deleting a workflow, "Forget this hint", "Forget this site" and "Forget
  everything" apply on every device, even one that comes back online with old data. Site memory
  never carries typed values, passwords, codes or credential fields; whether a device learns stays
  its own switch.
- **2FA codes**: add a time-based (TOTP) 2FA secret to a saved login by pasting an `otpauth://`
  link, importing a QR code image (decoded on your device) or typing the base32 secret. The
  secret is stored in the end-to-end encrypted vault and synced. `corvus://passwords` shows the
  live code with a countdown and a copy button, and warns that keeping the 2FA secret next to the
  password turns two factors into one. On a one-time-code field the key button offers the code.
- **KeePass, read-only**: add `.kdbx` files (KDBX 3.1 and 4) or a folder of them, with an
  optional key file. Unlock once, or keep a database unlocked with the master password wrapped by
  your system keychain. Databases auto-lock after the idle time in Settings > Passwords and when
  the screen locks, and are re-read when the file changes. Corvus never writes to them. Their
  logins and 2FA codes show up in autofill and on `corvus://passwords`.
- **Export to KeePass**: write your saved logins and their 2FA secrets to a new `.kdbx` file
  protected by a master password you choose. Existing files are never overwritten.
- **Auto sign-in** (opt-in per login): when the login page loads, Corvus asks once, then fills and
  submits the form. Never in tabs an agent is driving.
- **WebScope redesign**: grouped tool tabs, the scope always visible, history with filters (host,
  method, status, type, source), sortable columns and resizable request/response panes (Pretty,
  Raw, Headers, Hex), Repeater tabs, a clearer Fuzzer with a request preview and CSV export, and
  findings grouped by severity with repeats merged. Fixed: the Fuzzer's extract regex is now sent,
  and the intercept editor follows the selected item.
- **Fixed**: site favicons disappeared from the tab strip after a restart, or stayed hidden after a
  page's first icon failed to load.

### For AI agents
- **Workflows for agents**: `list_workflows`, `read_workflow` and `run_workflow` in the Command
  Bar agent. The workflows for the current site are given to the agent as data at the start of a
  task, so it can run one instead of planning from scratch. Every step still goes through the
  approval gate; if a step no longer matches, the agent continues on its own and reports which
  step broke. MCP `run_flow` can now read a workflow, filter by host and pass parameters.
- **Site memory for agents**: `read_site_memory` in the Command Bar agent, and the read-only MCP
  tool `site_memory` (Standard level).
- **`fill_login` and `fill_totp`**: the Command Bar agent and Full-access MCP clients can sign in
  and fill 2FA codes, but only when Settings > Passwords > "Let AI agents use logins you opt in" is
  on and the login itself is opted in (both off by default), and only after you approve each use.
  Corvus fills the value by reference: the password and the code never reach the model, tool
  results, transcripts, run history or logs. Without the opt-ins, 2FA is handed to you as before.
  CAPTCHAs are always handed to you.
- Agent page snapshots never include the value of password fields, one-time-code fields or fields
  Corvus filled with a secret, and fields filled for an agent are masked on screen.
- **Script lock after a fill**: once Corvus fills a saved password or 2FA code into a tab (agent
  sign-in, autofill or auto sign-in), agents cannot run scripts there or read raw page content
  (`evaluate`, `get_html`, `get_text`, `extract`, `find`, `pdf`, `run_workflow`) until the tab
  loads a new page. This applies to every agent at every access level; clicking, typing and the
  masked page snapshot keep working.
- **WebScope hides credential traffic from AI**: requests sent from a tab right after Corvus filled
  a saved password or 2FA code, and requests that carry such a value, are marked "Hidden from AI".
  You still see them in full in WebScope, with a badge. AI agents and MCP clients get them with the
  request body and the URL query values removed, in history and search, request detail, findings,
  the sitemap and the intercept queue.

### Project
- **Third-party notices**: the build writes `THIRD_PARTY_NOTICES.md` with the name, version,
  licence and licence text of every third-party package in the app, ships it next to the app and
  links it from Settings > Updates > Third-party software. The build fails on a licence outside
  MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, MPL-2.0, 0BSD, Unlicense, Python-2.0 or
  BlueOak-1.0.0, and on any change to the accepted copyleft package below.
- **Licence of the binaries**: the Corvus source stays MPL-2.0. The installers and the packaged app
  include electron-chrome-extensions, which Corvus uses under GPL-3.0, so as a combined work they
  are distributed under GPL-3.0. The complete corresponding source is
  https://github.com/ParendumOU/Corvus. The notices file and the README say so.

## v0.2.0

The first open-source release of Corvus (MPL-2.0). Installers and automatic updates now come from
GitHub Releases of ParendumOU/Corvus.

### Browser
- **Split view**: tile two live tabs side by side, with a draggable divider and focus routing.
- **PDF viewer with AI**: an in-app pdf.js viewer with the reading AI suite and page citations.
- **Password manager**: an end-to-end-encrypted vault (same crypto as sync) with autofill,
  `corvus://passwords`, synced across your devices.
- **Annotations**: in-page highlights and notes (CSS Custom Highlight API), anchored by text quote
  and synced end to end.
- **Semantic search**: BM25 plus optional local embeddings over history, bookmarks and reading
  notes, at `corvus://find`.
- **Crash recovery**: a per-tab recovery page, restore after an unclean exit, and an opt-in local
  crash log.
- **Device sync and management**: reading notes, watches and workspaces now sync end to end; list
  and revoke devices at `corvus://devices`.
- **Settings search**: filter the settings and jump straight to the matching control.
- **Onboarding**: a first-run wizard for the AI provider, sync phrase, bookmark import and
  preferences.
- **Auto-update**: from GitHub Releases by default, or from a self-hosted feed set in
  Settings > Updates. A downgrade is only offered when a pre-release build switches back to Stable.

### AI
- **Local models**: Ollama and any OpenAI-compatible server, no API key needed. AI search, Assist
  and the reader work offline.
- **Persistent agent runs**: runs are saved and can resume mid-loop, with a history at
  `corvus://agent-runs`. Step previews now say which page the agent opened or read.
- **Scheduled agents**: cron or interval AI runs on the watches scheduler, with an
  unattended-approval gate.
- **Per-site AI profiles**: a per-domain prompt addendum and a narrower access cap for the agent
  on that site.
- **Recorded flows**: record a browser flow and replay it as an approval-gated macro at
  `corvus://flows`.

### For AI agents (MCP)
- **Remote MCP over Streamable HTTP**: bind to 127.0.0.1 or 0.0.0.0 with mandatory bearer auth;
  off by default.
- **Snapshot tool**: a read-only page artifact (screenshot, DOM outline and network).
- **Automation tools** at the Full access level, each approval-gated: `run_flow` (replay a saved
  recorded flow), cookies, `fill_fields` and `download`.
- **Corvus-MCP**: the connector now has its own MIT repo,
  [ParendumOU/Corvus-MCP](https://github.com/ParendumOU/Corvus-MCP), with setup for Claude Code,
  Claude Desktop, Cursor, VS Code, Zed, Cline, Codex CLI, Gemini CLI and any stdio client. The
  bundled bridge now ships the license notices of its dependencies.

### Project
- Source published under MPL-2.0, with `SECURITY.md` and `CONTRIBUTING.md`.
- Windows and Linux only. The installers are not code-signed yet, so Windows SmartScreen shows a
  warning on first run. macOS builds will follow.

## v0.1.1

- **Command bar (Ctrl/Cmd+K)**: a fast action palette (open tabs, history, bookmarks, settings,
  web search, internal pages) and an in-browser AI agent — type a task and Claude carries it out
  in a tab using the browser tools, with the live activity overlay, a step log, pause, and an
  approval prompt before risky actions (forms, logins, payments). Provider-agnostic agent loop
  (Anthropic API or local Claude Code), with step and token caps.
- **Reader mode + AI reading suite**: distraction-free reader (fonts, width, light/sepia/dark),
  Key points / TL;DR / Simplify / ELI5 / Translate with section citations, read-aloud, and a
  save-as-note library (corvus://reading) with Markdown export.
- **Vertical tabs, workspaces and page monitoring**: an Arc-style tab sidebar, named workspaces,
  and "Watch this page" with AI-summarised change alerts (corvus://watches).

## v0.1.0 — first preview

The first end-to-end build of Corvus, an AI-native browser that is also an MCP server.

### Browser
- Tabs and tab groups, profiles (isolated sessions), bookmarks with folders, history.
- Site permission prompts, downloads manager, find-in-page, per-site zoom, session restore.
- Chrome extensions (install from the Chrome Web Store) plus bookmarks/history/tabGroups/
  sessions/side-panel extension APIs.
- Built-in ad and tracker blocker with an address-bar shield (per-site and global toggles).
- End-to-end-encrypted sync (24-word recovery phrase) for bookmarks, history, settings,
  profiles, open tabs and extension suggestions, to a self-hostable server.

### AI
- AI search: a retriever (SearXNG/Brave/DuckDuckGo) plus one small-model call that returns a
  structured, cited answer with per-result AI ratings and summaries; News/Images/Videos tabs.
- Corvus Assist side panel: summarize page, ask about page, translate.
- AI tab organizer and a live agent-activity overlay.

### For AI agents (MCP)
- Local MCP server with a full browser toolset (visual + semantic control, forms, extract,
  dialogs, screenshots), three access levels (read-only / standard / full), and human handoff
  for CAPTCHAs/2FA (never solved automatically).
- Claude Code plugin with zero-config discovery.
- WebScope: a scope-gated, Burp-style web-traffic workbench, also exposed to agents.

### Build
- Fully Dockerized dev and release builds; Windows .exe (NSIS installer + portable) and Linux
  (AppImage + deb). GitLab CI runs tests and the headless smoke test on every push.
