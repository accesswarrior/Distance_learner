# Classroom Games

A small platform of in-person party games, each played on everyone's own
phone in the same room. **Werewolf** and **Spyfall** are built.

The Werewolf game: a web app for running the social-deduction game in a
physical classroom. Everyone is in the same room on their own phone; a human
moderator runs the actual night/day rounds, guided by an on-screen script.
The app is the private-information layer and the stage manager — it is
deliberately not the whole game.

## How a player moves through the site

```
index.html          Login / sign up (one account for every game)
   │  signed in → straight on (or back to the page they were trying to reach)
   ▼
hub.html            Pick a game
   │
   ▼
games/werewolf.html  ┐ Create or join a room → lobby → game
games/spyfall.html   ┘ (each game is its own page)
   │  "← All games" returns to the hub; "Log out" returns to the login page
```

Every page except the login page requires a signed-in player and redirects to
`index.html?next=<this page>` otherwise, so a link to a game page works even for
someone who isn't logged in yet. `next` is only honoured for known same-site
pages (`hub.html`, `games/<name>.html`).

Leaving a game page does NOT leave the room: the player stays on the roster and
tapping the game on the hub resumes them where they were (see `currentSessions`
below).

## What the Werewolf game does

- Accounts (on the login page): username + 6-digit PIN — a classroom
  convenience, not a strong credential. Username is a private login handle;
  a separate **display name**, set at signup, is what other players see.
- Room creation (with an optional discussion timer) and joining, capped at
  a `READY_THRESHOLD` of 8 ready players to start.
- Private role assignment — each player sees only their own role; the
  moderator sees everyone's, plus a plain-language description of what
  each role in play actually does.
- A live **narrator script** on the moderator's screen: a single line,
  recomputed on every state change, telling them exactly what to say and
  do right now ("Say: 'Doctor, wake up...'", "Announce the winner...").
- Sequenced night actions — Doctor, Chief Werewolf, Witch, Seer — one role
  active at a time, coordinated by the moderator.
- In-app voting with a secret ballot, tie/runoff handling, and a dramatic
  "drumroll" reveal that every phone shows together.
- A reveal-acknowledgment gate: the moderator's next controls stay locked
  until every active player has tapped "I've seen this" (or the moderator
  force-continues, in case a phone is unavailable).
- Automatic elimination resolution, Chief Werewolf succession, the
  Hunter's last shot, win detection, and same-room rematch.

Everything social — the discussion, the accusations, the werewolves
agreeing out loud on a victim — happens in the room, not in the app.

## Firebase project

This repo reuses the existing **access-warrior-1d789** Firebase project.
Each game's Firestore collections are prefixed with the game's name
(`werewolf_...`, `spyfall_...`) so they never collide with each other or with
any other app sharing the project. (The account collections keep the legacy
`werewolf_` names — see "Accounts are platform-wide" below.)

### Before you go live

1. Open **Firestore → Rules** in the Firebase console.
2. `firestore.rules` in this repo is written as a complete, standalone
   rules file for clarity — but this project's rules may already contain
   another app's (e.g. the ELTP Quiz Hub's) rules in the same
   `match /databases/{database}/documents { ... }` block. **Do not simply
   paste this file over the existing rules** if that's the case — copy the
   `match` blocks and helper functions from this file into the *same*
   top-level block that already has the other app's rules, so neither
   app's rules get clobbered.
3. The file now contains both games' rules (Werewolf and Spyfall) plus the
   shared account rules; copy all of the blocks. Publish **before** switching
   a site over to this code — the per-game room pointer
   (`currentSessions`) is rejected by older rules.
4. Publish, and test with real accounts before trusting it with a class: at
   least two for Werewolf (moderator + player), and **four phones for Spyfall**
   (operator + 3 players). The Spyfall rules were reviewed by hand and run
   against a model of them, not against the Firestore emulator. See "Known limitations" below
   for what a single-device code review can't catch.

## Data model

Two Firebase products: **Auth** (email/password, with the "email" being a
synthetic `username@werewolf.local`) and **Firestore**.

