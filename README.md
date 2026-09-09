# Werewolf — Classroom MVP

A lightweight web app for running the social-deduction game **Werewolf** in a
physical classroom. Players are all in the same room on their own phones; a
human moderator runs the actual night/day rounds. The app only handles:

1. Login/signup (username + 6-digit PIN)
2. Room creation and joining
3. Private role assignment (each player sees only their own role; the
   moderator sees everyone's)

Everything after roles are revealed is run manually by the moderator.

## Firebase project

This repo reuses the existing **access-warrior-1d789** Firebase project
(same one used by the ELTP Quiz Hub). To keep the two apps from colliding:

- All Firestore collections here are prefixed `werewolf_` — see
  `js/core/engine.js` for the exact layout.
- This is a **separate GitHub repo / hosting deployment** from the Quiz
  Hub, so there's no file-path collision either.

## Before you go live

1. **Enable Email/Password auth** in the Firebase console for this project,
   if not already on (Authentication → Sign-in method).
2. **Merge `firestore.rules`** into whatever rules file currently governs
   this project — do NOT deploy it standalone, or you'll wipe out the Quiz
   Hub's existing rules. See the comments at the top of that file.
3. Deploy `index.html` and its assets anywhere static (GitHub Pages,
   Firebase Hosting as a second site on the same project, Netlify, etc.) —
   only Auth and Firestore need to stay on Firebase.

## In-game moderator controls

Once a game is started, the moderator's phone shows the full role list plus:

- **Eliminate** button next to any living player — an immediate manual
  override, for a night kill the group resolved out loud or for pulling
  someone who has to step away. This is also how the total number of
  players in the game changes after Start Game (before Start Game, use
  **Remove** in the lobby roster instead).
- **Start Voting / Reveal Result** — moves the day-phase vote into the app.
  Players tap a name from the alive roster; the moderator sees a live
  "X of Y voted" count (never who, never a running tally) and reveals
  whenever they're ready. If the top vote-getter is a Werewolf, they're
  named and eliminated ("🐺 A Werewolf was voted out: X"). If not — or if
  it's a tie — the app only ever says "Nobody was voted out," with no name
  or count shown to anyone, moderator included. This keeps a near-miss
  vote just as hidden as a wasted one.
- A win banner appears automatically for everyone the moment a win
  condition (Section 6 of the coordinator guide) is met.

New Firestore collection: `werewolf_sessions/{sessionId}/votes/{voterId}`,
cleared automatically after every reveal.

## Known limitations (by design, for a supervised classroom setting)

- Any signed-in player can technically write to any other player's
  Firestore doc (needed for the moderator's batch role-assignment write).
  Fine under teacher supervision; tighten `firestore.rules` if this ever
  runs unsupervised.
- 6-digit numeric PIN auth is convenient for a classroom but weak as a
  general-purpose credential — don't reuse this pattern anywhere with
  higher stakes.
- Minimum 8 "ready" players is currently hardcoded in
  `js/core/lobby.js` (`READY_THRESHOLD`) — change it there if you want a
  different minimum group size.
