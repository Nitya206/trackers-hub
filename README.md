# Trackers Hub

Most productivity apps solve one problem. This solves four — and they all share data with each other.

**→ [Live Demo](https://nitya206.github.io/trackers-hub/)**

---

## The Problem

Keeping up with college means juggling a study planner, an attendance sheet, a habit tracker, and somehow also managing the fact that you have 47 episodes of something sitting in your watchlist. Most people use four separate apps for this. None of them talk to each other.

Trackers Hub puts all of it in one place.

---

## Apps

### Study Schedule Pro
Knows your actual college timetable — not just a blank calendar. Shows your current class block with a live countdown to the next one. Tracks study hours per subject with per-subject stopwatches, logs attendance with percentage, and counts down to exams. Has a built-in Lobdell timer (30 min focus → 12 min review → 5 min break) that runs itself. Skip a class and it converts that slot to study time automatically.

### PROC//HUB
A content budget manager that doesn't pretend you don't watch things. Set a weekly hour limit for anime, manga, and shows. A live arc meter tracks usage in real time and turns red when you overspend. Your library stores every series with episode-level checkboxes, arc navigation, and watch status. The Mood Queue filters your library based on how you're feeling across 14 mood categories. Dropped series go to the Graveyard. Tasks go to the Process Queue for when you want to actually do something.

### Zen Garden
A daily habit tracker stripped down to what actually matters. One tap marks today complete. A monthly calendar visualizes your streak. Milestones scale as you improve — 30 days, then 100, then 365. Each day has a journal entry slot. Miss a day and it asks you to confirm before breaking the streak.

### ORV Tracker
A reading tracker built specifically for *Omniscient Reader's Viewpoint*. 58 volumes tracked by chapter count across novel and manhwa modes. Every volume includes a full story recap so you always remember where you left off. Progress syncs live to the hub dashboard.

---

## Architecture

All four apps share a single `hub-nav.js` file that injects a navigation layer into each tool. Every app gets a **Switch App** menu and a **⌘K command palette** that indexes every section, tab, and action in the current tool — keyboard-first navigation across the entire suite.

The hub dashboard aggregates live stats from all four apps via localStorage, updating every 3 seconds. Study percentage, attendance rate, exam countdown, content budget remaining, current streak, and ORV progress — visible at a glance without opening a single app.

---

## Technical Details

- Pure HTML, CSS, and vanilla JavaScript — zero frameworks, zero dependencies
- Fully offline — no server, no accounts, no network required after first load
- All state stored in `localStorage` — persists across sessions
- Single shared JS file powers navigation across all five pages
- Works on mobile and desktop

## Getting Started

```bash
# No install needed
# Just download and open index.html in any browser
```

---

*Built by a first year CSE student as a personal productivity suite. Open source — fork it, use it, improve it.*