```
werewolf_usernames/{username}        -> { uid }
werewolf_users/{uid}                 -> { username, displayName, createdAt,
                                          currentSessions?: { werewolf?: code, spyfall?: code },
                                          currentSessionId? (legacy) }

werewolf_sessions/{sessionId}
  moderatorId, status ('lobby'|'started'), createdAt
  phase ('day'|'night'), nightStep (null|'doctor'|'chief_werewolf'|'witch'|'seer'|'done')
  votingOpen, voteEligibleTargets?, announcement?, deathSeen (ack list)
  winner?, pendingHunterShot?, pendingWinRecheck?, pendingPotionFlags
  discussionTimerMinutes?, discussionTimerEndsAt?, roleComposition?

  /players/{uid}   (PRIVATE — see "Two documents per player" below)
    username, displayName, ready, participationStatus ('active'|'removed')
    role?, alive?, healPotionUsed?, poisonPotionUsed?, hunterShotUsed?

  /roster/{uid}    (PUBLIC — see "Two documents per player" below)
    username, displayName, ready, participationStatus, alive

  /secrets/werewolfTeam -> { ids: [uid, ...] }   (werewolf-side only, see below)

  /votes/{voterId}         -> { targetId, updatedAt }
  /nightActions/{role}     -> { targetId?, action?, done?, updatedAt }
```

### Accounts are platform-wide; the collection names are legacy

`werewolf_users` and `werewolf_usernames` are the account collections for the
whole platform, not just Werewolf — they keep their names (and the synthetic
`@werewolf.local` login email) because renaming either would orphan every
existing account. Don't rename them as a side effect of some other change.

**Which room am I in?** is stored per game as `currentSessions.<game>` so being
in a room for one game never overwrites another's. `currentSessionId` is the old
single pointer (it always meant Werewolf); Werewolf still reads and writes it
too so the earlier deployment and this one agree while both run against the same
Firebase project. Once the old site is retired, delete the legacy field from
`core/auth.js` (`LEGACY_POINTER_GAME`) and from the rules' `hasOnly` list.

The helpers are in `js/core/auth.js`: `getCurrentSession`, `setCurrentSession`,
`clearCurrentSession`. A new game passes its own id (`'spyfall'`).

### Starting a game: one dealing path

`buildDeal()` (rules.js, pure) decides every role and the werewolf-team list.
`dealAndStart()` (engine.js) is the only code that reads the ready players and
writes the result. The Start button (`lobby.js startGame`) and crash recovery
(`recoverStartingGame`) both call it, so they cannot deal differently.

### Two documents per player — and why

Firestore security rules are not filters. A collection query is rejected
**outright** unless the rule engine can prove it holds for every document
the query could possibly return — it does not narrow the query down to the
documents that happen to pass. Because `players/{uid}`'s read rule is true
only for the requester's own document (plus the moderator and the Seer,
whose conditions don't depend on which document is being read), a regular
player's collection query on `/players` fails completely, not partially. A
regular player must read `players/{theirOwnUid}` as a single document,
never query the collection.

The fix is to keep two parallel documents per player:

- **`players/{uid}`** — the sensitive record (`role`, potion flags,
  `hunterShotUsed`). Readable in full only by its owner, the moderator, or
  (narrowly) the alive Seer checking a specific target. The moderator's
  "All Roles" panel and every win/succession calculation read this.
- **`roster/{uid}`** — a safe public projection (name, alive status,
  ready, participation) with no strategic information at all. Readable by
  anyone signed in. Every screen element that needs to show *other*
  players — the persistent player list, vote targets, night-action
  targets — is built from this instead.

The two are written together everywhere `alive`, `ready`, or
`participationStatus` changes, so they can't drift apart — see
`engine.js`'s `syncRosterFields()` and the mirrored writes in `voting.js`
and `night.js`.

### The werewolf-team secret

The Chief Werewolf's kill-target list has to exclude their own team —
otherwise a bored werewolf could tap a teammate's name by mistake, or
worse, on purpose. But no player's client can normally tell who else is a
werewolf (that's the entire point of hidden roles). `secrets/werewolfTeam`
is a single document — `{ ids: [uid, ...] }` — written once at role
assignment, readable **only** by the moderator or an alive player who is
themselves currently a Werewolf/Chief. A villager who tries to read it
gets a flat permission-denied; Firestore doesn't do partial-field
redaction, so keeping this off the public roster and off the private
player docs (which villagers can't read anyway, but defense in depth) as
its own narrowly-scoped document is the only way to expose it safely.

## Game rules as implemented

- **Roles**: Chief Werewolf (1), ordinary Werewolves (scaling roughly 1 per
  4 players, minimum 2 total including the Chief), Seer (1), Doctor (1),
  Witch (1), Hunter (1), the rest Villagers.
- **Night order**: Doctor → Chief Werewolf → Witch → Seer. The Witch acts
  *after* the Chief on purpose — she's shown the werewolves' chosen victim
  (not a free pick) and decides from there, which is the classic Witch
  ability. Ordinary Werewolves get no app action; the physical/verbal
  agreement among them is the point, and their own screen shows them their
  teammates' names during the Chief's step so that conversation actually
  works.
- **Doctor**: protects one player (may protect themselves) from the
  werewolves' kill each night.
- **Witch**: sees the werewolves' target, and may (once each, for the
  whole game) either save that exact target with her Heal Potion, or
  poison a different player entirely with her Poison Potion — poison
  bypasses the Doctor completely, the classic rule.
- **Seer**: checks one player per night and privately learns Werewolf or
  not. Never stores who she checked — only that she's done for the night.
- **Hunter**: however they're eliminated — day vote, night kill, poison, or
  a moderator override — they get a final shot before leaving the game.
  The win check deliberately holds until they've fired (or the moderator
  skips it for them), since their shot could change the outcome.
