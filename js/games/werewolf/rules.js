// js/games/werewolf/rules.js
// Pure game logic. No Firestore, no DOM.
//
// Removed players (participationStatus === 'removed') are excluded from
// every calculation in this file. They do not count toward either side of
// the win condition, they are not candidates for Chief succession, and
// they cannot be a pending Hunter.

function isWerewolf(role) {
  return role === 'werewolf' || role === 'chief_werewolf';
}

function isActive(p) {
  return p.participationStatus !== 'removed';
}

function isLivingActive(p) {
  return isActive(p) && p.alive !== false;
}

function assignRoles(playerCount) {
  const numWerewolves = Math.max(2, Math.round(playerCount / 4));
  const numVillagers  = Math.max(0, playerCount - numWerewolves - 4);

  const roles = ['chief_werewolf'];
  for (let i = 1; i < numWerewolves; i++) roles.push('werewolf');
  roles.push('seer', 'doctor', 'witch', 'hunter');
  for (let i = 0; i < numVillagers; i++) roles.push('villager');

  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }
  return roles;
}

function roleComposition(roles) {
  const counts = {};
  roles.forEach(r => { counts[r] = (counts[r] || 0) + 1; });
  return counts;
}

function pickChiefSuccessor(players) {
  const active = players.filter(isActive);
  const hasAliveChief = active.some(p => p.alive !== false && p.role === 'chief_werewolf');
  if (hasAliveChief) return null;
  const candidates = active.filter(p => p.alive !== false && p.role === 'werewolf');
  if (candidates.length === 0) return null;
  return candidates[Math.floor(Math.random() * candidates.length)].id;
}

function findPendingHunter(players) {
  const hunter = players.find(p =>
    isLivingActive({ ...p, alive: false })  // isActive AND role hunt — no, alive:false on purpose
  );
  // simpler: explicit filter
  const h = players.find(p =>
    p.role === 'hunter'
    && p.alive === false
    && !p.hunterShotUsed
    && isActive(p)
  );
  return h ? h.id : null;
}

function checkWinCondition(players) {
  const active = players.filter(isActive);
  const aliveWerewolves = active.filter(p => p.alive !== false &&  isWerewolf(p.role)).length;
  const aliveOthers     = active.filter(p => p.alive !== false && !isWerewolf(p.role)).length;

  if (aliveWerewolves === 0) return 'villagers';
  if (aliveWerewolves >= aliveOthers) return 'werewolves';
  return null;
}
