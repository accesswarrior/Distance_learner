# Werewolf — Classroom Game

A web app for running the social-deduction game **Werewolf** in a physical
classroom. Everyone is in the same room on their own phone; a human
moderator runs the actual night/day rounds. The app is the private-information
layer and the stage manager — it is deliberately not the game.

## What the app does

- Login / signup (username + 6-digit PIN — a classroom convenience, not a
  strong credential).
- Room creation and joining.
- Private role assignment (each player sees only their own role; the
  moderator sees everyone's).
- Sequenced night actions (Doctor, Chief Werewolf, Witch, Seer), coordinated
  by the moderator's phone, which doubles as a narrator.
- In-app voting with a secret ballot, runoff handling, and result reveal.
- Automatic elimination resolution, Chief succession, Hunter's last shot,
  win detection, and rematch.

Everything social — the discussion, the accusations, the werewolves
agreeing out loud on a victim — happens in the room, not in the app.

## Firebase project

This repo reuses the existing **access-warrior-1d789** Firebase project.
All Firestore collections are prefixed `werewolf_` so it never collides
with any other app sharing the project.

### Before you go live

1. **Enable Email/Password auth** in the Firebase console
   (Authentication → Sign-in method).
2. **Merge `firestore.rules`** into whatever rules file currently governs
   this project — do NOT deploy it standalone, or you'll wipe out the
   Quiz Hub's existing rules. See the comments at the top of that file.
3. Deploy `index.html` and its assets anywhere static (GitHub Pages,
   Firebase Hosting as a second site on the same project, Netlify, etc.) —
   only Auth and Firestore need to stay on Firebase.

## Security model

The Firestore rules enforce the parts that matter, so client code can be
written straightforwardly without being the security boundary:

- **Players can only self-write `ready`** on their own player doc. Role,
  `alive`, and potion flags are game-authoritative and writable only by
  the moderator (or, briefly, by a pending Hunter).
- **Votes are secret at the database layer.** A player can read only their
  own vote; the moderator reads all of them to tally. Vote *writes* are
  validated server-side — voting must be open, target must be a living
  player who isn't the voter, and during a runoff the target must be one of
  the tied names.
- **The Seer's check is never stored.** `checkPlayer()` reads the target's
  player doc directly (rules grant that read only to the alive Seer), and
  the answer lives only in her screen state. The moderator sees that the
  Seer has acted, not who was checked or what came back.
- **The Witch's potions are applied by the moderator.** Her client appends
  intent to `session.pendingPotionFlags`; the moderator's client applies the
  real flag to her player doc and prunes the queue. The rules allow the
  append and nothing else.
- **Reveal acknowledgements.** Every announcement that needs the room's
  attention lands in a per-player "tap to confirm" gate. The moderator's
  primary controls come back once every living player has tapped. A Force
  button exists for the inevitable dead phone.

## In-game moderator controls

Once a game is started, the moderator's phone shows:

- Full role list plus per-role descriptions.
- A narrator line — what to say and do right now, computed from the same
  state as the buttons below it.
- **Eliminate** on any living player — a manual override for an off-app
  kill or a player who has to leave.
- **Start Night** / **End Night**, with a per-role advance button and a
  live indicator of which night roles have acted.
- **Start Voting** / **Reveal Result**, with a live "X of Y voted" count
  (never who).
- **Play Again (same room)** after a win, which resets roles and drops
  everyone back to the lobby.

## Known limitations (by design)

- 6-digit numeric PIN auth is a classroom convenience, not a general
  credential — don't reuse this pattern anywhere with higher stakes.
- Vote tallies happen client-side on the moderator's phone; the rules
  prevent tampering but the moderator's browser can see individual votes
  during a reveal. Acceptable for a teacher-run game.
- The state machine is a handful of flags on the session doc rather than a
  single explicit `gameState.step` enum. It works; formalizing it is a
  future improvement, not a current requirement.
- Minimum 8 "ready" players is hardcoded in `js/core/lobby.js`
  (`READY_THRESHOLD`).
- Firebase SDK is the compat 9.x line; upgrading to the modular 10+/12.x
  API is a roadmap item.