- **Day vote**: only eliminates and names someone if the top vote-getter is
  a confirmed Werewolf (or Chief). If the top vote-getter isn't a
  werewolf, **nothing is eliminated and nothing is revealed** — no name,
  no count. This is a deliberate house rule, not an oversight: it keeps
  trust and consensus central to the day phase, and a wrongly-accused
  player never gets outed for free. A tie for the top spot opens an
  immediate runoff among just the tied names; a tie *within* a runoff
  stops there rather than looping.
- **Chief Werewolf succession**: if the Chief dies and at least one
  ordinary Werewolf is still alive, one is promoted automatically so the
  werewolves always have someone able to submit a kill.
- **Discussion timer**: optional, chosen once by the moderator when
  creating the room (off, 3, 4, or 5 minutes). The moderator starts it
  manually each day round; it's purely informational — the moderator still
  decides when to actually open voting.
- **Rematch**: "Play Again" resets the same room and roster to the lobby
  (players who were removed mid-game are dropped entirely; everyone else
  re-readies) rather than requiring a brand new room code.

### A note on one asymmetry: who can write what, and why it needed a queue

Every elimination funnels through the same win-check logic
(`checkAndApplyWinner()` in `voting.js`), which may need to (a) promote a
new Chief Werewolf and (b) record a winner — both of which require reading
every player's `role`. For every elimination *except* one, the
moderator's own client is doing the writing, and the moderator can read
and write anything. The one exception is `fireHunterShot()` — it runs on
the **eliminated Hunter's own device**, since it's their choice, not the
moderator's. A Hunter's client can't read anyone's role (not even their
own teammates', if they're not on the werewolf side), so it has no way to
compute succession or a winner itself, and it's deliberately not trusted
to write `role` or `winner` directly even if it could. Instead, a Hunter's
shot raises `pendingWinRecheck: true` on the session doc — a field their
shot is already allowed to touch — and the moderator's always-listening
client notices it, runs the exact same `checkAndApplyWinner()` used
everywhere else (this time with full `/players` access), and clears the
flag (`applyPendingWinRecheck()`). The same pattern
(`pendingPotionFlags`) already existed for the Witch, who similarly can't
write her own potion-used flags directly. Whichever AI or human touches
this file next: if you add a new non-moderator write path that needs
information only the moderator can see, it almost certainly needs this
same "raise a flag, let the moderator's client resolve it" treatment —
not a broader rule that tries to give the non-moderator client the
missing information directly.

## Spyfall

Everyone but the spy is told the same secret location; the spy only knows they
don't know it. People question each other out loud, then vote on who the spy is.
The room does the playing; the app deals the cards privately, runs the clocks,
counts the secret ballots and keeps score.

**Who runs it.** There is no fixed moderator. One player at a time is the
**operator**: they press Deal, their phone runs the round (timers, counting
votes, scoring), and they **sit that round out** — they don't get a card and
don't vote. The operator rotates every round through the join order, so everyone
plays most rounds. Consequence: a room needs **4+ phones** (3 players in a round
plus the operator), max 10.

### A round

```
idle ─deal→ dealing ─all seen→ discussing ─vote requested / time up→ voting
                                                                       │
                          spy NOT caught ─────────────────────────────┤
                          spy caught ─→ guess ─spy guesses / time up──┤
                                                                       ▼
                                                    scored ─next round→ idle (new operator)
```

