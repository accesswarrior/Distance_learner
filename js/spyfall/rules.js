// js/spyfall/rules.js
// Pure Spyfall rules: deck, constants, scoring. No Firestore, no DOM.

const SPYFALL_LOCATIONS = [
  "Airplane", "Bank", "Beach", "Casino", "Circus Tent",
  "Corporate Party", "Day Spa", "Embassy", "Hospital", "Hotel",
  "Military Base", "Movie Studio", "Ocean Liner", "Passenger Train",
  "Pirate Ship", "Polar Station", "Police Station", "Restaurant", "School",
  "Service Station", "Space Station", "Submarine", "Supermarket", "Theater",
  "University", "Wedding", "Market", "Church", "Bus Park",
  "Football Stadium", "Radio Station", "Cinema", "Museum", "Zoo"
];

// The operator (a player who runs the round and sits it out) rotates every
// round, so a room needs one more phone than it has players IN a round.
const SPYFALL_MIN_PARTICIPANTS = 3;   // people actually playing a round (1 spy + 2 agents at least)
const SPYFALL_MAX_PLAYERS = 10;       // everyone in the room, operator included

const SPYFALL_DISCUSSION_SECONDS = 480;  // 8 minutes
const SPYFALL_VOTE_SECONDS = 45;
const SPYFALL_GUESS_SECONDS = 30;

// Pick a location not in the excluded list. If all locations are excluded
// (deck exhausted), fall back to the full deck.
function pickSpyfallLocation(exclude) {
  const excluded = new Set(exclude || []);
  const available = SPYFALL_LOCATIONS.filter(l => !excluded.has(l));
  const pool = available.length > 0 ? available : SPYFALL_LOCATIONS;
  return pool[Math.floor(Math.random() * pool.length)];
}

function pickSpyfallSpy(playerIds) {
  return playerIds[Math.floor(Math.random() * playerIds.length)];
}

// Scoring.
//   spy not caught                  -> spy 2
//   spy caught, names the location  -> spy 1
//   spy caught, guesses wrong       -> every agent 1
// Returns a map: uid -> points earned this round.
function computeSpyfallRoundScores({ spyId, playerIds, spyCaught, spyGuessCorrect }) {
  const scores = {};
  playerIds.forEach(uid => scores[uid] = 0);
  if (!spyCaught) {
    scores[spyId] = 2;
  } else if (spyGuessCorrect) {
    scores[spyId] = 1;
  } else {
    playerIds.forEach(uid => {
      if (uid !== spyId) scores[uid] = 1;
    });
  }
  return scores;
}

// Case-insensitive, trims whitespace.
function isSpyfallGuessCorrect(guess, actual) {
  if (!guess || !actual) return false;
  return guess.trim().toLowerCase() === actual.trim().toLowerCase();
}

// Tally one round's votes. `votes` is [{voterId, targetId}], `participantIds`
// the people in the round. Votes from or for anyone else are ignored, so a
// stray doc can never swing the result. Returns the tally and who (if
// anyone) the room accused: a unique top vote-getter, not a tie.
function tallySpyfallVotes(votes, participantIds) {
  const inRound = new Set(participantIds);
  const tally = {};
  votes.forEach(({ voterId, targetId }) => {
    if (!inRound.has(voterId) || !inRound.has(targetId) || voterId === targetId) return;
    tally[targetId] = (tally[targetId] || 0) + 1;
  });
  let top = 0;
  Object.values(tally).forEach(c => { if (c > top) top = c; });
  const topIds = Object.keys(tally).filter(id => tally[id] === top);
  return {
    tally,
    accusedId: topIds.length === 1 ? topIds[0] : null,
    tied: topIds.length > 1
  };
}
