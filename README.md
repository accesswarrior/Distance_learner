# Werewolf — Classroom Game

A web app for running the social-deduction game **Werewolf** in a physical
classroom. Everyone is in the same room on their own phone; a human
moderator runs the actual night/day rounds, guided by an on-screen script.
The app is the private-information layer and the stage manager — it is
deliberately not the whole game.

## What the app does

- Login / signup (username + 6-digit PIN — a classroom convenience, not a
  strong credential). Username is a private login handle; a separate
  **display name**, set at signup, is what other players actually see.
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
All Firestore collections are prefixed `werewolf_` so it never collides
with any other app sharing the project.

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
3. Publish, and test with at least two real accounts (one moderator, one
   player) before trusting it with a class. See "Known limitations" below
   for what a single-device code review can't catch.

## Data model

Two Firebase products: **Auth** (email/password, with the "email" being a
synthetic `username@werewolf.local`) and **Firestore**.

```
werewolf_usernames/{username}        -> { uid }
werewolf_users/{uid}                 -> { username, displayName, createdAt, currentSessionId? }

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
index.html
css/main.css
firestore.rules
js/
  core/
    firebaseConfig.js   — Firebase project config + SDK init
    auth.js             — signup/login, username<->email mapping
    engine.js           — session lifecycle, esc(), confirmAction(), the roster/players write helpers
    lobby.js            — waiting room, Start Game (role assignment)
  games/werewolf/
    rules.js            — pure game logic: role assignment, win condition, succession, pending-Hunter lookup
    night.js            — night-phase sequencing and resolution
    voting.js           — day voting, manual elimination, win/succession resolution, Hunter's shot
    narrator.js         — moderator-facing "what to say and do now" + role reference text
    ui.js               — renders the whole post-lobby screen for both moderator and players
  main.js               — boot, auth state, room creation/joining
```