| Step | What happens |
|---|---|
| Deal (operator) | Picks a location (not yet used this session) and a spy from the players in the round; writes the secret and each player's private card; clears the previous round's ballots. |
| Dealing | Each player taps Reveal, reads their card, taps "Got it" (hides it again). When everyone has, the operator's phone starts the 8-minute discussion. Players can re-check their card any time with "Check my card". |
| Discussing | Any player can ask for a vote; the operator opens it. If the clock runs out the vote opens automatically. |
| Voting | 45 seconds, secret ballots, change-your-mind allowed. Closes when everyone has voted or time's up. The top vote-getter is accused if there is exactly one (a tie or no votes accuses nobody). |
| Guess | Only if the spy was accused: they get one pick from the location list (30 s). |
| Scored | Reveals spy and location to everyone. Points: spy not caught **2**; spy caught but names the location **1**; spy caught and wrong (or too slow) **1 for each agent**. |

### Who can write what (the queue pattern, again)

The **operator's client** is the only one that advances the round, reads the
secret, counts ballots and awards points. Everyone else writes only tiny facts
the rules allow, which the operator reads and applies:

| Who | May write | Why not more |
|---|---|---|
| A player in the round | `seenCardUids` (append own uid), `voteRequestedBy` (own uid, while discussing), their ballot `votes/{uid}` (while voting, not for self/operator) | They can't set clocks or results. |
| The caught spy | `spyGuess`, once | The spy can't read the secret, and if they could write "correct" they could forge a win — the operator checks the guess. |
| The operator | everything in the session | Trusted, as in Werewolf. |

### Data model (all under `spyfall_sessions/{code}`)

```
(session doc)   operatorId, moderatorId (creator, reference only), status 'lobby'|'playing',
                currentRound, roundState, playerOrder [uid] (fixed at Start), usedLocations [],
                seenCardUids [], voteRequestedBy?, voteCallerId?, discussionEndsAt?, votingEndsAt?,
                guessEndsAt?, spyGuess?, accusationTargetId?, voteTally?, spyCaught?, voteWasTied?,
                spyGuessCorrect?, roundWinner?
/players/{uid}        displayName, ready, score, active, inCurrentRound, joinedAt   (public)
/privatePlayers/{uid} role 'spy'|'agent', location (null for the spy), roundNumber (own + operator only)
/secrets/current      locationId, spyId, roundNumber                                (operator only)
/votes/{voterId}      targetId                                          (own + operator only)
/rounds/{n}           the finished round: spy, location, tally, guess, winner, points (public)
```

Round-scoped fields on the session doc are all cleared when the next round is
dealt. `roundNumber` on each private card lets a phone ignore a card from an
earlier round if snapshots arrive out of order.

### Things that are deliberate (don't "simplify" them away)

- **Scoring is one transaction** (`finishSpyfallRound`) that re-checks the round
  state first. The operator's screen can trigger a step twice (a timer tick racing
  a snapshot); the second run finds the round already `scored` and does nothing,
  so points can't be awarded twice.
- **Ballots and cards are cleared at the deal, by the operator.** A player can't
  list or delete other people's ballots, so stale ones would otherwise leak into
  the next round and could close voting instantly.
- **The votes listener is chosen by who the operator is *right now*** (operator:
  all ballots; everyone else: only their own). The operator changes every round,
  and the rules allow nothing else.
- **The game screen is rebuilt only when data changes, never on the clock tick.**
  The tick only rewrites the countdown text. Rebuilding every second made the
  spy's location dropdown close under their finger.
- **The deal only includes players recorded in `playerOrder` at Start**, so a
  stray player document can never become a participant who never sees a card.

### Spyfall limitations

