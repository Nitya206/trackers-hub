# Trackers Hub

Most productivity apps solve one problem. This is five apps that share data with each other.

**→ [Live app](https://trackers-hub.vercel.app)** · installable on iPhone and desktop

---

## The Problem

Keeping up with college means juggling a study planner, an attendance sheet, a habit tracker, a pile of unwatched episodes, and your money. Most people use five separate apps for this, and none of them talk to each other.

Trackers Hub puts all of it in one place, and each app reacts to what the others know.

---

## Apps

### Study Schedule Pro
Knows your college timetable, not just a blank calendar. Shows the current class block with a countdown to the next one. Tracks study hours per subject, attendance with duty leave and make-up classes, marks, and exam countdowns. Has todos, spaced-repetition flashcards, a Lobdell timer, and analytics. Rituals, sleep and shopping items show up as todos automatically.

### PROC//HUB
A content budget that doesn't pretend you don't watch things. Break time is earned by studying, so the gate stays locked until you put the hours in. The library tracks every series down to the episode. The Mood Queue picks something for how you feel, and dropped series go to the Graveyard.

### Zen Garden
Two streaks, No PMO and Sleep ≤ 7h. Milestones scale from 30 days to 100 to 365. Both streaks feed the break-time rules, so keeping them earns extra break time and breaking them costs some.

### Rituals
Body-care and chore routines by time of day. Each routine can run on set weekdays or every N days, have several times a day, and carry a checklist. Tracks streaks and adherence.

### Budget
Pay-yourself-first budgeting. Savings come off the month first, and the app shows what you can spend today. One-tap "usuals" like a daily lunch are set aside ahead of time, so the daily number stays honest. Also has savings goals, an emergency fund, spending insights, and the shopping list and wishlist.

---

## Architecture

- **Hub dashboard.** A "today" row shows one live number per app, above a card for each app.
- **`hub-nav.js`.** Every app shares an app switcher and a ⌘K search that indexes each app's sections.
- **Sync.** `sync-engine.js` mirrors `localStorage` to Supabase in real time, so every device stays in step. A device can be logged out remotely.
- **Push.** `push-client.js` and a Supabase Edge Function send reminders even when the app is closed.
- **Offline.** A service worker caches everything, so the apps open with no network.
- **Shared rules.** `zen-rules.js` and `day-parts.js` hold logic that more than one app relies on.

---

## Technical Details

- Plain HTML, CSS and JavaScript, with no framework and no build step
- Installable PWA on iOS, Android and desktop
- Data lives in `localStorage` first, and sync is optional
- Supabase handles sync, auth and push, and is set up in `SYNC-SETUP.md` and `PUSH-SETUP.md`
- Deployed on Vercel

## Getting Started

```bash
# No install needed
# Open index.html in a browser, or serve the folder:
npx serve .
```

To sync between devices, follow `SYNC-SETUP.md`.

---

*Built by a first-year CSE student as a personal productivity suite. Open source — fork it, use it, improve it.*
