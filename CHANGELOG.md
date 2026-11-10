# Changelog

## Unreleased

## v0.47.1

### Fixed
- **Links from other apps open even when Corvus was started as administrator.** On Windows, a Corvus started from an elevated terminal or by an agent running elevated never received links from normal apps (a sign-in page from a mail app, a link in a document): Windows dropped the hand-off and nothing opened. Corvus now notices it is running as administrator and starts itself again as the normal user, with the same links and settings; the portable build starts through its own launcher again, so it keeps its taskbar icon and updates. `CORVUS_ALLOW_ELEVATED=1`, or a launch that picks its profile with `CORVUS_USER_DATA` / `CORVUS_HOME` (which a relaunch as the normal user would lose), keeps it elevated.
- **A long link copied from a terminal opens from the address bar.** A terminal wraps a long URL onto several indented lines, so pasting it gave the address bar spaces in the middle and it searched for the text instead of opening the page. Pasting now drops the line breaks and the spaces around them, as Chrome does.

## v0.47.0

### Added
- **Agents ask for what they need in a bar made for it.** The bar above the page shows the whole request instead of cutting it at one line, and an agent can add long text, numbered steps, values with a Copy button and form fields, and name its own buttons. Long requests scroll inside the bar. The agent gets back the button pressed and what was filled in.
- **Agents can upload files to a form.** They now find the file fields sites hide behind a button, and when a click opens a file chooser they answer it themselves, without a system window opening in front of you. The Command Bar agent can do it too. Corvus shows which files go to which site and asks you first, unless you let agents sign in on their own.
- **Copy invite link.** The app menu copies a link to the Corvus download site, in the language Corvus is in, to send to someone who wants to install it.

## v0.46.0

### Passwords
- **Saved logins and 2FA codes in sign-in forms inside iframes.** A click in a login or 2FA field of an embedded frame, nested frames included, offers the logins saved for that frame's own site, never the page's, and a pick fills that frame alone. When the frame belongs to another site than the page, the menu says "This form is on" that site, since the address bar shows the page's. Nothing is offered or filled in a frame that is hidden, transparent, tiny, off screen or sandboxed, and a password or code never reaches a frame that went to another page, became hidden or lost the keyboard after the click.
- **Cards and addresses in forms built as web components** are offered and filled too, like logins already were.

## v0.45.0

