// js/games/werewolf/rules.js

// A werewolf-side role. Chief Werewolf is the only werewolf who submits
// the night's kill target in-app — the rest discuss out loud and just
// tell the chief who to pick, so the app never needs the werewolves to
// agree on one shared in-app action.
function isWerewolf(role) {
  return role === 'werewolf' || role === 'chief_werewolf';
}

function assignRoles(playerCount) {
  // Scales werewolves roughly 1 per 4 players (minimum 2), keeps seer and
  // doctor fixed at 1 each, and fills the rest with villagers. Exactly one
  // werewolf is the chief.
  const numWerewolves = Math.max(2, Math.round(playerCount / 4));
  const numSeer = 1;
  const numDoctor = 1;
  const numVillagers = Math.max(0, playerCount - numWerewolves - numSeer - numDoctor);

  const roles = [];
  roles.push('chief_werewolf');
  for (let i = 1; i < numWerewolves; i++) roles.push('werewolf');
  for (let i = 0; i < numSeer; i++) roles.push('seer');
  for (let i = 0; i < numDoctor; i++) roles.push('doctor');
  for (let i = 0; i < numVillagers; i++) roles.push('villager');

  // Shuffle (Fisher-Yates)
  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return roles;
}

// Called after any elimination, before the win check. If the Chief
// Werewolf just died and at least one ordinary werewolf is still alive,
// promotes one of them to Chief so the werewolves always have someone able
// to submit a night kill — otherwise voting out the Chief would silently
// disable the werewolves' night action for the rest of the game. Returns
// the promoted player's id, or null if no promotion was needed/possible.
function pickChiefSuccessor(players) {
  const hasAliveChief = players.some(p => p.alive !== false && p.role === 'chief_werewolf');
  if (hasAliveChief) return null;
  const candidates = players.filter(p => p.alive !== false && p.role === 'werewolf');
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)].id;
}

// players: array of { role, alive }. Returns 'werewolves', 'villagers', or
// null if the game should continue. Checked after every elimination —
// whether it came from a vote or the moderator's manual "Eliminate" button.
function checkWinCondition(players) {
  const aliveWerewolves = players.filter(p => p.alive !== false && isWerewolf(p.role)).length;
  const aliveOthers = players.filter(p => p.alive !== false && !isWerewolf(p.role)).length;

  if (aliveWerewolves === 0) return 'villagers';
  if (aliveWerewolves >= aliveOthers) return 'werewolves';
  return null;
}