- **The operator's phone must stay online and open.** Every step that advances
  the round runs there; if it closes, the round pauses until it's reopened.
  (Same trust/availability model as Werewolf's moderator.) There is no "hand the
  operator role to someone else mid-round".
- **No joining after Start and no leaving a room** (same gap as Werewolf), and no
  "end session" — the scoreboard just keeps going round by round.
- **Deadlines use the operator's clock.** Players' countdowns are computed from
  those timestamps on their own clocks, so a badly wrong phone clock shows a
  slightly wrong countdown (it never changes when a step actually happens).
- **The operator can see the secret** if they open dev tools. Fine for a
  supervised classroom; same trust model as above.
- **Accusation is by plurality** (unique top vote-getter), not the unanimous vote
  of the printed game. Changing it means editing `tallySpyfallVotes` in `rules.js`.

## Known limitations

- **Anyone signed in can read a session doc or its roster if they know the
  room code** — `werewolf_sessions/{sessionId}` and its `/roster` are
  readable by any authenticated user, not only participants. This is
  deliberate, not an oversight: joining by code has to read the session
  doc *before* the joiner has a player doc to be "a participant" with, so
  scoping this to participants-only would break the join flow itself. Room
  codes are short but drawn from a large enough alphabet that blind
  enumeration isn't practical, and neither document ever contains role or
  potion/hunter state — the roster is deliberately the safe-to-leak half of
  the schema. Don't tighten this without also rebuilding the join flow to
  match; it's been like this on purpose more than once.

- **PIN-based login** (6-digit numeric password) is a classroom
  convenience, not real security. Fine for a supervised in-person game;
  not appropriate for anything public.
- **There is no "leave this room" action** (Werewolf and Spyfall alike). "← All
  games" only leaves the page; the player remains in the room and is resumed into
  it next time they open that game, so they can't start or join a different room
  of the same game until this one is over. Worth a deliberate design for both.
- **No presence/reconnect indicator.** A player who closes the app can
  reopen it and resume exactly where they left off (Firebase Auth persists
  login, and `tryResumeSession()` restores the right screen), but there's
  no "is this person currently connected" signal for the moderator. Not
  considered a priority since everyone is physically in the same room.
- **Room size is uncapped.** Nothing currently stops more than ~20 people
  from joining one room; a hard cap (first-come-first-served, no raffle)
  is a planned addition, not yet built.
- **Trust model.** The moderator is trusted completely — they can read and
  write anything in their own session. This mirrors an in-person game
  where the moderator already knows every role; it is not designed to
  resist a moderator who wants to cheat.
- **This file should be kept current.** Every change to the schema, the
  security rules, or the game rules should update this README in the same
  pass. It fell out of sync for a while during development — if you're an
  AI or human continuing this project, please don't let that happen again.

## File structure

```
index.html                  — login / sign up
hub.html                    — game picker
games/
  werewolf.html             — the Werewolf page (room choice + lobby + game screens)
  spyfall.html              — the Spyfall page (same shape as Werewolf's)
css/
  main.css                  — shared base: theme variables, layout, buttons, cards, modal
  werewolf.css              — Werewolf-only styles
  spyfall.css               — Spyfall-only styles (classes prefixed sf-)
firestore.rules
js/
  core/                     — game-agnostic; knows nothing about any game
    firebaseConfig.js       — Firebase project config + SDK init
    auth.js                 — signup/login/logout, profile, per-game room pointers, page redirects
    auth-page.js            — wiring for index.html
    hub.js                  — wiring for hub.html
    ui-helpers.js           — showScreen(), esc(), generateRoomCode(), confirmAction(), shownName()
  werewolf/
    engine.js               — session lifecycle, dealAndStart(), the roster/players write helpers
    lobby.js                — waiting room, Start Game
    rules.js                — pure game logic: buildDeal, win condition, succession, pending-Hunter lookup
    night.js                — night-phase sequencing and resolution
    voting.js               — day voting, manual elimination, win/succession resolution, Hunter's shot
    narrator.js             — moderator-facing "what to say and do now" + role reference text
    ui.js                   — renders the whole post-lobby screen for both moderator and players
    main.js                 — Werewolf page boot: profile, resume, create/join
  spyfall/
    rules.js                — pure: deck, constants, scoring, vote tally
    engine.js               — create / join / start a session
    round.js                — the round state machine (operator-run) + the small player writes
    lobby.js                — waiting room (follows the session, so Start moves everyone on)
    ui.js                   — the game screen
    main.js                 — Spyfall page boot: profile, resume, create/join
```

Pages declare their place with `<body data-root="../" data-page="games/werewolf.html">`
(`data-root` = path back to the site root, `data-page` = this page's own path).
Scripts are plain `<script>` tags sharing one global scope, so each game gets its
own page and its own `js/<game>/` folder: two games never load together, so their
function names can't collide. Keep `core/` free of anything game-specific — if two
games end up needing the same code, move it into `core/` then, not before.

### Deliberately NOT built yet

- A `rooms/{code}` router (one join box for all games) — only needed if the hub
  ever gets a universal "enter a code" field.
- The `secrets/{group}` + `members` generalisation of `secrets/werewolfTeam` —
  Spyfall didn't need it (its only secret is operator-only), so it still waits for
  a game that needs a secret shared by a group.
- Renaming the `werewolf_*` account collections (see above).