### AI agents
- **Pages can ask with prompt().** A page's `prompt()` threw "prompt() is not supported." in every tab, so a page action that asks for a name or a reason silently did nothing. It now opens Corvus's dialog, like `alert()` and `confirm()`, and agents answer it with `handle_dialog` and `promptText` (accepting without text gives the page's default text).
- **Agents see the state of switches and toggles.** `page_snapshot` and `find` show switches as `="checked"`/`="unchecked"`, like checkboxes, and buttons with `[pressed]`/`[not-pressed]`, `[expanded]`/`[collapsed]`, `[selected]` or `[current]`. Before, an agent could not tell whether a switch such as "Force HTTPS" was on, and turned it off by mistake.
- **`find` matches what page_snapshot names an element.** Finding a switch by role and label found nothing when the label sat outside it (`label for=`), as in most UI libraries: `find` compared only the element's own text, and a switch's own value is "on".
- **Element screenshots in side drawers.** `screenshot` with `mode: "element"` now brings the element into view inside every scroll container it sits in, moving each as little as needed, and measures it again once the scroll has painted. It also takes a CSS `selector` instead of a ref.
- **Fewer tokens for agents.** `page_snapshot` takes `within` (an element ref or a CSS selector, such as the open dialog or drawer) to read only that container, and `changes: true` to return only what changed since the agent's last snapshot of the tab: new text lines, new or changed elements, and the refs that are gone.
- **`wait_for` an element's text to change.** `textChanged` with a `ref` or `selector` waits until the element's text differs from the text the agent last saw (or, with `true`, from its text when the wait began), for a status that updates after a submit.

### Fixed
- **Saved logins and 2FA codes are offered in sign-in forms built as web components.** A click in a field inside a component reached Corvus as a click on the component itself, so no login was offered there, and a fill could not find the fields either. Now the menu opens under the field and a pick fills the username, password and 2FA code inside the component.
- **More 2FA code fields are recognized**: fields named in one word, such as `mfaCode`, `otp_code` or `otpInput`, and code-sized fields next to text asking for "the 6-digit code".
- **A new window keeps the keyboard in the address bar.** On a busy computer the window could finish opening late and hand the keyboard to the new tab page, so what you typed went into the page. The address bar now takes it back, unless you clicked or typed in the page.

## v0.44.0

### Address bar
- **Inline autocomplete, like Chrome and Brave.** Typing the start of a site's address fills in the rest in the field, selected: "edge" shows "edge" plus a selected ".example.com", and Enter opens it. That site becomes the first, preselected suggestion, above the AI search. Until you type a "/", it completes to the site's root, even when you only visited deeper pages. After a "/" it completes a whole address. The site or page is picked by frecency: visits weighed by how recent they are, with addresses you typed in the address bar counting more. Only sites you typed, bookmarked or went back to are filled in, never one seen once through a link. Typing on keeps the completion and Backspace removes it without filling it in again. Nothing is filled in while you paste, compose with an IME or edit before the end of the text.

## v0.43.0

### Profiles
- **Alt+L locks a profile, like Win+L locks the computer** (⌃⌘L on macOS, where Option+L types a character, such as @ on German keyboards). Alt+H no longer locks: pages get it back.
- **Lock a profile when the computer locks**: a new option in Settings > Lock, off by default, for profiles with a PIN or password. Win+L, ⌃⌘Q or the screen locking by itself locks the profile too, and when you come back the lock screen is what shows, never a glimpse of your pages. Profiles without the option stay as they are. On Linux it works with desktops that report the lock to logind or the freedesktop screen saver (GNOME, KDE and others).

### Corvus for mobile 0.12.2
- **Unpairing the phone is instant, even when its sync server cannot be reached.** The phone waited for the server to take it off the chain before forgetting the chain, up to 30 seconds when the computer that runs the server was off or its firewall dropped the connection. It now forgets the chain at once and tells the server in the background; when the server never hears of it, a computer can remove the phone from its device list as before.

## v0.42.0

### Ad blocker
- **Videos embedded from YouTube lose their ads too, and page elements are hidden inside frames.** The scriptlets that keep YouTube ad-free and the element hiding only ran in the page itself, never in its frames, so a YouTube video embedded in another site played its ads. Every frame now gets them, with the rules meant only for frames inside certain sites.
- **A warning when the filter lists stop updating.** The lists change every day; after a week without a new one, Settings and the shield say so, since the rules in use keep aging in silence (the source gone, a network that blocks it). Corvus keeps trying.

### Fixed
- **No more "No handler registered for corvus:dnr-default-rulesets" errors.** The extension preloads also ran in websites' own service workers, which asked for extension rulesets no one served; they now stay out of them, and those workers no longer see Corvus's extension API bridge.

### Corvus for mobile 0.12.1
- **Fresh filter lists on the phone.** It downloaded a copy of the lists that had not moved since August; it now asks the daily source the desktop uses once a day and downloads the lists that moved, and says when they stop updating.

## v0.41.0

### Profiles
- **Lock a profile with Alt+H when you step away** (Option+H on macOS, or Lock profile in the Corvus menu and the profile menu). Its windows show only a lock screen: a blurred stand-in, nothing of your pages, and a form to unlock it. Locked, nobody can open its pages, Settings, passwords, history or bookmarks, sign in with its saved logins or 2FA codes, or let an AI agent use it; you can still close the browser, switch to another profile or create a new one. Unlocking brings the windows and tabs back as they were.
- **A lock is optional, per profile**: none, a PIN of at least 6 digits or a password, chosen when you create the profile or later in Settings > Lock. A profile with a lock starts locked when Corvus starts. Wrong attempts make you wait a little longer each time.
- **Real encryption**: with a lock, the keys of the profile's saved passwords, 2FA codes, cards, addresses, kept KeePass passwords, proxy passwords and sync phrase are sealed under a key only your PIN or password opens, on top of Windows' own protection. Adding or removing the lock never loses data: files are copied aside and checked before the old ones go.
- **More ways to unlock**: a code from an authenticator app (set up with a QR code, separate from your 2FA codes), Windows Hello and a USB security key. Windows Hello and keys that support it (PRF) open the encryption themselves; Settings tells you when one only guards the key.

## v0.40.1

### Fixed
- **YouTube: fewer ads, and videos no longer jump, restart or stop halfway.** The filter lists came from a copy that had not moved since August and lacked uBlock Origin's 2025 and 2026 lists, so YouTube's rules were three months old. They now come from a source updated every day: Corvus checks every 6 hours and rebuilds only when a list moved (it used to check weekly). Rules meant for other browsers no longer run alongside the ones for Chromium, and filters CSS cannot express (`:has-text`, `:upward`...) now work.
- **A page opened before the lists arrive is filtered too.** YouTube changes page without loading a new document, so a tab opened in the first seconds after the first run or an update stayed unfiltered for as long as it lived. New lists now reach open pages at once, and a YouTube page that started with next to no rules loads again.
- **An ad that still reaches the player is not heard or seen at high speed.** The ad skipper reacts the moment the ad starts and keeps it muted and hidden.

## v0.40.0

### Search
- **A new results viewer: the sources on the left, the conversation on the right.** The left column lists the results in compact rows of one fixed size: number, site, title, a two-line snippet and a line where the AI notes what each source is and how it is tagged. A bar at the left edge of each row shows the AI reading the sources while it works, then how relevant each one is. The right column is a conversation: your question, what the AI is doing (searching, reading the sources, rating them, with the sites it reads), then the answer, its key points, how well the sources back it, facts about what you asked for, and questions to ask next. Pointing at a citation lights up its source on the left, and pointing at a source lights up where the answer cites it. Each column scrolls on its own and nothing in either moves while the rest arrives.
- **Ask a follow-up in the same page.** A box under the conversation, and the suggested questions, ask the next question in the context of the earlier ones; the left column shows the sources of the question you pick.
- **The answer appears as it is written, a whole sentence at a time**, never half a sentence, so the first sentences are there seconds before the rest.
- In a narrow window, **Answer** and **Sources** under the search box switch between the two columns.

### Fixed
- **Search answers in about half the time, and results never wait for it.** Each result shows its title, site and snippet as soon as the search engine answers, instead of after the AI. The AI reply is written by two calls side by side, the answer and the result ratings, so each is done in about half the time, and each part shows as soon as it is complete. With the CLI provider, its start-up overlaps the web search, a call ends as soon as the reply does, and Corvus no longer runs into the CLI's output cap, which made it send the whole request a second time. Measured on Windows with the CLI provider and the default model (8 searches): snippets in 2.1 s instead of 14 s, the complete answer in 5.9 s instead of 14 s (up to 23 s before), with a third fewer tokens.
- **The results page no longer jumps as it opens.** In about half the searches the result placeholders were drawn before the page knew an answer comes above them, and then pushed down by it.
- **AI answers through the API provider keep every rating.** The "Answer length" setting (400 tokens) capped the whole reply, so the ratings of the last results and the follow-up questions were cut off; it now caps the answer only.
- **Image results stay photos.** A moment after the images appeared, each one turned into its site's icon stretched over the whole tile; the icon now stays small in the caption.
- **News and videos open on what you searched for.** Old Wikinews articles and Wikimedia Commons clips, unrelated to the search, often came first; they now come after the other sources' results.
- **Searches keep working when search engines block the computer.** The bundled SearXNG asked only Google, Brave and DuckDuckGo, and a computer that searches a lot soon gets rate-limited by them, leaving searches with no results; it now also asks Bing and Yahoo, leaves out DuckDuckGo and Mojeek, which do not answer at all from some networks, and an engine that does not answer holds a search for 2 seconds at most instead of 3.

### Security
- **The Docker SearXNG and sync server listen on this computer only.** `docker compose up` published them on every network interface of the computer; they now bind to 127.0.0.1. Phones sync with the server built into the desktop app, which is unchanged.

## v0.39.1

### Fixed
- **Ctrl+U shows the page's source.** Pressing Ctrl+U (Cmd+Option+U on macOS) on a web page did nothing; now, as in Chrome, the page's source opens in a new tab right next to it, and **View page source** is in the page's right-click menu and in the Corvus menu. A page that uses the key itself, like an editor's Ctrl+U for underline, keeps it. A source tab shows its view-source: address in the address bar and on the tab. Corvus's own pages have no source view, and AI agents can neither open nor read one.
- **Search results stay still while the AI answer loads.** A search now shows each result's title and site first, and the AI answer, the AI summaries, the snippets and the side panel appear only once the AI has finished, all at once and complete, never half written. Their space is kept from the start: the answer has a box of fixed size (a longer answer opens with **Show more**) and each result keeps a slot for its description, so nothing you are reading or about to click moves while they arrive.
- **Results keep the order they appeared in.** The AI order no longer reshuffles results you can already see; **Sort: AI relevance** applies it when you choose. A search Corvus answers from its cache, which loads at once, still opens in the order you chose last.

## v0.39.0

### PDFs
- **A link to a PDF opens it in a new tab.** Click a link to a PDF on a page and Corvus's PDF viewer opens next to it, in a tab of its own, instead of replacing the page you were on. Its **Download** button saves the file when you want to keep it. A tab opened just for the PDF, an address you type and AI agents' tabs still show it in the same tab.
- **See a PDF before you download it.** Turn on Settings → PDF viewer → **Preview PDFs before downloading** and the PDFs a page sends to be saved (a webmail's or a shop's Download button) open in the viewer in a new tab too, from the very download, so nothing lands in your downloads until you press Download. Off by default.

### Fixed
- **Clicking a tab no longer closes it when many tabs are open.** Once tabs got narrow, the close button of a tab in the background, hidden but still there, covered most of it, so clicking the tab to switch to it closed it instead; and the active tab's close button spilled over the tab to its right, so clicking that one closed the active tab. As in Chrome, a narrow tab in the background has no close button now, and the narrow active tab shows only its close button, sized to fit in it.

## v0.38.1

### Fixed
- **The portable Corvus keeps its taskbar icon after an update.** For its notifications, Electron (what Corvus is built on) puts a Corvus shortcut in the Start menu that leads to the folder the portable build runs from, and Windows takes the taskbar icon of Corvus's windows from it. Once a newer build ran, that folder was gone and the icon turned blank again. The portable Corvus now removes that shortcut when it quits, and at start removes one that leads nowhere, before its windows show, so it leaves no Start menu entry behind either. It also keeps one notification ID across starts instead of adding a registry key each time.

## v0.38.0

### Keep running in the notification area
- **Close Corvus and it keeps working for your AI agents.** Turn on Settings → Startup and closing → **Keep running in the notification area** (Windows and Linux) and closing the last window with its X leaves Corvus running next to the clock, with your tabs, instead of quitting. AI agents connected over MCP keep browsing for you in their own tabs meanwhile, out of sight.
- **Its icon brings Corvus back.** Click the Corvus icon in the notification area, or start Corvus again, and the window comes back as you left it. Right-click it for **Open Corvus** and **Quit Corvus**, which quits for real.
- **It tells you when something needs you.** If an agent asks you to do something, or a purchase needs your approval, while the window is out of sight, Corvus goes back to the taskbar, its button flashes and a notification says what it needs (below).
- Private windows still close for good (their pages and data go), and closing the last tab of the last window leaves Corvus running with no window until you open it from the icon. Off by default.
- With no window open at all, an agent's tab opens in a new window in the background, minimized, without taking the screen.

### Notifications when an AI agent needs you
- **A system notification when an agent waits on you.** When an AI agent asks you to do something in a tab ("Sign in to example.com", "Approve the sign-in on your phone") or needs your approval (spend money, use a saved login or 2FA code) while you are in another app or Corvus is in the notification area, a Windows, macOS or Linux notification says so in one line.
- **Answer from the notification.** Its buttons answer right there: **Done** or **Cancel** for a request, **Allow once** or **Deny** for an approval (Windows and macOS), and the agent goes on without you opening Corvus. Click the notification to open Corvus on that tab instead. It goes away once you answer, in Corvus or in it.
- Letting a new AI client control Corvus is still decided in Corvus: its notification only opens the question, with where the client connects from. Questions from web pages never show notifications.
- **Notifications now reach you from the portable Corvus.** Windows silently dropped every notification of the portable build (page watches, sync, finished agent runs): it only shows those of an app it knows. The portable file now registers its name and icon for your Windows user, as the installer's shortcut does.

### Fixed
- **The portable Corvus shows its icon in the taskbar again.** After the portable file was moved, renamed or replaced by a newer version, Windows could keep showing a blank program icon for every Corvus window, even after a restart: it remembered the old file for Corvus's taskbar ID. Each portable file now has a taskbar ID of its own, so its windows always show the Corvus icon. A taskbar pin made with an older portable version starts that file as before; pin Corvus again to pin the current one.

## v0.37.0

### Addresses
- **Corvus fills your address in checkout forms.** Save your name, address, phone and email once, and the next time you click a field of an address form (a shop checkout, a guest order, a delivery form) Corvus lists your saved addresses right under it, like the saved logins under a password field. Pick one and the whole form fills in: name (full, or first name and surname apart), street on one or two lines, postal code, city, province, country (lists too) and phone and email. Fields you already typed in stay as you left them.
- **Offers to save the address you send.** When you send an address form with an address Corvus does not have, it offers to save it; when it matches a saved one with something new (a different phone, a new flat), it offers to update that one. Never in private windows or while an AI agent works in the tab.
- **Several addresses, in Passwords → Addresses.** Home, work, a relative's: add, edit, search and delete them there, each with an optional label. They are stored encrypted and sync end to end with your other devices, like your passwords.
- **Imported from Chrome and other Chromium browsers.** Importing from another browser now also brings its saved addresses, with your passwords and history.
- **Only into fields you can see.** A form's hidden fields (transparent, tiny or placed off the page) are left empty, so a page cannot collect your phone or email without showing where it goes. A different name at the same street is a different address: saving or importing one never replaces the other person's.
- Settings → Passwords → **Save and fill addresses** turns it all off.

### Payment cards
- **Corvus fills your saved cards in payment forms.** Click the card number (or any card field) of a checkout and your saved cards show right under it, as "Visa ...1111 - 08/28". Pick one, type its CVV in Corvus's own prompt, and the number, name on the card, expiry (in the format the form wants) and CVV fill in. Corvus asks for the CVV every time and forgets it right after: it is never saved, synced or imported.
- **Also inside payment providers' frames.** Many shops show the card fields in a frame from their payment provider; Corvus fills those too, only in the frame you clicked and only while it still shows the same site.
- **Offers to save the card you pay with.** When you send a card Corvus does not have, it offers to save it (number, name and expiry, never the CVV); a new expiry or name on a saved card offers an update. Never in private windows or while an AI agent works in the tab.
- **Passwords → Payment methods.** Add, edit, search and delete your cards there. The number shows masked; showing it in full asks first. Cards are stored encrypted and sync end to end with your other devices.
- **Imported from Chrome and other Chromium browsers.** Importing from another browser now also brings the cards saved on that computer (never their CVV or your Google account's cards); the ones the browser locks to itself are counted and named.
- **Safe by design.** Cards are offered and filled only on secure (https) pages and frames, and when the card fields are in a payment provider's frame the CVV prompt names that site. After a card fill, AI agents cannot read that page's fields, as after a password fill, and workflows you record keep card fields out. A card's security code is never offered as a password to save.
- Settings → Passwords → **Save and fill payment methods** turns it all off.

### Phone
- **Fill your saved addresses on the phone too.** Corvus on your phone now gets the addresses you saved on your computers (sealed on the phone like your passwords). On a page with an address form, open the page menu and tap **Fill address** (shown once you have an address saved), pick one, and the empty fields of the form fill in: the form you are typing in, or else the first address form of the page. Fields you already typed in stay as you left them. Addresses are added and changed on a computer; the phone only fills them.
- **And your saved cards.** The page menu also has **Fill card** once a card is saved on a computer. It asks for the phone's lock (fingerprint, face or PIN) first, as your passwords do, and works only on secure (https) pages. Pick a card (shown as "Visa ...1111 - 08/28"), type its CVV in Corvus's own prompt, and the card number, name on the card, expiry and CVV fill in. The CVV is used for that one fill and forgotten right after: never saved, synced or logged. Card forms inside another site's frame (some payment providers) cannot be reached on the phone; type those as before.

## v0.36.9

### Downloads
- **Choose where each file goes, if you like.** Downloads still save straight to your downloads folder, as in Chrome, Edge and Firefox. In Settings → Downloads, **When you download a file** now offers **Save to the downloads folder** (the default), **Ask: Downloads or choose where** and **Always choose where to save** (the old "Ask where to save each file"). With **Ask**, a small window asks where each file goes: **Downloads** (the default button, also Enter) saves it to your downloads folder, **Choose where…** opens the save dialog, and **Cancel** drops it. The file starts downloading while you decide. **Don't ask again** keeps your answer as the setting and gives it to the other files still waiting to be asked, and a line in the window says where to change it, with a link to Settings → Downloads. Retry on a failed download does not ask again, and a temporary file left behind when Corvus closes during the question is removed at the next start. Programs keep their own warning, and files AI agents and extensions download are never asked about.

### Dialogs
- Corvus's dialogs can say where to change what they ask about, with a link that opens that part of Settings.

## v0.36.8

### PDF viewer
- **Download buttons download PDFs again.** A PDF a site sends as an attachment (Gmail's **Download** on an attached PDF, any "download" link that asks for the file to be saved) opened in the PDF viewer instead of being saved, so getting the file took an extra step that looked like it saved it to the reading list. When the page you are on asks for the file to be saved, the PDF is now saved to your downloads and the page stays, as in other browsers. A link to a `.pdf`, and a PDF that opens in a tab of its own (a bank's one-time link), still open in the viewer.

## v0.36.7

### Sites with their own certificates
- **Icons of sites whose certificate you accepted.** A site on your network with its own certificate (a router, a NAS, an internal `.internal` name with your own CA) showed no icon after you chose **Proceed**: Corvus fetches site icons itself, and those requests did not get your choice. They do now, for that site and that certificate only, and **Turn on warnings again** takes it back for them too.

## v0.36.6

### AI agents
- **Let trusted AI agents sign in without asking.** New in Settings → Passwords, off by default. When it is on, agents you already let work on their own (Claude Code and other MCP clients at Full access, and the Command Bar agent with "Ask before risky actions" off) sign in with any saved login of the site and fill its 2FA code without asking you, also without opting each login in. They also answer the site's own sign-in box and open the apps a page asks for to sign you in, such as AutoFirma for a digital certificate. They still never see the password or the code, and anything that spends money still asks. Useful when an agent works for you while you are away.
- Agents now try the saved login before asking you to sign in.
- **Your clicks and the address bar work while an agent works.** Every time a tab of an agent loaded a page in the background, it took the keyboard for a moment: a selection in the address bar was lost, and a menu or list you had open in a page closed by itself. Tabs no longer take the keyboard when they load; Corvus gives it to the tab you are in.

### Reliability
- **No more endless "tab crashed" loop.** When Corvus could not start a page at all (some of its files missing), it reloaded its crash page in that tab over and over, keeping the computer busy and blank tabs loading forever. It now shows the crash page once and tells you to quit and open Corvus again. Those files went missing under the portable build before 0.36.5, whose launcher deleted them when it was started a second time (by a link or an AI agent) while Corvus was open.

### PDF viewer
- **PDFs from banks and sign-in portals open again.** A PDF that a site hands over as a download (a bank's certificate, a `.aspx` or one-time link, a form) showed "Invalid PDF structure": the viewer fetched it a second time, without the site's cookies, and a one-time link no longer gave the PDF. The viewer now shows the very file the browser downloaded, and when it does need to fetch a PDF itself it sends the tab's cookies. When something is still not a PDF, **Download the file** saves it instead of reopening the viewer.
- **Download saves the PDF.** The viewer's download-looking **Save** button put the PDF's text in the reading list, so a PDF could only be kept as Markdown. **Download** now saves the PDF file itself to your downloads (the very file the viewer shows, so one-time links work too), and the reading list has its own **Reading list** button.
- A PDF a web app makes and hands you as a download (an export, an invoice) is saved as a file again instead of opening in a viewer that could not show it.

## v0.36.5

### Faster and smaller
- **The portable Windows build opens in under a second.** Before, every start unpacked the whole browser (about 390 MB) into a temporary folder first, which took 5 to 15 seconds before the window showed, also for a link opened with Corvus while it was already running. Now each version unpacks once, into `%LOCALAPPDATA%\Corvus-portable`, on its first start, and later starts open straight from there. A new version removes the previous one's folder, and a damaged copy is unpacked again on the next start.
- **Gigabytes back from the temp folder.** When Windows shut down with the portable Corvus open (or its launcher was stopped), the old launcher left about half a gigabyte in `%TEMP%` each time. The portable build now removes those leftovers a minute after it starts (never one a running Corvus uses).

## v0.36.4

### AI agents (MCP)
- **No more empty gray window after an agent worked while Corvus was minimized.** On Windows, when an AI agent opened or drove tabs while Corvus was minimized (also when it started minimized for Claude Code), restoring the window could show only a dark empty frame, with no tabs, toolbar or page. Corvus now lays the window out again when it is restored.

## v0.36.3

### AI agents (MCP)
- **Starting an AI agent no longer pops Corvus up.** When Claude Code (or another MCP client) starts and Corvus is closed, Corvus now opens minimized, without taking focus or flashing its taskbar button; open it from the taskbar whenever you want (a window saved maximized opens maximized then). If Corvus is already open, it stays where you left it instead of coming to the front. Links you open with Corvus still bring it forward as before.

### Translation
- **Translating a page right as it finishes loading works.** Pressing Translate in the address bar while Corvus was still reading the page's language could lose the translation's progress in the button, and Stop or closing the tab then no longer stopped it.

## v0.36.2

### Sync
- **Open a device's tabs with one click.** In History, each device under **Tabs from other devices** now has an **Open all tabs** button that opens all of that device's tabs in background tabs of this window, like **Open all** on a bookmarks folder (the first few load at once, the rest when you get to them; more than 15 asks first).

## v0.36.1

### AI agents (MCP)
- **AI agents no longer take over your tab.** An agent connected over MCP (Claude Code, for example) now works in tabs of its own: without one yet, the first page it goes to opens in a new tab in the background, and its next steps stay there, while the tab you are on stays in front with your text and the keyboard, so you can keep typing. Its clicks, typing, keys, drags and screenshots all work in that background tab, with real mouse and keyboard events as in the tab in front (sites that ignore scripted clicks work too), and you can open it to watch at any time. It acts on one of your tabs only when it names that tab (when you ask it to); reading the page in front of you still works as before.
- **Corvus stays where you left it while an agent works.** Minimized or behind another app, Corvus no longer comes to the front when an agent opens or drives tabs, shows you a tab or runs a recorded flow that needs your approval, nor for any other question Corvus asks while you are elsewhere: its taskbar button flashes instead, and the keyboard is in the right place when you come back.
- `tab_open` opens tabs in the background unless an agent passes `background: false`, `drag` works in background tabs instead of asking the agent to switch tabs, and the instructions Corvus and its Claude Code skill give agents tell them never to switch tabs to work.

## v0.36.0

### Passwords and 2FA
- **Logins saved for the same site under another ending.** On a site whose name matches one you have logins for under another ending (example.es, example.co.uk or example.it when you saved example.com), the list under the login or 2FA code field now has a folded section **Saved for example.com**, marked with a warning, instead of offering nothing. A look-alike name (examp1e.com, example-login.com) never counts. Picking one of its logins asks first, since a site with the same name can belong to someone else, and fills it only once you confirm; after you sign in, the save prompt offers to keep it for this site. Under a 2FA code field, picking its code (after the same question) also saves a copy of the login for this site with the same 2FA, so the next sign-in here offers it as this site's own. AI agents and automatic sign-in never use these logins.

## v0.35.0

### AI agents (MCP)
- New `wait_for_download` tool (Full access): after a click that starts a download, an agent waits until the file is complete and gets its path, instead of polling `downloads_list`. It can filter by address or file name, and says when Corvus holds the file for you to keep or discard.
- `request_user_action` now tells the agent when you closed the tab it was waiting on (`closed`), apart from when you click Cancel (`cancelled`), so it does not take a closed tab as a refusal.

### Highlights and notes
- **The highlight toolbar shows properly on every site.** On sites whose security policy refuses added styles (GitHub and many local tools, for example), the toolbar that appears when you select text showed as plain, oversized buttons stuck in the top-left corner of the page; saved highlights did not show there either. Both now work on those sites too.
- **A new look for the toolbar**: a compact bar with round color swatches and a Note button, light or dark with your theme, and the same for the box that opens on a saved highlight (its note, its color, Edit note and Delete). It is in Spanish when Corvus is, and each color says its name.
- **No toolbar while an AI agent works on the page.** Its clicks and selections no longer open the toolbar or a highlight's box, which also kept them out of the agent's screenshots.

### Recorded flows
- **Values entered with Enter are recorded**: in fields that turn what you type into a chip and clear themselves (domain names, tags, multi-select comboboxes), the recording kept nothing, so replay skipped that field. Each value is now a step that types it and presses Enter.
- A click on a form's submit button was recorded twice ("Click Save" two times), and replay submitted the form twice; it is now one step.

### Corvus for mobile
- **The passwords saved in Corvus on your computers, on the phone.** A paired phone now gets your saved logins with the next sync, end-to-end encrypted as before, and keeps them encrypted again in its own storage with a key held by Android's Keystore or the iPhone's Keychain. Settings > **Saved passwords** lists them with search; copying or showing a password, or its notes, asks for the phone's lock (fingerprint, face or PIN) first, and a copied password is cleared from the clipboard after a minute. In the browser, the page menu offers **Fill password** on a site with a saved login, after the phone's lock. A login is only filled into its own site, never into another one the page moved to while you unlocked, and a login saved over https is never offered to the same site over plain http. The phone only reads them: add and change passwords on a computer. Unpairing the phone deletes them from it.
- **Android: sites that ask for a username and password** (a router's or a printer's panel, an intranet with HTTP sign-in) now show a sign-in dialog, as Chrome does, instead of the site's "401 Unauthorized" error. It names the site and what it calls the area, warns when the connection is plain http, offers the passwords saved for that site in one tap, and says so when the site refused what you entered, with your username filled in again.
- **Sites with an invalid certificate** (a router with a self-signed certificate, an expired certificate, one issued for another name) show "Your connection is not private" in the tab, with a sentence on what is wrong with the certificate, in English and Spanish, instead of a generic "This page could not be opened" with an English error ("SSL error: ...") on Android. **Back to safety**, like the back button, returns to the page you were on (before, back skipped it and went one page further), or closes a tab another app opened, as back does. Reload tries the site again. The address bar no longer keeps loading forever after such a page on Android. The phone offers no way past it, since Google Play refuses apps whose browser view skips certificate errors: for a device you trust, the page says to open it in Corvus on your computer, and **Send to a computer** sends it there when the phone is paired.
- The address bar never shows the lock for such a site (the iPhone did): it says **Not secure** in red, with a warning sign on iPhone, and the site panel says the certificate is not valid.
- Android: tapping a link to such a site did nothing (the page stayed as it was, with no word of why); it now shows that page too.
- Android: a page that failed to open (an invalid certificate, no connection, an unknown address) is no longer added to your history, on the phone and on your synced computers.
- **Android: changing Corvus's language shows at once.** Settings → Apps → Corvus → Language now lists English and Spanish (Android 13 and later), and Corvus switches every screen, the tab bar and the titles to the new language right away, on the screen you are on, instead of only after closing and opening it again.
- **Android: Corvus comes back to the screen you were on** when Android rebuilds it (after closing it in the background to free memory, or after a change of font or display size): the tab, chat, browser or settings page you had open, with the tab you came from under it, instead of Home. After more than 30 minutes away it starts on Home as before (the browser keeps its tabs), and closing Corvus from the recent apps still starts it on Home.
- Android: when Corvus had been opened from a link in another app and Android rebuilt its screen, Corvus opened the link again or closed; it now stays where you were.
- Android: after Android rebuilt Corvus's screen while it was open (a change of font size, for example), tapping something that opens another screen did nothing until Corvus was closed; it works again.

## v0.34.1

### Passwords and 2FA
- Fixed: importing passwords from another browser closed Corvus on Windows.
- If Corvus cannot read the passwords a browser saved on this computer, the import still finishes: it says how many it could not read, and that browser's own export, offered right there, brings them in. Corvus reads them in a separate process, so a failure there can no longer close the browser.

## v0.34.0

### Passwords and 2FA
- **Passwords from your other browsers come in with the Import button.** Settings > Import from another browser (and the Welcome page) now lists **Passwords** for each browser profile, with how many it holds, ticked by default. Pressing Import reads the passwords saved in Chrome, Edge, Brave, Vivaldi, Opera or Firefox on this computer once, at that moment, into Corvus's encrypted vault: nothing runs in the background, and the other browser's files are only read, from a private copy that is deleted afterwards. On a Mac the system asks you first. The other browser keeps its own copy.
- **Chrome's protected passwords come through Chrome's own export.** Chrome on Windows protects its saved passwords so that no other app can read them, and Corvus does not try. The Passwords row says how many are protected and offers **Open Google Chrome's export**: Corvus opens Chrome's password settings, waits a few minutes for the file you export into Downloads, imports it the same way and then deletes it for good, since it holds your passwords in plain text (you can untick that). The same works for Firefox when it has a primary password.
- **Importing never overwrites a newer password or brings back a login you deleted.** Each saved login now remembers its previous passwords, as one-way fingerprints and never the passwords themselves, so a browser that still holds an old password leaves the login alone instead of overwriting it or adding a second entry; a newer password from the browser updates it. A login you deleted in Corvus stays deleted while the browser still holds the same password. Importing the same browser twice adds and changes nothing. This memory syncs with your logins between your computers and is left out of exports.
- **The result says what happened to each login**: how many are new, updated, already saved, older and left alone, deleted in Corvus and left out, protected by the browser, or skipped, with the sites and usernames behind each (never a password), such as app logins, sites where you chose never to save, and sign-ins through another account.
- **A password CSV goes through the same checks.** When a CSV holds a different password for a login you have and nothing says which one is newer, Corvus keeps its own and lists those logins with **Update** and **Update all**. Firefox's export dates tell which password is newer. Corvus can delete the CSV for good once it is imported (on by default).

## v0.33.1

### Passwords and 2FA
- **Two-step sign-ins.** On sites that ask for your e-mail or username first and for the password on the next step (IONOS, Google, Microsoft and many others), clicking the e-mail field now lists your saved logins for the site, under the field and in the key in the address bar, as on any sign-in form. Picking one fills only the e-mail: Corvus never fills a password into a hidden field of that step and never presses **Next** for you. Ordinary e-mail fields (a newsletter, a search) stay quiet, and nothing shows on sites where you have no saved login.
- On the password step, the login you picked or typed on the first step comes first, also when the site shows the password step on the same page.
- **Saving a password on a two-step sign-in** now keeps the e-mail or username you entered on the first step (the password step usually has no username field), instead of saving the login with an empty username. Corvus keeps that username in memory only, for that tab and a few minutes.
- AI agents signing in on such a first step fill only the username and are told to continue to the password step; a hidden password field is never filled.

## v0.33.0

### Passwords and 2FA
- **The lists of logins, KeePass entries and 2FA codes are now one clean table**: the same columns in the same order with a header (site and username, status, 2FA code, automatic sign-in, actions), lined up from row to row at any window width, and nothing overlaps. Long names are cut and show in full on hover; Show, Copy, Edit and Delete stay in the same place in every row, as words on a wide window and icons on a narrow one; each KeePass entry says which database and group it is in; saved logins are listed by site. A KeePass entry's AI agent options moved to its Edit form, as for saved logins (they stay in Corvus and never change the database file, so they also work on a read-only database), and automatic sign-in is a switch in its own column. The page's title is no longer cut or covered by the toolbar on a narrow window.
- **Edit and Delete in the 2FA codes tab.** Each row now has **Edit**, to fix a 2FA that went to the wrong place (a code imported under the wrong site or subdomain, the wrong username or e-mail, a wrong secret): the login's form opens over the list, after the same confirmation as in the Passwords tab, and the list stays on its page when you save or cancel. A row from a KeePass database opens its entry form, which now also takes a new 2FA secret (typed, pasted or from a QR code image). The new code shows at once.
- **Deleting takes two confirmations, in both tabs.** The first names the login (site and username) and, for a login with a password and a 2FA, lets you choose **Remove the 2FA only** (the password stays) or **Delete the whole login**; the second says what happens and has a red button, which stays off for a moment so a double click cannot reach it. Cancelling either step deletes nothing. With sync on, the deletion reaches your other devices too, and it warns you to check you can still sign in without the 2FA.
- **KeePass entries can be deleted from Corvus**, from the 2FA codes tab or from the entry in the Passwords tab: like KeePass, Corvus moves the entry to the database's Recycle Bin (or deletes it for good when the database has the Recycle Bin turned off), after keeping a .bak copy of the file. Removing only an entry's 2FA keeps its password and the previous version in the entry's history.
- **Passwords and 2FA secrets in the edit forms stay blurred**, so they are hard to read on screen or in a screen share, until you point at the field or click in it; a Copy button next to each copies the value without showing it.
- Fixed: after changing a login's 2FA secret, its code next to the login kept showing the old code until the next 30 seconds.
- **Strong passwords where you create one.** Clicking a field for a new password (a sign-up form, the new password and its confirmation in a change form), or a password field Corvus has no saved login for, shows **Suggest a strong password** in the list under it, with a preview. It opens a small generator in that list: the password, its length (8 to 128, 24 at first, typed in or with a slider), lowercase, uppercase, digits and symbols, **Regenerate**, **Copy** and **Use password**. Corvus remembers your last choices and syncs them with your other computers (a private window keeps them only while it is open).
- **Use password** fills the new password and its confirmation, never the current password of a change form. Corvus keeps the password ready to save at once (the key in the address bar offers it, in case the page fails or signs you up without sending a form), and when the form is sent the save prompt offers it as usual.
- The suggested password follows what the field takes: a maximum or minimum length, and the characters its pattern allows (no symbols, only some symbols, digits it asks for). The generator says what it changed and why.
- **Copy password**: clicking a password field that already holds a password shows a small **Copy password** under it, which copies it without showing it on screen and says "Copied".
- The generator is never offered on 2FA code fields or PINs, nor in tabs an AI agent is using. While you type its length the list keeps the keyboard; everywhere else your typing, Ctrl+V, the arrows, Enter and Escape still go to the page's field as before.
- Saving the password of a change-password form saved the current password instead of the new one; it saves the new one now.
- After **Check for breaches**, the logins whose passwords appear in the most known breaches come first, in your saved logins and in KeePass, so the ones to change are at the top. Contributed by Noel.

### Browser
- **Live history from other browsers is now on by default.** A page you open in Chrome, Edge, Brave, Opera, Vivaldi or Firefox shows up in Corvus's address bar suggestions and history without going to Settings or importing again. Corvus follows each browser's default profile; pick others in **Settings → Live history from other browsers**. If you had turned it off, it stays off. These pages stay on this computer and are never synced.
- The first time it turns on by itself, a bar under the toolbar says so once, naming the browsers, with **Settings** and **Turn off** (which also removes the pages it brought in). Private windows never read the other browsers and never show the bar.
- **Pages come in faster while the other browser keeps running.** Chrome and Edge save a visit to disk about ten seconds after you open the page (closing them saves it at once, which is why closing seemed to help; they never need to close for Corvus to read them). Corvus now reads it about a second after it is saved while Corvus is in front, and at once when you switch to Corvus or type in the address bar.
- Fixed: a read that failed, or caught the other browser in the middle of saving, waited until that browser saved again (which could take minutes); it is now tried again a few seconds later.
- Corvus copies the other browser's history only when that browser has saved something new, at most once a minute while Corvus is in the background, and never while that browser has only started writing.
- Pages from another browser are marked with that browser's own small icon, taken from the browser installed on your computer, in the address bar suggestions, in Settings and on the History page (instead of a letter in a coloured circle, which stays when the icon cannot be found).

## v0.32.9

### Passwords and 2FA
- The 2FA code next to a login in the Passwords tab shows the same countdown ring as the 2FA codes tab (it had a thin line that was hard to see).

## v0.32.8

### Browser
- **Tabs you open in the background are ready when you get to them.** A link you middle-click, Ctrl+click (⌘-click on a Mac) or open with Open link in new tab, a page that opens a tab in the background and a tab an extension opens in the background now load at the window's size and are drawn before you look at them, images included, so the page shows complete at once (before, its pictures came in about half a second after you switched to it). They may still go to sleep later by the usual rules. **Settings → Memory → Load tabs opened in the background right away** turns this off.
- **Open all** on a bookmarks folder loads the first 5 tabs at once and the rest when you get to them.
- **AI agents can see the tabs they work in without taking your screen.** Tabs an MCP client, the Command Bar agent, Assist or a scheduled agent opens or uses keep drawing out of sight, at the window's size, so their screenshots show the page and the coordinate tools land where they should, while the tab you are on keeps your clicks, keys and focus. Only the 8 agent tabs used most recently do (2 when the computer is low on memory); turn it off in **Settings → AI agents (MCP) → Let AI agents render pages in the background**.
- Fixed: a screenshot of a tab that had never been on screen failed with "The tab has not been painted yet". Any background tab is now drawn for its screenshot without showing it, and a sleeping tab loads first.

## v0.32.7

### Browser
- **Downloads no longer leave an empty tab.** A link to a file that opens in a new tab (a link that opens a new tab, a page's pop-up, a middle click, Open link in new tab) downloads in the background: that tab closes by itself and the page you were on stays in front, in AI agents' tab groups too.
- A file downloaded from the page you are on, or a file's address typed in the address bar, leaves the address bar on that page's address instead of the file's.
- **Programs you download wait for your OK, and Corvus learns which ones you trust.** A .exe, .msi, .jar, a script or another kind of program downloads in the background under a temporary name, and the downloads bubble asks you to Keep or Discard it. Tick **Always keep .jar files** (from that site, or from any site) and Corvus stops asking for that type; after you keep a type twice, that box comes ticked, but nothing is trusted until you click Keep.
- **Settings → Downloads** lists the file types you trust, where you can remove or add one, and every kind of file Corvus warns about, with why. These choices stay on this computer, and private windows remember none.
- Fixed: a program you downloaded yourself in an AI agent's tab group was held back as if the agent had asked for it ("an AI agent tried to download a program"). Programs an AI agent or an extension asks for still always wait for you, whatever types you trust.

## v0.32.6

### Browser
- **Links that open an app on your computer work, as in Chrome.** A link to Autofirma (afirma://), Zoom, Microsoft Teams, Steam, e-mail (mailto:) or any other app now asks **Open <app>?**, with the app's name and icon, the site that asks, and **Always allow <site> to open links of this type in the associated app**. Before, Corvus silently ignored them, so signing with Autofirma on government sites failed while it worked in Chrome and Brave.
- A page can open an app only right after you click or type in it, as in Chrome. When it tries again by itself, a quiet bar says Corvus stopped it, with a button to open the app anyway. Private windows ask every time and remember nothing, and kinds of links that have been used to run code on Windows (ms-msdt:, search-ms: and similar) are never opened.
- Sites you allowed to open an app are listed in Settings > Site permissions as **Open external apps**, where you can take each one back.
- **Sites that ask for a username and password open again.** A router's or a device's panel, or an intranet, protected with HTTP sign-in (Basic, Digest or NTLM) now shows a **Sign in** dialog with the site, the name it gives to the protected area, and a warning when the password would travel unencrypted. Your saved logins for the site (in Corvus or KeePass) are offered with one click, the password field has a button to show what you type, and after a sign-in you typed yourself Corvus offers to save it. Cancel leaves the site's own error page and a wrong password asks again. Before, Corvus never asked and the page stayed on the error.
- A question from a tab you are not looking at (opening an app, signing in to a site) waits in a bar in its window instead of switching tabs; its button takes you to the tab and asks there.
- AI agents never open apps or answer a site's sign-in by themselves: Corvus asks you and tells the agent to hand the step to you. A login you allowed for agents is still used for the sign-in, after you approve it.
- **Access other apps and services on this device**: when a site asks for local network access (to talk to an app such as Autofirma on 127.0.0.1, or to a device on your network), Corvus asks with Allow and Block, remembered per site, instead of refusing without a word. Corvus's current engine does not ask for it yet, so those requests keep working as before, and the ad blocker never blocks addresses on this computer (now every 127.x.x.x address).
- Permission prompts and the site information panel now name each permission in Spanish too.
- **The account list under a sign-in or 2FA code field closes whenever its page leaves the screen or moves**: another tab (picked on the tab strip, or switched to by an AI agent or a link from another app), a split view, resizing the sidebar, opening or closing the Assist panel, minimizing or hiding the window, or switching to another app. Before, it could stay open over another page when the keyboard did not move.
- **The first account list in a window shows at once.** Corvus now prepares it, hidden, as soon as a page of the window has a sign-in or code field with saved accounts, instead of loading it on the first click. Windows without such a page prepare nothing.
- **A click right next to the account list reaches the page.** The clear band kept around it for its shadow took those clicks; the list now ends at its edge, which is a thin border instead of a shadow.
- Closing a window now frees the memory of its account list, which kept running until Corvus quit.
- **Live history from other browsers.** Turn it on in Settings, next to Import from another browser, and pick the Chrome, Edge, Brave, Opera, Vivaldi or Firefox profiles to follow: a page you open there shows up in Corvus's history and address bar suggestions (by its address and by words of its title) as soon as you switch to Corvus, without importing again. Off by default.
- Those browsers save their history every few seconds, so a page you just opened can take a few seconds to appear. Corvus reads their files only when they changed, from a copy, and never changes them; with nothing new it does no work at all.
- These pages stay on this computer: they are not synced to your other devices. A small badge in the suggestions and on the History page shows which browser each one came from, and **Forget visits from Chrome** (or the browser concerned) removes them all. A page you also open in Corvus becomes Corvus's own, like any other.
- When Corvus's history is full, pages from other browsers make room first, so they never push out your own.

## v0.32.5

### Browser
- **Import from Google Authenticator reads iPhone photos (HEIC).** Photos saved in the iPhone camera's default format (.heic or .heif) can be chosen one by one or in a folder, like PNG and JPEG ones; before, Corvus said it could not open them. They are read on this computer, like the others, and a HEIC photo saved with a .jpg name is read too.
- **Import from Google Authenticator adds the 2FA to your KeePass entries too.** When an account's site and username match an entry of an unlocked KeePass database, the preview says "Adds 2FA to the KeePass entry X in database Y". Importing writes the 2FA into that entry the way KeePassXC does (and into KeePass 2's own 2FA fields when the entry has them), keeps a .bak copy of the database file before its first change, and Corvus then fills the code on the site. An entry that already has the same 2FA is shown as already set. When a login saved in Corvus also matches, the Corvus login still comes first.
- Nothing is written to a KeePass file unless its row is ticked. Rows of a database file Corvus cannot write (read-only) start unticked, the preview names any locked database so you can unlock it first, and if a database is locked or changes before you import, Corvus asks you to check the list again instead of putting the 2FA somewhere else.
- **Closing a tab or a window stops what Corvus was doing for it**: a summary or a translation being written for that page ends at once, instead of going on (and using your AI provider) for a page that is gone. Closing a window also ends an AI agent's request to do something in one of its tabs, as Cancel, as closing the tab already did.
- An AI agent working in a tab you close is told that the tab was closed, instead of getting an internal error.
- An extension's side panel closes when its page closes itself, as in Chrome.
- **Copying a 2FA code from the padlock list now says so.** On a page without a code field yet, the 2FA button of an account copies its current code: the button now turns into "Copied" for a moment and the list then closes by itself (before, the list just closed and you could not tell whether anything was copied). As with every other copy in Corvus, the clipboard is left as it is afterwards.
- **"2FA only" is no longer cut off** in the list behind the padlock (it was in Spanish): it is now a small tag right after the username, always shown in full, and the 2FA button is narrower ("2FA code" over the current code, "Fill 2FA code" when you point at it).
- **On a site with several accounts, the one you used last comes first**: in the list behind the padlock and in the menu under a field, for example on the code step of a two-step sign-in where several accounts have a 2FA. The others are still listed below it, and accounts saved for the page's own address still lead their section. Corvus remembers which account it filled last on each site on this computer only (no passwords or codes), and not from private windows.
- **"Never for this site" in the save-password prompt**: it closes the prompt without saving and Corvus stops offering to save passwords on that address (only that one: other addresses of the same site still ask). Settings, Passwords, **Never saved** lists those sites, and **Remove** makes Corvus ask there again. The list belongs to the profile and stays on this computer.
- **The padlock list opens with a click even right after you typed in the address bar.** If you clicked into the page while the address bar still had the cursor, a click on the padlock (or the star, the reader or translate buttons) put the cursor back in the address bar instead, and the list did not open. The address bar now lets go of the cursor as soon as the page takes the keyboard, as in Chrome; switching to another app and back still keeps it.
- **The accounts under a sign-in field no longer take the keyboard.** Clicking a username, password or 2FA code field still lists the site's accounts right under it, but the field keeps the keyboard, so you can type, paste with Ctrl+V or select the text as usual (before, the list was a system menu that captured the keyboard until it closed). Typing or pasting, Escape, Tab or a click elsewhere closes it; the down arrow opens it from the field and moves through it, and Enter fills the highlighted account. It looks like the list behind the padlock: the username over its site, a "2FA only" tag, and the other addresses' accounts folded away.

## v0.32.4

### Browser
- **Picking your account fills the 2FA code too.** On a sign-in page that asks for username, password and a verification code in one form, choosing the account (in the menu under a field or in the list behind the padlock in the address bar) fills all three at once when the account has a 2FA. If the current code has less than 3 seconds left, Corvus fills the next one the moment it starts.
- **Clicking a verification code field opens its own menu**: "2FA code for" each account of the site that has a 2FA. Picking one fills the code, and the username and password too when those fields are still empty (what you typed stays).
- On two-step sign-ins, where the code is asked on a page after the password, clicking the code field offers the site's account with a 2FA, even when the field shows up after the page loaded. Nothing is filled until you pick it.
- **Corvus recognizes more verification code fields**: fields whose label is not tied to the field, with a "1 2 3 4 5 6" or "123 456" placeholder, help text about an authenticator app, or a Spanish label such as "Código de verificación". Before, on such a page Corvus did not offer the 2FA code at all.
- **Accounts saved for the page's own address come first.** Accounts of the site's other addresses (other subdomains) wait in a folded "Other example.com accounts" section in the list behind the padlock, and in a submenu under a field; when the page's address has no account of its own, they are listed directly. A password and a 2FA of the same user saved on different addresses are still one account.
- **The list behind the padlock in the address bar was redesigned**: a fixed width that never runs past the window, one row per account with the username in bold over its site (cut short with "..." when long, the full text when you point at it), and for an account with a 2FA a **Fill 2FA code** button that shows the current code when the page has a code field (it copies the code otherwise).
- Very long usernames and sites are cut in the middle in the menu under a field, so the menu stays readable.
- **The Passwords page header lines up**: "Back up now" has no caption under it any more and sits level with "Import from Google Authenticator" and "Add". When the last backup was is now its tooltip, and the backup form says it too.

## v0.32.3

### Browser
- **When an AI agent asks you to do something in a tab** (sign in, a payment, a 2FA code), Corvus no longer switches you to that tab or brings its window to the front: you keep working where you are.
- The tab it needs you in blinks in the tab strip (and in the vertical tab sidebar), with a dot on its icon and "An AI agent needs you here" when you point at it, so you can see where it is. Once you are on that tab it stays highlighted without blinking. In a collapsed tab group, the group's name blinks instead.
- The bar with the agent's request shows in that tab's window, with Cancel and Done as before, plus **Go to tab** while you are on another tab: it takes you there without answering.
- If the window is minimized or in the background, its taskbar button flashes until you switch to it, instead of the window popping up.
- The blinking stops as soon as the request ends: Done, Cancel, the agent's time limit, the agent going away or the tab being closed (closing it counts as Cancel). With reduced motion turned on in your system, the tab is highlighted without blinking.
- **Import from Google Authenticator reads labels like "Acme Portal - name@example.com"**: the e-mail address is the account and the rest is the issuer, so the 2FA goes to your saved login of that address instead of a new login named after the whole label. The same goes for labels written with "|", "/", a middle dot or a dash between the issuer and the account, and for "Issuer (account)" and "account (Issuer)".
- **Importing the same photos again repairs an earlier import and never asks for a site twice.** Each account whose 2FA is already in Corvus keeps the site it has (including every site you typed then), and is shown as already set. A login an earlier import made for the 2FA alone under the whole label gets its username fixed, or, when you have a login with a password for that address on the same site, the 2FA moves to that login and the empty one is removed ("Moves the 2FA from the earlier import to your login..."). Corvus only ever removes a login without a password that holds the very 2FA that moved. The preview lists these as **Repairs**, ticked.
- **Autofill offers one item per account of the site**: the saved logins of the page's own address and of the other addresses of the same site (central.example.com and example.com) are merged by username, so a login with a password and a 2FA-only login of the same user fill both the username and the password, and **Fill 2FA code** uses the 2FA of either. Logins of different sites never mix, nor do those of separate customers of shared hosting such as github.io, and a login saved for https is never offered on http. AI agents still only use logins saved for the page's own address.
- The menu under a login field and the list behind the key in the address bar show, for each account, the username, the site its password is saved for (without https://), the KeePass database it comes from, and **2FA only** for an account without a password. Picking a 2FA-only account fills the username and leaves the password field as it is (before, it filled the username and emptied the password).
- **The Passwords page has two tabs, Passwords and 2FA codes**, each with how many it holds. Corvus opens the one you used last, and a link to corvus://passwords/#2fa opens the 2FA codes. Both list 25 at a time with Previous and Next ("1-25 of 130"), and the search box searches the tab you are in.
- **2FA codes** lists every login with a 2FA, from Corvus and from unlocked KeePass databases (marked with the database), by site: the site and its icon, the username, the current code ("123 456") with a ring that empties until the next one, **Copy**, and **Show login**, which opens that login in the Passwords tab. Logins that hold only a 2FA say **2FA only**. Only the codes on screen are fetched, each when its period ends. **Import from Google Authenticator** is there too.
- The Passwords page works in a narrow window (down to about 480 px): the header, the menu and the rows stack instead of running off the side.
- **Back up now** on the Passwords page writes every saved login, with its 2FA code generator, to a new KeePass file protected by a master password you choose (the existing export, now one click away). Under the button Corvus says when you last did it ("Last backup: 12 days ago", or "Never backed up"). The KeePass section's export and the Import from Google Authenticator summary open the same form.
- **A reminder to back up**: when you have saved logins and have never backed them up, or they changed and the last backup is more than 30 days old, a bar under the toolbar asks once when Corvus starts: "Back up your passwords and 2FA codes: if this computer fails, a copy is the only way to get them back." **Back up now** opens the form, **Later** asks again in a week, and **Don't remind me** turns it off (Settings, Passwords, "Remind me to back up my passwords", on by default). Importing 10 or more logins or 2FA codes makes it ask at the next start. It never shows in a private window or over a tab an AI agent is using.

## v0.32.2

### Browser
- **The tab strip and the address bar no longer freeze.** After a page closed itself (for example a sign-in or payment popup that opened as a tab and closed when it was done), they stopped updating until Corvus was restarted: tabs you closed stayed on the strip and did nothing when clicked, and the address bar kept the same page whichever tab you switched to. A page that closes itself now closes its tab, as in Chrome, and closing a window after that no longer freezes the other windows of the profile too.
- Should anything ever keep Corvus from preparing what the tab strip shows again, the strip and the address bar still follow your tabs instead of freezing, and the error is written to the crash log (when "Save crash logs locally" is on in Settings).
- Closing a tab while its page shows a message (alert, confirm or prompt) now closes the message too, instead of leaving it over the window.
- **Saving a password is now a small form that opens by itself** when you sign in to a site with a new or changed password, as in Brave and Chrome, instead of only turning the key in the address bar purple. It shows the site, the username and the password you just entered (hidden behind dots, with an eye button to show it), and you can correct either before you press **Save** (or **Update** for a login you already have). **Cancel** forgets it, and Enter and Escape do the same as Save and Cancel.
- The form opens once per sign-in and leaves the keyboard on the page, so you can keep typing. A click elsewhere closes it, and the purple key in the address bar opens it again until you answer. It does not open by itself in a tab an AI agent is driving.
- Changing the username in the form to one you already saved for the site updates that login's password; changing it to a new one saves a new login and leaves the old one as it was.
- **Import from Google Authenticator** on the Passwords page moves your 2FA accounts into Corvus, so it fills the codes on each site. In Google Authenticator choose Transfer accounts, then Export accounts, take a photo of each QR code it shows, and choose the photos (or the folder that holds them) in Corvus. The photos are read on this computer and never uploaded.
- Phone photos of the screen work: large, tilted, with glare or a little blur. Corvus reads them one by one ("Reading photo 5 of 12") without slowing the browser, says which QR code each photo held ("QR 2 of 12: 10 accounts"), ignores a code photographed twice, flags a photo with no code, and tells you which QR codes are missing so you can add their photos. Several exports, and accounts found twice, are merged. A site's own setup QR code can be in the same selection.
- Before anything is saved you see every account with the site it goes to (editable) and what happens: "Adds 2FA to your login" when a saved login on that site has the account's username (or is the site's only login), or "New login (2FA only)" otherwise. A login that already has a different 2FA code is shown as a conflict and is only replaced if you tick it. Accounts from unknown issuers wait for you to type their site. Filter the list, select all or none, and see how many accounts are matched, new, in conflict or need a site. Counter-based (HOTP) and MD5 accounts are listed as not importable.
- After the import Corvus reminds you to delete the photos, from your phone's gallery and any cloud photo backup too: they hold every 2FA secret.

## v0.32.1

### Browser
- **Sites with an invalid certificate** (a router or NAS with a self-signed certificate, an expired certificate, one issued for another name, and so on) now show Corvus's "Your connection is not private" page instead of a blank tab, in light and dark, English and Spanish. It explains in a sentence what is wrong. **Back to safety** returns to the page before (or a new tab); **Advanced** shows the error code and the site, and **Proceed to the site (unsafe)** opens it anyway.
- Proceeding accepts that exact certificate for that site only, for this session of this profile: a private window or another profile asks again, and so does Corvus after a restart. If the site's certificate changes, you are asked again. Sites that use HSTS (such as google.com, youtube.com or any .dev address) and certificates that can never be accepted (revoked, for example) offer no Proceed, as in Chrome.
- The address bar never shows the lock for such a site: it says **Not secure** in red, on the error page and after you proceed. Site information says the certificate is not valid and offers **Turn on warnings again**. The tab is titled "Privacy error" instead of the bare error code.
- Images, scripts and frames from a site with an invalid certificate stay blocked on an otherwise valid page, with no warning page, as before.
- **AI agents** stop at an invalid certificate and leave the choice to you: the error page waits in the tab and the agent is told so. Only in full auto (the Command Bar agent with "Ask before risky actions" off, or MCP clients at the Full access level) do they go on by themselves, never for HSTS sites, and the run shows "Continued past an invalid certificate for the site", as does the MCP activity log (and its CSV export).

## v0.32.0

### WebScope
- **Fits a narrow page** (WebScope in a split, or a small window, from about 480 px wide): the tool tabs wrap onto a second row by group instead of running off the edge, the "Authorized testing only" pill keeps just its warning icon, and the captured and tab counts keep just their numbers, with the words in a tooltip. The Capture switch and the Session button stay in view, nothing breaks over lines in English or Spanish, and wide windows look as before. In the dark theme, the corner where a table's two scrollbars meet is no longer a white square.
- In Spanish, History's Type filter and column read "Tipo" instead of "Escribe".

### Corvus for mobile
- Android: the app no longer opens now and then with a black band across the top and everything pushed down a little, until you closed it. It happened when the phone was busy as Corvus started (often right after an update): Android's splash screen and the app's start-up got in each other's way.
- Android: Corvus now always follows the phone's dark mode when you come back to it. If dark mode turned on or off while Corvus was in the background (for example on a schedule) and Android reopened the app's screen from scratch, as it does after a language change or to free memory, Corvus kept the old colours until you closed it.
- iPhone: the app is in Spanish on an iPhone set to Spanish (it showed English, since iOS gave it an English locale), and the start page of a new tab no longer says ads and trackers are blocked, which only the Android app does. "Clear cookies and site data" now clears them on iPhone too (it only said so), and the page menu no longer offers "Desktop site" there, where it changed nothing. The back button of screens opened from the tabs (an Assist chat, Watched pages) reads "Corvus" instead of "(tabs)". The licences screen no longer mentions Android, and the app no longer carries an unused Face ID permission text.
- iPhone: the camera and local network permission prompts are in Spanish on an iPhone set to Spanish. Notifications of sent and watched pages no longer need the iPhone unlocked: the check behind them could not read your pairing while the iPhone was locked, which is when iOS runs it most. Your pairing now stays on this iPhone only, so a backup restored to another iPhone no longer brings it along (pair the new one). Nothing to do after updating: the app keeps its pairing.

## v0.31.0

### WebScope
- **Live workbench**: History, Target, Findings, the Intercept queue and the captured and tab counts update by themselves as traffic arrives, with nothing to refresh. Changes are batched to a few updates a second, so heavy traffic stays smooth, and the polling every page did before is gone.
- History keeps your place while rows arrive: at the top of the list new rows simply appear; scrolled down, the row you are reading stays where it is and a **N new** button counts the rows that arrived out of view (click it to jump to them). Selection, marks, sorting and filters are kept. Only the new rows are fetched, so a busy History stays fast.
- Requests held by Intercept show as a count on the Intercept tab, so you see them from any tool.
- **Session** opens a small panel under its button: a Save card (with the "Include captured traffic" option and its privacy note) and an Open card, each with a one-line explanation and its action in the same place, and a confirmation in the panel, naming the file, before a session replaces the scope and rules you have. After saving or opening it says what happened (the file name and how many requests). Works in a narrow window; Escape or a click outside closes it.
- The scope strip and the Intercept switch say "armed", "off" and "on" in Spanish too.

### Windows
- **Updates keep your taskbar pins and shortcuts**: the update installs over Corvus in place, without the installer's windows, and starts Corvus again. The Start menu and desktop shortcuts stay the same files, so Corvus stays pinned. Running a newer Corvus-Setup by hand now does the same (before, it removed the pins and made new shortcuts; it still makes new ones when you install to another folder).
- Corvus's windows now carry the same Windows app ID as its shortcuts, so a pinned Corvus shows as running whichever way Corvus was started (for example, a link opened from another app), instead of a second Corvus button next to it.
- **Portable copy**: an update writes the new version into the same file, which keeps its name, folder and place on the desktop, so shortcuts and pins of it keep working. Copies named `Corvus-Portable-<version>.exe` keep that name too, and the download waits in `%LOCALAPPDATA%\corvus-portable-update` instead of next to the copy. If the file cannot be written, the copy you had stays and starts again.
- Pinning the portable copy's window now pins the portable file itself, not the temporary copy it runs from, which was deleted when Corvus closed and was different for every version.

### Sync
- Turning sync on with **This computer** no longer fails now and then on a busy or slow computer with "Cannot reach the sync server at http://127.0.0.1:8797": a check Corvus runs every 3 seconds stopped the server while sync was turning on with it. Moving your chain to This computer had the same problem.

### Corvus for mobile
- Settings and the browser's panels show their texts in full: the site panel (what was blocked, blocking on the site, the site's cookie banner), the page menu, Settings → Browser and the rest of Settings wrap long titles and descriptions onto more lines instead of cutting them with "…", which mostly hit the Spanish texts. In landscape and on tablets the panels keep to a centred column, like the screens, so a switch stays near its label.
- Counts say the singular for one: "1 ad or tracker blocked" ("1 anuncio o rastreador bloqueado", read out by TalkBack as "1 anuncios" before), "1 watched", "every hour" for a page checked every 61 to 89 minutes, "Show more (1 left)".
- Your question in an Assist chat is one clean colour: after sending with a keyboard key (a hardware keyboard), Android drew its focus box over it, a lighter rectangle like a selection.
- A slightly smaller Android app: release builds now also remove resources the app never uses.

## v0.30.0

### Settings
- Sync → This computer: the addresses your other devices reach it at are a list, one a line, as `192.168.1.200:8798` with the network adapter after it, instead of running together.
- AI agents → Recent calls shows the latest 5, with Previous and Next to go through the whole log; the agent menu and Only problems (now labelled) still filter it, and Export CSV and Clear are unchanged.
- Command Bar → "What the agent remembers about you": the field looks like the other fields and takes the card's width with Add beside it; Enter adds.
- Every row keeps its label readable: a control that does not fit beside its label (a narrow window, longer Spanish text) goes under it, instead of squeezing the label to a word a line or pushing a button under its field. A field and its button share one height.
- Search shortcuts and Connections (per-container proxies, Add a proxy, Site rules) use the card's full width and wrap cleanly.
- Smaller fixes: status pills no longer break over two lines, "Open …" buttons no longer look like underlined links, "1 hour" instead of "1 hours", Test connection's result wraps as text, and a few untranslated notes are now in Spanish too. The Passwords page pager uses the same shared pager.

### Sync
- **Sync with nothing to set up**: the sync server is now built into Corvus. Turning sync on keeps your data on **This computer** (the default), and your phone and other computers sync with it on the same Wi-Fi (or Tailscale) while Corvus is open there: no Docker, no ports, no server to run. It listens on port 8797 (or the next free one, remembered), answers only devices on private networks, and stores only ciphertext, like the self-hosted server, whose code it is.
- **Your own server** stays the option for syncing from anywhere: enter its address and **Check**. Profiles that already sync with a server keep it, unchanged.
- **Move your chain** between This computer and your own server, both ways: Corvus uploads this computer's data to the new server (end-to-end encrypted, as always) and writes the new address, encrypted, on the old one, so your other devices follow on their own the next time they sync.
- **Pair a device**: the pairing panel shows the QR code for the phone and a code to paste on another computer, says when your phone reached this computer, and **Phone cannot connect?** checks what Corvus can see on Windows (a network set as Public, a firewall rule that blocks Corvus) and opens the page to fix it, with exact steps for the rest (guest Wi-Fi, router isolation, macOS and Linux firewalls). Corvus says beforehand that Windows will ask to let it reach the network.
- The welcome screen's Sync step uses This computer, with "I run my own sync server" for the other case.
- Self-hosting: the README has a short guide with a ready `docker-compose.yml`. The sync server now uses Node's built-in SQLite instead of better-sqlite3 (nothing to compile; existing databases are used as they are).
- Settings → Sync → "Where your data syncs" is a proper list of choices: the radio on the left, the option's name in bold and its description under it, wrapping cleanly in a narrow window. The pairing panel puts its steps under the QR code when the window is narrow.
- Questions from your phone are picked up within about 2 seconds (5 before), and the answer reaches the phone as it is written: its first words at once, then about twice a second.
- The sync server sends its clock with the device list, so a phone whose clock is off from the computer's no longer says "Corvus is not open" on a computer that is open and answering.
- Stopping an answer on the phone stops the computer's search at its next write, and a computer still writing an answer the phone deleted can no longer bring the question back (before, a write that crossed the deletion could win over it, and the answer went on).

### Corvus for mobile
- **Answers write themselves out as they arrive**: while your computer answers, the chat shows the text a moment after it starts writing and writes it out smoothly, with bold and citations as they come, instead of the whole answer at once at the end. Sources and suggested questions follow when it is done. Older Corvus versions on the computer still work (their answers arrive in fewer, larger pieces).
- "Corvus is not open on your computer" no longer shows while it is answering: the chat follows the question closely while it is open, and tells a computer that stopped answering by the phone's own clock.
- Citations [1] [2] are small pills in the line, at text height, instead of tall boxes over the lines around them; tapping one opens its source.
- The keyboard's Send key sends your message in the Assist chat and in "Ask about this page".
- **Stop an answer, or add to your question while it is answered**, as in other AI chats: while your computer answers, the send button turns into a Stop button (a square) as long as the message box is empty. Stop keeps what had come of the answer, marked "Stopped". A message you send meanwhile stops the answer where it is and your computer answers the new message with it, as the next turn of the same conversation, instead of answering both separately. Works with any Corvus version on the computer.
- Deleting a conversation while your computer is still answering it now always stops the answer.
- **Calm when your computer is out of reach**: away from home, or with the computer off, Home says "Your computer is not reachable. Changes are kept and sync when you are on the same Wi-Fi as it" instead of an error. Bookmarks, reading list changes and watches you make meanwhile wait on the phone and sync when it can reach the computer again; the app tries again every 30 seconds while open. Pairing that gets no answer says what to check (same Wi-Fi, computer on with Corvus open, firewall) instead of a timeout.
- **Follows your chain** when it moves to another server, and tries your computer's other addresses (another network adapter, Tailscale) when the usual one does not answer.
- **Cookie banners rejected for you on iPhone too**: as on Android and the desktop, Corvus clicks "Reject all", or unticks every purpose and saves, with DuckDuckGo's Autoconsent rules, and hides a banner it can only hide. The shield's panel says what happened ("Cookie banner rejected (OneTrust)"), "Allow this site's cookie banner" leaves a site's banner to you, and Settings → Browser → "Reject cookie banners" turns it off. On iOS the banner script runs in a world of its own that the page's scripts can neither see nor reach.
- **Third-party licences** in Settings → About: every open-source package in the Android app (the JavaScript packages, the Android libraries and the C++ code inside React Native), with its licence, copyright and full licence text, searchable, in English and Spanish. The list is made by each build from what actually ships in it.
- **Turns with the phone and fills large screens** (Android): the portrait lock is gone, so Corvus works in landscape and on tablets, foldables and desktop windows, as Google Play now asks.
- Smaller, faster Android app: release builds are optimized and obfuscated with R8 (the app's code shrinks to about a quarter, and the APK is about 9 MB smaller), and the status and navigation bar colours that Android 15 ignores are no longer set, which Google Play reported.
- On iPhone, the back button of Browser settings reads "Browser" instead of "browser".
- Fixed: tapping something that opens another screen right as the app starts could close the app.

## v0.29.0

### Corvus for mobile
- **Corvus is now a real browser on your phone**: web pages open in Corvus itself, in tabs, instead of in another browser app. Home has an address bar that opens an address or searches (DuckDuckGo by default; Brave Search, Google or Startpage in Settings → Browser, and until you pick one, the search engine your computers use as their home page), with suggestions from your tabs, bookmarks and history that never leave the phone. Pages have back, forward, reload and stop, a progress bar, share, find in page, a desktop version, and an "Open in…" that hands the page to another browser.
- **Tabs**: open, close and switch them in a grid with each site's icon and title; a link that opens a new window opens a tab next to its page. Your tabs come back after a restart, and your computers list them with your other devices' tabs.
- **Your history, bookmarks and reading list, synced**: pages you visit go to your history on every device (end-to-end encrypted, merged with what your computers recorded), the star in the page menu bookmarks a page or removes the bookmark, and Save to reading list and Watch this page work on the page you are reading. Pages from your Library, your computers' tabs and answers' sources open in Corvus.
- **Ads and trackers blocked** (Android): requests to ad and tracker servers from the filter lists your computers use (EasyList, EasyPrivacy, Peter Lowe's list and uBlock Origin's lists, downloaded once a week) never leave the phone, and elements those lists hide on a site are hidden. The shield in the address bar counts what was blocked on the page; blocking can be turned off for a site there or in the menu, and for everything in Settings → Browser.
- **Cookie banners rejected for you** (Android), as on the desktop: when a page shows a cookie consent banner, Corvus clicks "Reject all" or unticks every purpose and saves, with DuckDuckGo's Autoconsent rules (OneTrust, Cookiebot, Didomi, Sourcepoint, Quantcast, Usercentrics and hundreds more); a banner it can only hide is hidden. The shield's panel says what happened ("Cookie banner rejected (OneTrust)") and how many banners were rejected since Corvus started, and "Allow this site's cookie banner" leaves a site's banner to you. The rules a page gets are picked for its address on the phone, so pages and ad frames do not each read the whole set. Settings → Browser → "Reject cookie banners".
- **Global Privacy Control**: Corvus tells every site not to sell or share your data: `navigator.globalPrivacyControl` is set in every page and frame (Android and iOS), and the `Sec-GPC: 1` header goes with the pages Corvus opens itself (Android's WebView does not let an app add headers to the requests a page makes). Settings → Browser → "Send Global Privacy Control".
- **Ask Corvus about this page**: from the page menu, a chat about the page you are reading opens, with suggested questions (summarize it, its key points, whether the source is reliable). The page's address, title and the start of its text go with your question to your computer, which answers with its AI search in that context, follow-ups included. Send to a computer is one tap away too.
- **As your default browser, Corvus opens links itself** (Android): links from other apps open in a new tab, and going back returns to the app they came from. Settings → Open pages in still lets you pick another browser app instead, with the Open screen as before.
- **Private and safe by default**: no telemetry; sites get no access to the camera or microphone (Corvus refuses and tells you) and no way to call into the app; links to other apps (calls, Play Store, app links) only open after you agree, and only into another app; Google Safe Browsing warns about dangerous pages; third-party cookies are off; and Settings → Browser clears cookies and site data.
- **Assist, a real chat with your computers**: a new Assist tab replaces the Ask Corvus form and the Assist section of the Library. It lists your conversations, newest first and searchable: the ones you started on the phone and your Corvus Assist conversations from the computers, each with its last answer, when, and which computer (or page) it was. A conversation opens as a chat: your messages as bubbles, answers in Markdown (headings, lists, bold, links, code) appearing as the computer writes them, citations you tap to open the source, sources as cards, suggested follow-up questions that send with one tap, and a message box pinned at the bottom that grows as you type. Home has a box that starts a new chat.
- **Follow-up questions in the same conversation**: a question asked in a chat goes with the earlier questions and answers, so "and in winter?" is answered in context. A computer whose Corvus predates this answers it on its own, and the chat says Corvus there needs an update.
- **Pick the computer that answers** from the chat's header ("Demo laptop ▾"), with which ones have Corvus open right now.
- **Clear states while you wait**: "Thinking on Demo laptop…", "Corvus is not open on Demo laptop" (ask another computer or cancel), a computer that has not picked the question up (with the setting to check there), and an error or a stopped answer with Try again. Deleting a chat removes all its questions.
- No more scrollbars on the screens and lists (Home, Assist, Library, Settings, watched pages, pairing): they scroll as before, without the bar on the side.
- **Continue a conversation from your computer**: an Assist conversation from a computer reads in the same chat view; writing below it starts a chat on the phone that quotes it and carries what was said, answered by the computer you pick.
- **Fixed: Wikipedia, Wikivoyage and other Wikimedia pages showed a letter instead of their icon** on Android: icon requests now identify Corvus (Wikimedia refuses the anonymous agent Android's image loader sends), a site without `/favicon.ico` gets its icon from `/apple-touch-icon.png`, `/favicon.png` or its main domain (always from the site itself), what works is remembered per site, and the letter is the site's own ("W" for en.wikipedia.org, not "E").
- **Fixed: pairing with a sync server on your computer's network failed** with "CLEARTEXT communication ... not permitted": the code Corvus 0.28.0 shows for a server on the computer uses a plain `http://` address on your Wi-Fi, which 0.6.0 refused. The app now reaches plain-http sync servers, and its browser opens `http://` sites, marked "Not secure".

### Ad blocker
- **Cookie banners rejected for you**: when a site shows a cookie consent banner, Corvus answers it the way you would if you had the patience: it clicks "Reject all", or opens the banner's settings, unticks every purpose and vendor and saves only what is required. It knows the banners of OneTrust, Cookiebot, Didomi, Quantcast, Sourcepoint, TrustArc, Usercentrics, consentmanager, iubenda and many more (over a thousand rules from DuckDuckGo's Autoconsent, MPL-2.0 like Corvus), also inside the iframes some of them use. Known banners are hidden from the first paint while this happens, and a banner no rule can answer is hidden instead. Settings > Ad & tracker blocker > "Reject cookie banners automatically" (on by default).
- **The shield says what happened**: "Cookie banner rejected (OneTrust)" or "Cookie banner hidden" for the open page, and how many banners were rejected this session.
- **Keep a site's cookie banner**: "Allow cookie banner on this site" in the shield popover leaves that site's banner to you, neither answered nor hidden (the page reloads with it); Settings > Ad & tracker blocker lists these sites.
- **Global Privacy Control**: Corvus tells every site not to sell or share your data, with the `Sec-GPC: 1` header on requests and `navigator.globalPrivacyControl` in every page and frame, a signal sites must honour in places such as California. Settings > Ad & tracker blocker > "Tell sites not to sell or share my data (Global Privacy Control)" (on by default). With the built-in blocker off and an extension that blocks requests installed, the header is left out so the extension keeps filtering; pages still get the signal.
- The cookie notice and annoyance lists now wait for a page's banner to be answered before hiding it (a few seconds at most), since a hidden banner cannot be rejected.

### AI
- **Fixed: AI agents read text the page hides**: a page snapshot could include the text of a hidden part of the page (such as a cookie banner closed by the page or hidden by the cookie notice list), so an agent could think the banner was still there. Hidden parts are now left out, as they already were for buttons and links.

### Assist
- **Questions from Corvus for mobile can be follow-ups**: the computer answers a question from the phone in the context of the earlier questions and answers of its conversation (the AI search gets them with the question, and a short follow-up is searched for together with the previous question), and keeps those answers apart from the same words asked alone.

## v0.28.0

### Sync
- **Pair a phone with a sync server on this computer**: when your sync server setting is `localhost` (for example the server in Docker on this computer), the pairing QR code now carries this computer's address on your network instead, so the phone no longer fails with "Failed to connect to localhost". Your setting stays as it is. Corvus checks that the server answers on that address, and under the code it says the phone must be on the same Wi-Fi, to allow the port in the firewall if the phone cannot connect, to pair again if the computer's address changes, and to use a server on the internet or Tailscale to sync away from home. A menu puts another of the computer's addresses in the code, such as its Tailscale address.
- **Corvus for mobile**: a pairing code from an older Corvus that still points at `localhost` now gets a clear message (update Corvus on the computer, or enter its network address by hand) instead of the raw connection error.

### Corvus for mobile 0.6.0
- **A new look for every screen and form**, on a design system shared with the desktop app: a dark theme tinted with the app icon's indigo and a light theme with the desktop's colors and accent, the desktop's icons, and the Corvus mark on Home. Forms show their labels above the fields, with help and errors under them, and stay in view while you type; lists group their rows with icons, favicons on light tiles (dark ones no longer vanish in dark mode) and dividers; Library's sections are tabs whose labels never squeeze or wrap; buttons, chips and rows are at least 48 dp; the status bar is readable in light mode; and unpairing asks in Corvus's own dialog instead of the system's.
- **Corvus can be your phone's default browser** (Android): choose it in Settings → Default browser (or in the system's Default apps), and every link you open on the phone comes to Corvus first. One tap opens it in your usual browser, which you pick in Settings, or you can send it to one of your computers, save it to the reading list, bookmark it or watch it before you go back to the app it came from. Home offers it once after pairing; "Not now" hides the offer for good.
- **Nothing the app stores goes into Android's cloud backup** any more (the recovery phrase never did): synced tabs, history and the rest stay on the phone and on your own sync server.
- The app no longer asks Android for two permissions it never used: Google's push messages (it has no push service; notifications are worked out on the phone) and Google Play's install referrer.
- **Scanning the pairing code no longer involves Google**: on Android the app now reads the QR code with its own scanner, which decodes the camera image on the phone and sends nothing anywhere. Google ML Kit, which the previous scanner used and which sent Google diagnostic data (device model, app version, an installation identifier), is gone from the app. Pairing works as before: point the camera at the code, or type the details in.
- **Fixed: Home could stay on "Loading…" with the refresh spinner after pairing** (seen with the demo sync server): the first refresh could wait forever on a sync answer that never finished, and every later pull to refresh waited on that same one. Each request to the sync server now gives up after 30 seconds, a refresh that stops making progress ends with an error saying where it stopped, and the next pull to refresh starts a new one.
- What the phone keeps of your synced data is fully saved before a refresh moves on (a file was still being moved into place).

## v0.27.0

### macOS
- **Corvus on the Mac**: the first macOS build, one download (`Corvus-<version>.dmg`) for Apple Silicon and Intel Macs, signed with Parendum's Developer ID and notarized by Apple, so it opens without warnings and updates itself like the Windows and Linux builds.

### Browser
- The ad blocker panel's buttons ("Hide an element…", "Ad blocker settings") no longer spill out of it when their labels are long, as in Spanish: they now sit one per line. Buttons in other panels move to a new line instead of overflowing.
- **Bookmarks that redirect to another site get their icon**: a bookmark whose address takes you somewhere else (an old domain, a short link, a page that moves on by itself) now shows the icon of the page you end up on, on the bookmarks bar and the bookmarks page, instead of a letter or the old site's icon. Corvus learns it when you open the bookmark, and for one you have not opened yet it follows the redirects itself, through your profile's connection and without cookies.
- **Reorder the bookmarks bar by dragging**: drag a bookmark or folder along the bar to move it; a line shows where it will land, and dropping it on the middle of a folder puts it inside, as on the bookmarks page. A spot past the last bookmark that fits puts it there, before the ones under "»".
- **Edit bookmarks from the bar**: Edit… in a bookmark's right-click menu opens a Corvus dialog with its name and address (a folder's, its name) instead of taking you to the bookmarks page. Enter saves, Escape cancels, and an address is completed as on the bookmarks page ("example.com" saves https://example.com/); an empty one is not accepted.
- **Middle-click a folder** on the bookmarks bar to open its bookmarks in background tabs, as in Chrome; with more than 15 it asks first. Open all in a folder's menu asks the same way.
- The bookmarks bar's "»" menu shows each bookmark's site icon (or its letter tile) and the folder icon, as the bar does.

### Downloads
- **You see a download start and finish**: the toolbar's downloads button bounces and rings ripple out from it the moment a download begins, and when one you started finishes, the downloads bubble opens by itself for a few seconds (it stays if you point at it, and never opens over another popover, the address bar or a dialog). The green check stays until you look at it.

### Tabs
- **Closing tabs with the mouse keeps the others in place**: after you close a tab with its close button or a middle click, the remaining tabs keep their width while the pointer stays on the tab strip, so the next close button lands under it; they spread out again when the pointer leaves the strip (as in Chrome and Brave).

### Corvus for mobile 0.5.0
- **Roomier, clearer screens before pairing**: Home shows Corvus's logo and the three steps to pair, numbered, above the Pair button; Library explains what will appear there; Settings groups its cards under section names (Sync, About) and shows the version as a row. Titles, explanations and buttons now have distinct sizes and more space between them, and buttons are taller.
- **Pairing fields you can see**: the server address and recovery phrase fields on the pairing screen now have their own background and border (they blended into the card), with each label right above its field.

## v0.26.1

### Corvus for mobile 0.4.1
- **Fixed: the app closed as soon as it opened** (0.3.0 and 0.4.0). The release build's code shrinking broke the background task service at start-up; release builds are no longer shrunk.
- Also on Google Play for testers (internal testing), signed with the same key as the APK on GitHub, so either one updates the other.

## v0.26.0

### WebScope
- **Save and open sessions**: Session in WebScope's command bar saves the scope, rules and intercept filters to a file, and the captured traffic too if you tick it (it is off by default, since it can hold cookies, tokens and passwords). Opening a session brings them back after a restart or on another computer. Its scope always arrives disarmed, so a file can never put targets in scope on its own: you review it on the Scope tab and arm it yourself.

## v0.25.1

### Browser
- Site icons now show on Corvus's own pages (bookmarks, history and the like) as on the bookmarks bar; in 0.25.0 these pages showed a letter instead.
- **WebScope, tidier**: toolbars group related controls and highlight the filters in use, switches (Intercept, Hold responses, Scope armed, In scope only) light up while on, Repeater and Intercept panes have titled headers, Intercept's Forward and Drop stay pinned under the editor, the Fuzzer's Start attack bar stays in reach while you scroll, Target shows methods as badges, a disarmed scope is flagged in amber, and empty views explain themselves with an icon. The tools work as before.

## v0.25.0

### Browser
- **Corvus's own dialogs**: questions from Corvus (an AI agent that wants to connect, a payment or a saved login to approve, adding or removing an extension, deleting a profile, reopening the session after a crash) and pages' alert() and confirm() now show as a Corvus dialog in the window instead of the system's box. A page's dialog names the site and has "Don't let this page open more dialogs". When an AI agent asks you to do something in a page, it shows as a bar under the toolbar, so the page stays usable.
- **Clear history your way**: Clear history… asks for a time range (last hour, 24 hours, 7 days, 4 weeks or all time) and can keep to what the search shows or to one site, with how many pages will go before you confirm. Days and the whole list have a select-all box.
- **Bookmarks page**: a table (the default) or a grid of tiles; the folder path is clickable and takes dropped bookmarks; dragging shows where an item will land, and dropping on the middle of a folder moves it inside (no key needed). Folders show how many items they hold.
- **Site icons on the bookmarks bar and in Corvus's pages**: bookmarks, history, suggestions and the like show each site's icon instead of a letter. Corvus keeps the icons of the pages you open and fetches a missing one from the site through the profile's own connection (its proxy too); web pages cannot read this store.
- **Bookmarks bar**: bookmarks that do not fit go under a "»" button, and All bookmarks always stays at the end of the bar.
- A link to a Settings section opened in a new page now reaches the section after the page loads.

### Tabs
- **Vertical tabs, redone**: with tabs on the side, the toolbar, the address bar, the bookmarks bar and notices keep the full width at the top as with tabs on top, and the sidebar holds only the tabs (with its collapse button and its draggable edge).

### Passwords
- **KeePass, browsable and editable**: the entries of your unlocked databases show their groups as folders, a search and a compact table a page at a time; a row opens to its password, 2FA code, AI agent options and Edit. Add a new entry or edit one (title, user, password with a generator, address, notes) and Corvus saves it to the .kdbx file, after keeping a .bak copy of it the first time; if another app changed the file meanwhile, Corvus reloads it and asks to try again.

### Downloads
- **Name your packages**: give pasted links a package name and they go into one folder of that name; rename a package in the grabber or in the queue (its folder and the files already in it move along; pause it first if it is downloading).
- **A tidier queue**: each package folds to its header (finished ones start folded), shows its folder, and long packages and long queues show a page at a time.

### AI
- **Assist answers read better**: headings, numbered lists, quotes, tables and code blocks (with a Copy button) show formatted, *italics* and inline code too, and a link in an answer opens in a new tab.
- **Retry and edit in Assist**: the last answer has a Retry button that asks again for a new one, and the pencil next to your last question (or the Up arrow in the empty box) takes it back into the box to change and send again. The panel keeps the width you drag it to, in new windows and after a restart.
- **A cleaner agent runs page**: runs are grouped by day, each with a status dot, the task, a quiet line of details (source, when, tokens, model) and its result as formatted text (lists, bold, links, tables), folded when long; actions show on hover. Steps fold into a compact list with small captures that open full size.

### Import
- Search shortcuts from Brave (and other Chromium browsers) import again: the import failed with "Value is too large to be represented as a JavaScript number" on some profiles.
- Importing a profile again says how many bookmarks were already in Corvus, instead of "0 bookmarks".

## v0.24.0

### AI
- **The agent remembers you**: tell it a lasting fact or preference ("I live in Bilbao", "I always fly economy", "my size is M") and it keeps a short note, so later tasks (and scheduled runs) do not ask again. It saves one when you tell it to; see, add and remove them in Settings → AI. Kept on this device, never secrets, cards, codes or e-mail addresses.
- **Voice dictation**: a microphone button in the Command Bar and in Corvus Assist turns what you say into text, and Ctrl+Shift+K (⌘⇧K on macOS) opens the Command Bar listening, so you can say a task for the agent. Corvus has no speech model of its own: in Settings → Voice dictation, choose any OpenAI-compatible speech-to-text service (OpenAI, Groq or a server of your own) and give it its model and API key. Off until set up; Corvus records only while you dictate.
- **Richer Assist answers**: when an answer has structure, Corvus Assist shows it as a table you can sort, key figures, a side-by-side comparison, a checklist, steps, a small chart, links to open or a short form; what you fill in a form goes back as your next message. The panel draws them itself from checked data (never HTML from the AI), and an answer that cannot be shown that way stays plain text.
- **Assist panel**: every answer has a Copy button (tables and lists come out as Markdown, without the [n] citations); right-click in the panel and in the browser's own fields now gives Cut, Copy, Paste and spelling suggestions; the panel's left edge is easier to grab, drags it up to 960 px wide, and a double-click puts the default width back.

### Browser
- **Background tabs sleep as they should**: a tab opened in the background and never looked at (links opened in the background, a whole bookmarks folder, the tabs an agent opened) now goes to sleep after Settings → Memory's delay too; before, it stayed awake for good.
- **Low on memory, tabs sleep early**: when the computer is short of free memory, the least recently used background tabs go to sleep without waiting for the delay, a few at a time (pinned tabs, tabs playing sound, agent tabs and pages with typed text stay awake).
- **Lighter Assist panel**: closed tabs' conversations are dropped at once, and keeping the conversation history no longer copies every message on each refresh.
- A link to a Settings section (from Corvus Assist, the voice command shortcut) now goes to that section when Settings is already open in a tab; before, it only showed the tab.

### Corvus for mobile 0.4.0
- **Assist conversations on the phone**: Library → Assist lists your conversations with Corvus Assist from your computers, newest first and searchable; tap one to read it and open its page.
- The Home tab's label follows the phone's language.
- Tables, figures and forms in an Assist answer show as their title in the conversation.

## v0.23.0

### AI
- **Scheduled agents work where you can see them**: a scheduled task runs in a folded tab group named after it (with the busy dot while it works) instead of a hidden tab it closed at the end. The tabs it opened stay so you can look at what it found, and its next run replaces them, so they never pile up. When it needs your OK, its group unfolds and the tab comes to the front.

### Sync
- **Assist conversations on all your devices**: the conversation history syncs end to end, so a conversation started on one computer can be carried on from another (the latest 30 messages of each; private windows keep none). Settings → Sync → Assist conversations turns it off on a device. A self-hosted sync server needs this version's server to carry them; an older one simply leaves them out.

## v0.22.0

### AI
- **Several agent tasks at once**: a new task in the Command Bar no longer stops the one running; that one carries on in the background, in its own tab group, and the Command Bar lists it under "Other tasks" (with its state) so one click shows it again. A background task that needs your OK comes to the front by itself.
- **See what the agent did, afterwards**: the agent history (corvus://agent-runs) shows a small capture of the page after each step that changed it; click one to enlarge it. Captures stay on this device, go with their run, and can be turned off in Settings → AI.
- **Every task under way in one place**: the Agents tab of the Assist panel lists the window's agent tasks (the Command Bar's, in front or in the background, and Assist's) with what each is doing, whether it waits for you, "Watch" and "Stop".

## v0.21.1

### AI
- **Agent runs cost far less**: each step now reuses what the model already read from the prompt cache instead of paying for the whole conversation again. With your Claude Code login the transcript goes in as blocks that only grow (measured: the second step read 29,000 of 30,700 tokens from the cache, where before every step wrote all of them at a higher price); with an API key the conversation carries a cache breakpoint. Steps also start sooner. Assist's usage line says how many tokens came from the cache, and the token budget of a run counts those at their price (a tenth), so long research tasks are not cut short.
- **Faster agent steps with your Claude Code login**: one Claude Code process serves the whole run and each step sends it only the new results, instead of starting Claude Code again and handing it the whole conversation (measured: a step's reply in 1.6 s instead of 3.1 s).

## v0.21.0

### AI
- **The agent's steps in your language**: the step lines in Assist and in the run history ("Opened skyscanner.es", "Typed "Lisboa" into "Destination"") follow the interface language.
- **Tabs left open for you**: when a run ends, Assist (under its answer) and the Command Bar list the tabs the agent kept open; one click brings each one back. The Command Bar shows the same readable step lines as Assist.
- **The agent's tab group shows it is at work**: a pulsing dot before the group's name while the agent works in those tabs, gone when it finishes.
- **Take over from the agent**: click or type in a tab the agent is working in and it stops before its next step; "Hand it back" in Assist or the Command Bar lets it carry on, and it reads the page again first, since you may have changed it.
- **Watch the agent from another tab**: when you go to one of your own tabs while the agent works, the Assist panel shows its tab live (refreshed every few seconds) with its latest step, "Watch" and "Stop", and the agent no longer pulls its tabs to the front until you come back to them.
- **Assist keeps your conversations**: the clock button on the page line of the Assist panel lists them, newest first, with the page each was on; search them, and open one to carry on where you left it (on that page). "New conversation" starts afresh and keeps the last one in the history. Private windows keep none. The tabs an agent left open reopen from a past conversation too.

### Browser
- **Fewer toolbar buttons**: the AI agents indicator is gone. The gear next to the Assist panel's close button opens the AI settings (or the AI agents settings from the Agents tab), and the Assist button says when AI agents can connect.

## v0.20.2

### AI
- **You watch the agent browse**: for anything on the web (comparing prices, looking up flights, checking stock) the Command Bar agent and Assist open the sites in their own tabs and use them as you would, instead of answering from search snippets. Those tabs share one tab group named after the task; the agent moves between them, closes the ones that led nowhere, and leaves the useful ones open for you when it finishes. Assist keeps your current page as it was.

### Browser
- **Corvus's pages look tidier**: History, Bookmarks, Downloads, Passwords, Settings and the rest sit centered in wide windows instead of against the left edge; text, buttons and fields inside their cards have their margins; Find in my pages has its search box in the page; folders in the Bookmarks sidebar highlight across the whole row; a field and its button are the same height; "Bookmarks bar" and "Other bookmarks" follow the interface language.
- **A check on the downloads button** when a download finishes, until you open the downloads bubble or page, so a finished download is noticed without a pop-up.
- **The toolbar shows the proxy** a tab goes through (its profile's, its container's, or a site rule's); clicking it switches the connection of that container or profile, or opens Settings → Connections.
- **Detect links I copy** is on for new installs (the toolbar then offers the download links you copy). Only download links are looked at, and nothing else of what you copy is kept.

### Import
- **Bookmarks land where they were**: another browser's bookmarks bar goes onto Corvus's bar and the rest into Other bookmarks, instead of an "Imported from …" folder. Importing again adds only what is new: folders merge by name and a page already in its folder is skipped.
- **Chrome signed in to a Google account** without full sync: that account's bookmarks are imported too (they showed as 0 before).

### Fixes
- **Reload did nothing** on a page a form had sent (often the page after a "checking your browser" step): the button and F5 now open the address again, as Enter in the address bar does.

## v0.20.1

### Fixes
- **Tabs stayed blank when Corvus started** (0.20.0, seen on Windows): every tab waited for a proxy change Corvus did not need to make. Without a proxy set up, tabs load at once again, and a proxy change never holds tabs for more than a few seconds.

### Browser
- **Tabs reach the top of the screen** in a maximized or full-screen window, so the pointer pushed against the top edge still lands on a tab.

## v0.20.0

### Privacy & connections
- **Private windows** (menu → New private window, Ctrl+Shift+N, or a link's menu → Open link in private window): cookies, storage and cache live in memory only and go when the last private window closes; no history, no place in the saved session, the synced open tabs or "Find in my pages". Their downloads are listed while they are open and never saved to the list (the files stay). Extensions do not run in them and AI agents do not see them. They connect like their profile (its proxy too). The toolbar says **Private**, and so does the New Tab page.
- **Proxies** (Settings → Connections): send a profile through an HTTP, HTTPS, SOCKS4, SOCKS5 or PAC proxy, and each container through a different one. Proxies that ask for a sign-in get it from Corvus (the password is encrypted with the system keychain). **Site rules** send some sites another way (`*.example.com` direct, or through another proxy). A proxy that stops answering makes its pages fail instead of going out through your own connection, and WebRTC stays on the proxy so sites cannot see your real address. Downloads and extensions go the same way; sync, updates and AI services keep using the computer's connection. **Test** tries a proxy on its own, and **Check connection** shows the address sites see (it asks Cloudflare, only when you click it).

## v0.19.0

### Downloads
- **File hosts download in the background**: links to MEGA, MediaFire, Google Drive, Dropbox, OneDrive, WeTransfer, Gofile, Pixeldrain, Yandex Disk, SourceForge, 1fichier, KrakenFiles, SendSpace, Solidfiles, BuzzHeavier and the hosts built on XFileSharing (Send.cm, Katfile, DDownload and others) no longer open tabs: the download queue finds the file behind each page and downloads it with the rest of the package, with its progress in corvus://downloads. Folder links (MEGA, MediaFire, Google Drive, Gofile, Pixeldrain lists, OneDrive) become their files, in a package named after the folder. MEGA files are decrypted as they arrive, and the parts of a large one can come in parallel.
- **Waits and limits**: when a host asks to wait (a countdown, a free-download limit, MEGA's transfer quota, "busy, retry later"), the file waits in the queue with the time left and starts again on its own. Free hosts get one file at a time.
- **When a host needs you**: a CAPTCHA, a sign-in, a password or a premium-only file puts the file on **Needs you** with the reason; **Open page** opens its page, and what you download there lands in that file's place in the queue. A notification tells you when Corvus is in the background. Sites you are signed in to (premium accounts) work as in the browser. Corvus never solves CAPTCHAs.
- **Any page, from its menu**: right-click a link and choose **Add link to download queue** (Corvus finds the file on the page it leads to), or right-click a selection and choose **Grab download links in selection**. Shorteners that lead to a known host are followed.
- **Copied links**: the toolbar offer for copied download links has **Download** (straight to the queue), and the link grabber has **Detect links I copy** to turn it on or off where you use it.
- **The toolbar's downloads button** shows the queue too: its progress, the files left, and the ones that need you.
- Fixed: a file host's page named like an archive part (`….part1.rar.html`) was downloaded as if it were the archive.

### Extensions
- **`chrome.bookmarks` and `chrome.history`**: extensions that ask for them (bookmark and history managers, tab savers) now work in Corvus, over the profile's own bookmarks and history, with Chrome's events for changes made anywhere (by you, by sync or by an extension). Extensions may bookmark or add web and file addresses only, never `javascript:` bookmarklets.
- **`chrome.tabGroups` and `chrome.tabs.group` / `ungroup`**: tab managers can group, name, color, collapse and move Corvus's tab groups and hear about their changes. Groups keep Chrome's colors.
- **`chrome.sessions`**: recently closed tabs (restore reopens them where they were) and the tabs open on your other devices when sync is on.
- **`chrome.sidePanel`**: an extension's side panel (Bitwarden, AI sidebars, notes) docks on the right of the window under a bar with its name and ✕; its toolbar button opens and closes it when the extension asks for that.
- **Extension keyboard shortcuts** (`chrome.commands`): the shortcuts an extension suggests work in Corvus (its toolbar button for `_execute_action`, `onCommand` for the rest), unless Corvus already uses that key; `commands.getAll` says which ones work.
- **`chrome.downloads`**: download managers and "save all" extensions now work: what they start lands in your downloads list and folder (under the name they suggest, never outside the folder), and they can pause, resume, cancel, search and clear downloads and hear about them. A program an extension asks for waits for you, like one an agent asks for, and extensions never open programs.
- **`chrome.topSites`** answers with your most visited sites (it failed before).
- Extensions that ask for `search` now see it as missing (and the extension card lists it) instead of finding an API that never answered.

## v0.18.0

### Faster and smaller
- **Starts sooner**: the browser window is ready about a fifth sooner (about 0.35 s on the test machine). The app no longer builds its self-test data on every start (a 20 MB buffer), and the MCP server, the Anthropic SDK and the self-test code load only when they are needed.
- **Smaller downloads**: about 20 % smaller installers (Linux: AppImage 164 → 130 MB, deb 129 → 103 MB). The PDF viewer's library is built into the viewer instead of shipping a second copy with native canvas binaries it never used (and that were Linux binaries even in the Windows build).
- `CORVUS_STARTUP_PROBE=1` prints how long a start took and quits, for measuring.

### AI agents in other apps (MCP)
- **Activity log**: Settings → AI agents keeps which tool each agent called, on which site, how it ended (with the tool's own error message) and how long it took, for 30 days on this device: per tool over the last 24 hours, then the latest calls filtered by agent or to the ones that failed, with **Export CSV** and **Clear**. Never what an agent typed or what pages said. On by default; **Keep an activity log** turns it off.
- **Rate limit**: choose how many tool calls each connected agent may make (Strict: 1 a second, bursts of 10; Standard: 5 a second, bursts of 30, as before; Relaxed: 20 a second, bursts of 100). Calls over the limit show in the log, with a notice when there were any in the last day.

### Command Bar
- **Recent**: tasks you gave the agent and searches and addresses you typed in the Command Bar show under **Recent** when it opens empty. A task comes back as "> task" to read or change before Enter runs it again; × removes an entry. Settings → Command Bar agent → **Remember what you run** (on by default, per device) and **Clear**.

### Sync
- **Command Bar history** syncs end to end (Settings → Sync → **Sync Command Bar history**, on by default, per device; new collection `command_history`: self-hosted sync servers need this release's server, an older one keeps the history on each device).
- **Changes replaced by another device**: when you change a bookmark, a setting, a reading-list item, a watched page, a workspace or an annotation here while another device changes it too, the other device's newer change is used everywhere as before, but your version is no longer lost: Settings → Sync lists it next to the one in use, with **Use this device's version** (it syncs as a new change and wins) or **Keep the one in use**. Saved logins are left out (no passwords are kept outside the vault).

## v0.17.0

### Browser
- **Saved logins under the login field**: clicking a page's username or password field lists the logins saved for the site right under it, as other browsers do; picking one fills the form. The key button in the address bar still works as before.
- **The whole interface in Spanish**: with Settings → Language in Spanish (or a Spanish system), the browser bar, its popovers and the command bar, every Corvus page and its tab title, Assist, the reader and the native dialogs (agent approvals, spend and download prompts, crash recovery) are in Spanish too, not only Settings, the New Tab page and the menus.

## v0.16.0

### AI agents in other apps (MCP)
- **Every connector tool now works in Corvus**: the desktop controller implements the capabilities the MCP server registers tools for, so agents get screenshots of the viewport, one element or the full page (CSS-sized for the coordinate tools), element boxes and same-origin frames in `page_snapshot` (cross-origin frames listed as `frame`), `find`, `get_text`, `extract`, `get_html`, `wait_for`, `tab_wait_load`, `click_at`, `double_click_at`, `right_click_at`, `hover_at`, `drag`, `press_keys`, `type_text`, `scroll_at`, `hover`, `focus`, `check`, `select_option`, `fill_form`, `fill_fields`, `zoom`, `set_viewport` and, with Full access, `upload_file` (absolute paths, no programs, up to 20 files and 200 MB), `pdf` and `downloads_list`.
- **`request_user_action`**: the agent hands a step to the person (sign-in, a code) in a native Done/Cancel prompt next to the tab it brings forward.
- **`handle_dialog`**: an `alert`/`confirm` in a tab an agent works in shows in `page_snapshot`; other actions on that tab are refused until it is answered, by the agent or by the person in the native box (which closes either way). Corvus answers `prompt()` with Cancel, as before.
- **Spend gate**: clicks at coordinates, Enter/Space, line breaks typed into a field and accepting a page question that spends money (an amount, a purchase word, or a checkout page) ask the person in the same **Allow once / Deny** dialog; a click inside a payment iframe always asks.


## v0.15.0

### Your phone
- **Answer questions from Corvus on your phone**: questions asked in Corvus for mobile go to this computer, which answers them with Corvus's AI search and its own AI provider and writes the answer back as it streams in, with its sources and follow-up questions. Settings → Send to your phone → **Answer questions from Corvus on your phone** (on by default, per computer). Corvus has to be open; it looks for new questions every 5 seconds.
- **Send a page straight to your phone**: "Send to your phone…" in a tab's or a link's menu has a button for each phone paired with this profile's sync. The page shows on the phone's home screen.
- **Sync server**: the server now accepts questions from the phone (collection `asks`). If you host your own, update it; an older server refuses them and the phone says so.

### Browser
- **Search shortcuts**: a keyword and a space in the address bar search a site with the rest ("yt cats" searches YouTube); the first suggestion says which site. **Settings → Search shortcuts** adds or removes them; they travel with profile exports.
- **Import from another browser** brings search shortcuts too (Chromium's own site searches, Firefox's engines with an alias and its bookmark keywords) and lists each profile's extensions: the Chrome Web Store ones with **Add to Corvus**, Firefox's add-ons with a Web Store search.

## v0.14.0

### Browser
- **Default browser**: while Corvus is not your default browser, a bar under the toolbar offers **Make default** once per launch (**Not now**, **Don't ask again**), and **Settings → Default browser** shows where it stands. On Windows, Corvus adds itself to Default apps for links, web pages and PDFs and opens Default apps on Corvus, where you choose **Set default**; the uninstaller removes it. On Linux it sets itself with xdg-settings; on macOS the system asks you.
- **Open files with Corvus**: web pages (.html, .htm, .xhtml, .shtml), SVG and WebP images and PDFs you open from your files, and links from other apps, open in Corvus (PDFs in its viewer).
- **Import from another browser**: **Settings → Import** (and the welcome screen) finds Chrome, Edge, Brave, Vivaldi, Opera, Opera GX, Chromium and Firefox on this computer, lists each profile with how many bookmarks, history pages and open tabs it holds, and brings the kinds you pick into Corvus: bookmarks keep their folders, history merges with yours, and each open window becomes a workspace with its pinned tabs and tab groups. The other browser's files are only read, from copies, never changed.
- **Passwords from a CSV**: export your logins to a CSV in the other browser and pick it under **Settings → Import**; Corvus adds the ones it does not already have to its password manager. The file is plain text, so delete it when you are done.

### Downloads
- **Download with AI**: in corvus://downloads → Link grabber, **With AI** on a package; **AI** on the copied-links button in the toolbar; or right-click a tab and choose **Download with AI**. Corvus's agent opens the file-host pages and mirrors, uses their free download buttons, and hands the real file links (every volume of a split archive, with the archive password) to the download queue. The Command Bar always shows you the list of files first, and nothing downloads until you approve it. Programs are never downloaded for an agent.
- **When a file host needs you**: if a host shows a CAPTCHA, asks you to sign in or offers the file only to premium accounts, the agent stops on that file and asks you to deal with it in its tab; when you click Done it carries on with the rest. If Corvus is in the background, a notification tells you.
- **Who added it**: packages an AI agent queued say so in the queue.

### AI agents (MCP)
- **Download queue tools** (Full access): `download_queue` lists packages with their progress, checksums and extraction; `download_queue_add` queues files by direct link with a package name and password, after you allow it in a browser dialog; `download_queue_control` pauses, resumes, retries, removes or extracts a package or file. A file the server names as a program fails instead of downloading.

### Ad blocker
- **YouTube ads stay out**: hover previews on the home page and swiping Shorts could be taken for YouTube refusing to play without its ads, which made Corvus skip YouTube's ads for 24 hours instead of removing them. Only a real playback loop on a video's page counts now, the fallback lasts 2 hours, one left by 0.13.0 is dropped, and the shield on YouTube has **Remove them again**. The ad skipper also finds YouTube's newer skip buttons.

### Search
- The rating circle next to each result kept its shape while rating instead of stretching into an oval.

## v0.13.0

### Downloads
- **Link grabber**: right-click a tab and choose **Grab download links**, or paste a whole post in corvus://downloads → Link grabber. Corvus keeps the links to files, to file hosters and to the volumes of split archives, groups the volumes of one archive into a package in order (`.part1.rar`, `.r00`, `.7z.001`, `.z01`, `.001`), and keeps the archive password written next to them ("Password: …", "Contraseña: …"). With **Settings → Downloads → Offer copied download links** on, links you copy show up as a button in the toolbar.
- **Download queue**: packages download into their own folder, a few files at a time and at most two per site, through your own session (sites you are signed in to work). Pause, resume, retry, remove and reorder; a paused or interrupted file resumes where it stopped, failures retry on their own, and the queue survives a restart. corvus://downloads shows each package's progress, speed and time left.
- **Parallel connections**: a file of 16 MB or more on a server that supports it downloads over up to four connections at once (Settings → Downloads, 1 to 8), and each part resumes where it stopped after a pause, a failure or a restart.
- **Checksums**: when a package is complete, files listed in its `.sfv`, `.md5`, `.sha1` or `.sha256` are checked; a file that does not match is marked failed with both hashes, and retrying downloads it again from the start.
- **Extracting archives**: when a package is complete, Corvus joins split files (`.001`, `.002`, …) and extracts RAR, 7z and ZIP archives, multi-part ones too, into the package's folder, in the background. It tries the password found next to the links, then the package and archive names, then your list in **Settings → Downloads → Archive passwords**; when none opens it, the package asks you for one, and a password you type that works is added to the list. Optionally, the archives are deleted once extracted (**Delete archives after extracting**).

### Browser
- **Menus in Spanish**: the app, tab, group, profile, bookmarks and page menus follow the interface language.
- **Sites behind Cloudflare**: Corvus sends one consistent browser identity on every request (Chromium's user agent and client hints on navigations too), so sites stop challenging every visit and accept you once you pass the check. With the built-in blocker off, an installed extension that blocks requests (such as uBlock Origin Lite) keeps blocking; navigations then go out without the client hints.
- **window.open**: pages that open a tab and then write into it or post a form to it now work, as in any browser.
- **Easier tab closing**: the tab close button is twice as big.

### Claude Code plugin
- The connector's guide explains how to turn on auto-update for the Corvus marketplace, so the plugin updates on its own.

## v0.12.0

### Reading list
- **Read state**: corvus://reading has Mark read / Mark unread, synced with your other devices and the Corvus mobile app.
- **Links saved on your phone**: a link saved to the reading list from the mobile app arrives without its article; Corvus fetches the page (public addresses only, without your cookies) and keeps the reader-mode article, which then syncs back to the phone.

### Sync
- **Watched pages on your phone**: Corvus publishes what its page monitor last saw of each watched page (last check and change, the change summary, whether your "Notify me when…" condition holds), so the mobile app can show it. Watches added on the phone are monitored here.
- **Sync server**: the server now accepts that status (collection `watch_status`). If you host your own, update it; an older server simply leaves it out.

## v0.11.0

### Sync
- **Pair a phone**: Settings > Sync has "Pair a phone". After a confirmation it shows a QR code with your sync server's address and your recovery phrase for the Corvus mobile app to scan (it hides itself after two minutes). It warns when the server address is one a phone cannot reach, such as `localhost`.
- **Pages from your phone**: pages sent from the Corvus mobile app open as background tabs on the computer they were sent to, with a notification, usually within a minute while Corvus is running. Corvus looks for them with one small request every 30 seconds between syncs.
- **Sync server**: the server now accepts pages sent between devices (collection `sent_tabs`). If you host your own, update it; the phone tells you when the server is too old to send pages.

### Updates
- The beta channel now finds desktop releases past Corvus for mobile releases, which share the same GitHub repo (tags `mobile-v…`).

## v0.10.0

### Browser
- **Send to your phone**: "Send to your phone…" in a tab's menu (and "Send link to your phone…" in a link's menu) shows the page as a QR code to scan with your phone's camera. Link your own Telegram bot in Settings > Send to your phone to send pages there too, and to open the links you send to it from your phone; messages from anyone else are ignored.
- **Move a profile**: Settings > Profiles can export a profile to one password-protected file (bookmarks, history, reading list, annotations, workspaces, site settings, containers, watched pages, workflows and saved logins) and import it on another computer as a new profile.

### AI
- **Local models, found for you**: Settings > AI search notices Ollama, LM Studio or llama.cpp running on this computer and offers to use it in one click, so AI search and Corvus Assist stay on the device with no API key. With a local model, the model field lists the server's models.

## v0.9.0

### Corvus Assist
- **Write with Corvus AI in any text field**: right-click a page's text field to fix spelling and grammar, make the text shorter or longer, more formal or friendlier, translate it, or choose "Write…" and say what to write. The text appears in the Assist panel and goes into the field only when you click "Insert into the field" (Ctrl+Z undoes it). Password, one-time-code and card fields are never read.
- **Compare tabs**: "Compare tabs with Corvus AI…" in a tab's menu lets you pick two to six of the window's pages and say what matters ("battery and price"). Corvus reads each one, even tabs that are asleep, and answers with a table, one column per page, and a verdict. "Copy table" copies it as Markdown.

### Browser
- **Watched pages that notify on a condition**: give a watch in corvus://watches a condition in your own words ("the price is under 150 €", "it is back in stock") and Corvus tells you only when it comes true, with the fact that decided it, instead of on every change.

## v0.8.0

### Browser
- **Containers**: tabs in a container keep their own cookies and site data, so you can be signed in to two accounts of one site, or keep shopping and banking apart from everything else. Personal, Work, Shopping and Banking are there to start with (Settings > Containers adds, renames, recolours and removes them). Open one from the menu (New container tab), a link's menu (Open link in container tab) or a tab's menu (Reopen in container); pages a container tab opens stay in it. A container tab shows a line in the container's colour under its icon and the container's name in the address bar. Extensions do not run in container tabs.
- **Split view of up to four tabs**: two side by side, one beside two stacked, or a 2x2 grid, with both dividers to drag. "Add to split" and "Remove from split" are in a tab's menu.
- **A split waits while you look elsewhere**: showing a tab outside the split no longer ends it; showing any of its tabs brings the whole split back.
- **Automatic picture-in-picture**: when you switch away from a tab whose video is playing with sound, the video keeps playing in a small floating window, and returns to the page when you come back. Settings > Media turns it off.

## v0.7.0

### Privacy
- **Fingerprinting protection**: sites that read your canvas, graphics card, audio stack, CPU count or device memory to recognise you get slightly different values on each site and each session, so those readings no longer follow you from site to site. It is on by default (Settings > Ad & tracker blocker > "Block fingerprinting"), and sites you allow are left alone.
- **Forget a site when you close it**: "Forget this site when I close it" in the shield popover deletes that site's cookies, local storage, IndexedDB, caches and service workers once its last tab closes. Settings > Ad & tracker blocker lists these sites.

### Passwords
- **Password checkup**: corvus://passwords checks your saved passwords (and unlocked KeePass databases) for ones that appear in known data breaches, that you reuse or that are easy to guess, and marks each login "In N breaches", "Reused" or "Weak". The breach check runs when you ask and uses k-anonymity: only the first 5 characters of each password's SHA-1 hash are sent to Have I Been Pwned, and the match happens on your device.

### Performance
- **No more freeze when the ad blocker updates**: its filter lists are now parsed in a separate process, so the weekly update no longer stalls tabs and typing for a moment.

## v0.6.0

### Browser
- **Hide anything on a page**: right-click > "Hide this element…" (or "Hide an element…" in the shield popover) and pick it: a click chooses it, "Wider" or Up takes the element around it, Enter hides it. It stays hidden on that site, as a rule in your own filter list.
- **Your own filters**: Settings > Ad & tracker blocker > "My filters" lists your rules in uBlock Origin syntax, including every element you hid; edit them or add your own.
- **Sleeping tabs**: a background tab you have not looked at for an hour (Settings > Memory) goes to sleep and gives its memory back; it comes back where it was, with its history and what you typed in forms, when you return. Pinned tabs, tabs playing sound, tabs an AI agent uses and pages where you typed stay awake. "Sleep to save memory" in the tab menu puts one to sleep now, and hovering a tab shows the memory it uses.

### Corvus Assist
- **YouTube videos**: on a YouTube video, Summarize and Ask read what is said in it (its captions) instead of the page around it, and every point cites the moment it comes from: "▶ 1:10" plays the video from there.

## v0.5.0

### Browser
- **Translate pages**: a page written in another language shows a translate button in the address bar. One click translates the whole page in place, as you watch, with your AI provider; a second click shows the original. Choose the language in Settings > AI ("Translate pages into"), or turn the offer off. "Translate this page" in the right-click menu works on any page.
- **No more cookie notices**: the blocker hides cookie consent banners, newsletter pop-ups, app banners and similar clutter with the EasyList Cookie and uBlock Origin annoyances lists. Settings > Ad & tracker blocker > "Hide cookie notices and annoyances" (on by default).
- **Links without tracking**: pages open without their tracking parameters (utm_*, fbclid, gclid, msclkid and similar); the rest of the address stays exactly as it was. Settings > Ad & tracker blocker > "Remove tracking from links" (on by default).
- **The portable build updates itself**: from this version on, Corvus-Portable checks for updates like the installed app, downloads the next portable copy next to itself, verifies it against the release checksums and replaces itself when you restart. Coming from 0.4.2 or earlier, download this portable copy by hand once.

## v0.4.2

### Browser
- **YouTube keeps playing**: when signed in, YouTube can refuse to play a video whose ads were removed, restarting it over and over ("Experiencing interruptions?"). Corvus now notices that loop within seconds and switches YouTube to skipping its ads instead: they load, play muted at top speed, jump to their end and are skipped, and the video plays. It stays that way for a day, then the lists get another try. The shield popover tells you when this is on.
- Ads that still reach the YouTube player in normal mode are skipped the same way.
- "Add tab to new group" keeps the caret in the group's name.

## v0.4.1

### Browser
- **YouTube without ads**: the ad blocker now uses the lists uBlock Origin uses (its own filters and quick fixes, EasyList, EasyPrivacy and more), and runs their page scripts before the page's own, so YouTube videos start without video ads and the side ads are gone. Stand-ins for blocked scripts load as intended instead of failing, so video players keep working.
- **Bookmark by dragging the lock**: drag the site icon at the left of the address bar onto the bookmarks bar to bookmark the page with the tab's title, right where you drop it. Links dragged from a page onto the bar are bookmarked too.
- **Name a new group right away**: "Add tab to new group" opens the group's name editor at once.
- A click anywhere outside an open popover (also on the toolbar or the tabs) closes it, and the password panel of the address bar no longer opens behind the page.
- Tabs keep their site's icon while you browse within the site, and fall back to the site's `/favicon.ico` when the page's icon fails to load.
- The NASA background now comes from NASA's Image of the Day (the APOD service stopped working).

## v0.4.0

### Browser
- **The New Tab page is now a dashboard you can arrange**: press **Customize** to drag widgets, resize them from the corner, open their settings or remove them, add new ones from a gallery, undo, or go back to the original page. Out of the box it looks like before (greeting, search, shortcuts), so nothing changes until you customize.
- **Shortcuts you control**: add a shortcut by hand, edit its name and address, remove it (or hide one of your most visited sites), and drag tiles to reorder them.
- **Backgrounds**: the default grey, a color (swatches or any color), a picture of your own (kept on the device) or a daily picture from Bing, Wikimedia Commons, NASA or Lorem Picsum, with darken and blur. Text on the background stays readable.
- **Built-in widgets**: greeting, search box, shortcuts, a digital or analog clock with other time zones, and notes that save as you type.
- **Custom widgets for anything**: a custom widget draws its own HTML, CSS and JavaScript and reads the data sources you give it: any public address (JSON or text), an RSS or Atom feed, a site you are signed in to (its unread count and the text of a part of the page, only after you allow that site for that widget), or Corvus's own watched pages and most visited sites. The gallery starts you off with crypto prices, stock quotes, weather, a news feed, watched pages and unread counts; edit their sources and code, or write one from scratch.
- **Widgets run isolated**: no network, cookies, storage or access to the page; they only get the data Corvus reads for them, links open only on the hosts they declared, and widgets holding private data cannot load images from the web.

### For AI agents
- **Build the New Tab page over MCP**: `newtab_layout`, `newtab_add_widget`, `newtab_custom_widget`, `newtab_update_widget`, `newtab_remove_widget`, `newtab_set_background` and `newtab_undo`. Ask an agent for the dashboard you want and it builds it in Corvus's look; the page updates live, every change can be undone, and an agent can never allow a widget to read a site with your session: you do that on the page.
- **The Command Bar agent and Assist build widgets too**: ask them "add a widget with ..." and they use the same New Tab tools, no tab needed.

## v0.3.4

### For AI agents
- **Choose the Claude Code account Corvus uses**: with the Claude Code CLI provider, Settings > AI search > Claude Code account runs the CLI with your default login, a config folder of your choice (`CLAUDE_CONFIG_DIR`), or the account of the Claude Code session that drives Corvus over MCP. The connector reports that session's config folder when it connects, so tools that keep several accounts in separate folders work without extra setup, and a switch of account is picked up when the session reconnects. Only approved local clients, and only folders that exist.
- **Environment variables for the Claude Code CLI**: an optional list of `NAME=value` lines added to the CLI process (proxy, base URL and so on). Kept on the device, never synced.

### Browser
- **Command bar and address bar suggestions keep your selection**: a list that opened under a resting mouse pointer selected the row under it, so Enter could run another command or open a suggestion instead of what you typed. Hover now selects only when the pointer moves.

## v0.3.3

### For AI agents
- **Agents start Corvus when they need it**: the Claude Code plugin and the MCP connector use Corvus if it is running, and otherwise start it in a normal, visible window with its MCP server on (`--enable-mcp`, which also turns the server on in a Corvus that is already open). The first connection still asks you to approve the client. Corvus records where it runs from in `~/.corvus/app.json`, so the portable build and AppImage are found too; `CORVUS_BIN` overrides it and `CORVUS_MCP_NO_LAUNCH=1` turns starting off.
- **MCP connections survive a browser restart**: after Corvus restarted or dropped the session, every call failed with "Session not found" until the client reconnected by hand. The connector now finds Corvus again, opens a new session and retries the call.
- **Claude Code CLI provider on Windows**: a `.cmd` wrapper (npm's `claude.cmd`, or an account switcher such as `ccm`) set as the CLI path failed with "Claude Code CLI not found". Corvus now looks the command up on PATH like a terminal and runs batch wrappers through cmd.exe.

### Browser
- **Home button**: a house next to reload (Alt+Home, Ctrl+click or middle-click for a new tab) goes to Corvus's New Tab page with Corvus search, or to Google, Bing, DuckDuckGo, Yahoo, Ecosia, Brave Search, Startpage or an address of your own (Settings > Appearance > Home page).
- **Settings in English or Spanish**: Settings > Appearance > Language (System, English, Español) switches the settings page and the menu of Corvus pages at once; System follows the operating system language. Other Corvus pages stay in English for now.
- **Signing in to Google works**: Google refused the sign-in ("This browser or app may not be secure"). Corvus now tells Google's sign-in page that it is an Electron browser, which gets the sign-in flow for embedded browsers; every other site still sees a regular Chrome user agent.
- **No more security-key prompts out of nowhere**: on Windows, sites that try a passkey (Google does at every sign-in) opened the system "use your security key" dialog. Passkeys and security keys are now off by default; turn them on in Settings > Passwords > Passkeys and security keys.
- **Search results are easier to read**: a cleaner layout with an AI relevance ring per result, high-contrast titles, the AI summary set apart from the page snippet, snippets cut at three lines, cited sources as cards under the answer, and no empty rating column when the AI answer is off or fails.
- **Settings side menu**: its links no longer squeeze together in short windows, its scrollbar only shows on hover, and jumping to a section lands it below the search box instead of under it.

## v0.3.2

### For AI agents
- **The side panel assistant now acts, not just reads**: ask it to do something ("open my issues and summarize the ones assigned to me", "fill this form with…", "go to the next page and compare") and it works in your current tab: it navigates, clicks, types, scrolls, opens tabs and searches the web, then answers in the same chat. Each step shows as one line in the panel, approvals (Approve / Skip / Stop) appear inline, and follow-ups like "now do the same for the next one" work because the conversation carries the steps taken. Plain questions about the page still answer directly. Runs appear on `corvus://agent-runs` labelled Assist.
- **Visual browsing**: screenshots now reach the model as images (Claude Code CLI, Anthropic API, and local models that report vision), and agents can click, hover, scroll, press keys and type by position for canvas apps, maps and custom widgets. Position-based actions check what is under the point first, so "Buy now" and payment buttons still always ask.
- **Claude Code CLI provider**: Corvus's own instructions (site profiles, Assist rules, saved logins, workflows) now reach the CLI; before, they were dropped.
- **MCP: `console_messages` and `network_requests` work**: they failed with "not supported by this browser build". Corvus now records a tab's console and network requests from the first time an agent acts in it (status, type, size, timing, failures and blocked requests). Anything sent with, or right after, a saved password or 2FA code Corvus filled is hidden from the log.
- **MCP clients only see tools Corvus can run**: tools that this build does not implement yet (`find`, `wait_for`, `get_text`, `click_at` and others) are no longer offered, so agents stop calling tools that always fail.

### Browser
- **New tab puts the caret in the address bar**, for Ctrl+T, the + button, the Command Bar and a new window's first tab, so you can type right away.
- **Dark theme no longer darkens pages without a background** (for example boe.es): web pages are painted on a white base like in Chrome; only Corvus pages follow the theme.
- **Simpler workspaces**: clicking a workspace opens it as one tab group in the current window (or focuses that group if it is already open). Replace, Merge and open-in-new-window are gone. Right-click a group to "Save group as workspace" or "Update workspace"; the save button says how many tabs it saves, and delete asks first.
- **WebScope**: turning it off while tabs are still loading no longer fills the crash log with "target closed while handling command" errors.

## v0.3.1

### For AI agents
- **Spending money always asks, even in auto mode and for MCP clients**: a click on "Buy now", "Place order", "Pay" and the like (also in Spanish, Estonian and other common languages), or Enter in a checkout or payment form, now asks you every time, whatever "Ask before risky actions" says. Scheduled agents stop at that step until you answer, and saved workflows ask too. MCP clients get an "Allow once / Deny" dialog at every access level (click, type with submit, fill_fields and run_flow steps); Deny tells the agent you declined. Adding to a cart, a "Books" link or "Order history" do not ask. Settings now says exactly what auto mode does.

## v0.3.0

### Before you update
- **Update every device.** Saved logins can now carry a 2FA secret. If you edit a synced login on a device still running Corvus 0.2.0, that device saves the login without its 2FA secret and sync removes the secret everywhere. Update all your devices before you add 2FA secrets, and avoid editing logins on 0.2.0 in the meantime.
- **Self-hosted sync server**: update it as well to sync workflows and site memory. A 0.2.0 server does not know them yet: Corvus then keeps them on each device and everything else keeps syncing. Devices still on 0.2.0 simply ignore them, and pick them up when they update.

### Browser
- **Reusable workflows**: save a finished agent run as a workflow (from `corvus://agent-runs`, the Command Bar run panel, or when you tell the agent the task is repetitive), review it, turn typed values into `{{parameters}}`, and run it again by hand or let the agent use it. Nothing is saved without your review. The side panel's new Workflows view lists the workflows for the current site; `corvus://flows` is now the full manager, with origin and site filters and a "Needs attention" view for workflows whose steps stopped matching the page.
- **Site memory**: after each successful agent run, Corvus keeps a few compact hints per site (elements that worked, URL shapes with values removed, obstacles such as cookie banners, the usual order of steps). It learns only from steps that worked, never from page text, and never keeps typed values or secrets; about 2 KB per site. New tasks on that site start with the top hints, so the agent needs fewer steps on sites it has seen. See, edit and forget them in the panel's Learned view or on `corvus://flows`. On by default, with a switch in Settings.
- **Workflows and site memory sync**: saved workflows (recorded or saved from agent runs) and what Corvus learned about sites now sync end to end across your devices, each as its own category in Settings > Sync (on by default, per device; turning one off keeps that device's data). Edits follow the last change, run counts and learned hints add up across devices without counting anything twice, and deleting a workflow, "Forget this hint", "Forget this site" and "Forget everything" apply on every device, even one that comes back online with old data. Site memory never carries typed values, passwords, codes or credential fields; whether a device learns stays its own switch.
- **2FA codes**: add a time-based (TOTP) 2FA secret to a saved login by pasting an `otpauth://` link, importing a QR code image (decoded on your device) or typing the base32 secret. The secret is stored in the end-to-end encrypted vault and synced. `corvus://passwords` shows the live code with a countdown and a copy button, and warns that keeping the 2FA secret next to the password turns two factors into one. On a one-time-code field the key button offers the code.
- **KeePass, read-only**: add `.kdbx` files (KDBX 3.1 and 4) or a folder of them, with an optional key file. Unlock once, or keep a database unlocked with the master password wrapped by your system keychain. Databases auto-lock after the idle time in Settings > Passwords and when the screen locks, and are re-read when the file changes. Corvus never writes to them. Their logins and 2FA codes show up in autofill and on `corvus://passwords`.
- **Export to KeePass**: write your saved logins and their 2FA secrets to a new `.kdbx` file protected by a master password you choose. Existing files are never overwritten.
- **Auto sign-in** (opt-in per login): when the login page loads, Corvus asks once, then fills and submits the form. Never in tabs an agent is driving.
- **WebScope redesign**: grouped tool tabs, the scope always visible, history with filters (host, method, status, type, source), sortable columns and resizable request/response panes (Pretty, Raw, Headers, Hex), Repeater tabs, a clearer Fuzzer with a request preview and CSV export, and findings grouped by severity with repeats merged. Fixed: the Fuzzer's extract regex is now sent, and the intercept editor follows the selected item.
- **Fixed**: site favicons disappeared from the tab strip after a restart, or stayed hidden after a page's first icon failed to load.

### For AI agents
- **Workflows for agents**: `list_workflows`, `read_workflow` and `run_workflow` in the Command Bar agent. The workflows for the current site are given to the agent as data at the start of a task, so it can run one instead of planning from scratch. Every step still goes through the approval gate; if a step no longer matches, the agent continues on its own and reports which step broke. MCP `run_flow` can now read a workflow, filter by host and pass parameters.
- **Site memory for agents**: `read_site_memory` in the Command Bar agent, and the read-only MCP tool `site_memory` (Standard level).
- **`fill_login` and `fill_totp`**: the Command Bar agent and Full-access MCP clients can sign in and fill 2FA codes, but only when Settings > Passwords > "Let AI agents use logins you opt in" is on and the login itself is opted in (both off by default), and only after you approve each use. Corvus fills the value by reference: the password and the code never reach the model, tool results, transcripts, run history or logs. Without the opt-ins, 2FA is handed to you as before. CAPTCHAs are always handed to you.
- Agent page snapshots never include the value of password fields, one-time-code fields or fields Corvus filled with a secret, and fields filled for an agent are masked on screen.
- **Script lock after a fill**: once Corvus fills a saved password or 2FA code into a tab (agent sign-in, autofill or auto sign-in), agents cannot run scripts there or read raw page content (`evaluate`, `get_html`, `get_text`, `extract`, `find`, `pdf`, `run_workflow`) until the tab loads a new page. This applies to every agent at every access level; clicking, typing and the masked page snapshot keep working.
- **WebScope hides credential traffic from AI**: requests sent from a tab right after Corvus filled a saved password or 2FA code, and requests that carry such a value, are marked "Hidden from AI". You still see them in full in WebScope, with a badge. AI agents and MCP clients get them with the request body and the URL query values removed, in history and search, request detail, findings, the sitemap and the intercept queue.

### Project
- **Third-party notices**: the build writes `THIRD_PARTY_NOTICES.md` with the name, version, licence and licence text of every third-party package in the app, ships it next to the app and links it from Settings > Updates > Third-party software. The build fails on a licence outside MIT, ISC, BSD-2-Clause, BSD-3-Clause, Apache-2.0, MPL-2.0, 0BSD, Unlicense, Python-2.0 or BlueOak-1.0.0, and on any change to the accepted copyleft package below.
- **Licence of the binaries**: the Corvus source stays MPL-2.0. The installers and the packaged app include electron-chrome-extensions, which Corvus uses under GPL-3.0, so as a combined work they are distributed under GPL-3.0. The complete corresponding source is https://github.com/ParendumOU/Corvus. The notices file and the README say so.

## v0.2.0

The first open-source release of Corvus (MPL-2.0). Installers and automatic updates now come from GitHub Releases of ParendumOU/Corvus.

### Browser
- **Split view**: tile two live tabs side by side, with a draggable divider and focus routing.
- **PDF viewer with AI**: an in-app pdf.js viewer with the reading AI suite and page citations.
- **Password manager**: an end-to-end-encrypted vault (same crypto as sync) with autofill, `corvus://passwords`, synced across your devices.
- **Annotations**: in-page highlights and notes (CSS Custom Highlight API), anchored by text quote and synced end to end.
- **Semantic search**: BM25 plus optional local embeddings over history, bookmarks and reading notes, at `corvus://find`.
- **Crash recovery**: a per-tab recovery page, restore after an unclean exit, and an opt-in local crash log.
- **Device sync and management**: reading notes, watches and workspaces now sync end to end; list and revoke devices at `corvus://devices`.
- **Settings search**: filter the settings and jump straight to the matching control.
- **Onboarding**: a first-run wizard for the AI provider, sync phrase, bookmark import and preferences.
- **Auto-update**: from GitHub Releases by default, or from a self-hosted feed set in Settings > Updates. A downgrade is only offered when a pre-release build switches back to Stable.

### AI
- **Local models**: Ollama and any OpenAI-compatible server, no API key needed. AI search, Assist and the reader work offline.
- **Persistent agent runs**: runs are saved and can resume mid-loop, with a history at `corvus://agent-runs`. Step previews now say which page the agent opened or read.
- **Scheduled agents**: cron or interval AI runs on the watches scheduler, with an unattended-approval gate.
- **Per-site AI profiles**: a per-domain prompt addendum and a narrower access cap for the agent on that site.
- **Recorded flows**: record a browser flow and replay it as an approval-gated macro at `corvus://flows`.

### For AI agents (MCP)
- **Remote MCP over Streamable HTTP**: bind to 127.0.0.1 or 0.0.0.0 with mandatory bearer auth; off by default.
- **Snapshot tool**: a read-only page artifact (screenshot, DOM outline and network).
- **Automation tools** at the Full access level, each approval-gated: `run_flow` (replay a saved recorded flow), cookies, `fill_fields` and `download`.
- **Corvus-MCP**: the connector now has its own MIT repo, [ParendumOU/Corvus-MCP](https://github.com/ParendumOU/Corvus-MCP), with setup for Claude Code, Claude Desktop, Cursor, VS Code, Zed, Cline, Codex CLI, Gemini CLI and any stdio client. The bundled bridge now ships the license notices of its dependencies.

### Project
- Source published under MPL-2.0, with `SECURITY.md` and `CONTRIBUTING.md`.
- Windows and Linux only. The installers are not code-signed yet, so Windows SmartScreen shows a warning on first run. macOS builds will follow.

## v0.1.1

- **Command bar (Ctrl/Cmd+K)**: a fast action palette (open tabs, history, bookmarks, settings, web search, internal pages) and an in-browser AI agent - type a task and Claude carries it out in a tab using the browser tools, with the live activity overlay, a step log, pause, and an approval prompt before risky actions (forms, logins, payments). Provider-agnostic agent loop (Anthropic API or local Claude Code), with step and token caps.
- **Reader mode + AI reading suite**: distraction-free reader (fonts, width, light/sepia/dark), Key points / TL;DR / Simplify / ELI5 / Translate with section citations, read-aloud, and a save-as-note library (corvus://reading) with Markdown export.
- **Vertical tabs, workspaces and page monitoring**: an Arc-style tab sidebar, named workspaces, and "Watch this page" with AI-summarised change alerts (corvus://watches).

## v0.1.0: first preview

The first end-to-end build of Corvus, an AI-native browser that is also an MCP server.

### Browser
- Tabs and tab groups, profiles (isolated sessions), bookmarks with folders, history.
- Site permission prompts, downloads manager, find-in-page, per-site zoom, session restore.
- Chrome extensions (install from the Chrome Web Store) plus bookmarks/history/tabGroups/ sessions/side-panel extension APIs.
- Built-in ad and tracker blocker with an address-bar shield (per-site and global toggles).
- End-to-end-encrypted sync (24-word recovery phrase) for bookmarks, history, settings, profiles, open tabs and extension suggestions, to a self-hostable server.

### AI
- AI search: a retriever (SearXNG/Brave/DuckDuckGo) plus one small-model call that returns a structured, cited answer with per-result AI ratings and summaries; News/Images/Videos tabs.
- Corvus Assist side panel: summarize page, ask about page, translate.
- AI tab organizer and a live agent-activity overlay.

### For AI agents (MCP)
- Local MCP server with a full browser toolset (visual + semantic control, forms, extract, dialogs, screenshots), three access levels (read-only / standard / full), and human handoff for CAPTCHAs/2FA (never solved automatically).
- Claude Code plugin with zero-config discovery.
- WebScope: a scope-gated, Burp-style web-traffic workbench, also exposed to agents.

### Build
- Fully Dockerized dev and release builds; Windows .exe (NSIS installer + portable) and Linux (AppImage + deb). GitLab CI runs tests and the headless smoke test on every push.
