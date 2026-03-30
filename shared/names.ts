/**
 * Italian first names for auto-naming Claude Code peers.
 * Each session gets a unique name from this pool.
 */

const NAMES = [
  "Alessandro", "Andrea", "Angelo", "Antonio", "Arturo",
  "Beatrice", "Bianca", "Bruno",
  "Carlo", "Chiara", "Claudio", "Cristina",
  "Dante", "Davide", "Diego",
  "Elena", "Elisa", "Emanuele", "Enrico",
  "Fabio", "Federico", "Filippo", "Francesca", "Francesco",
  "Gabriele", "Giacomo", "Gianluca", "Gianmarco", "Giorgio", "Giovanni", "Giulia", "Giuseppe",
  "Ilaria", "Irene",
  "Laura", "Leonardo", "Lorenzo", "Luca", "Lucia", "Luigi", "Luna",
  "Marco", "Maria", "Mario", "Martina", "Massimo", "Mattia", "Michele",
  "Nicola", "Noemi",
  "Paola", "Paolo", "Pietro",
  "Raffaele", "Riccardo", "Roberto", "Rosa",
  "Salvatore", "Sara", "Serena", "Silvia", "Simone", "Sofia", "Stefano",
  "Tommaso",
  "Valentina", "Vincenzo", "Vittoria",
];

/**
 * Pick a random name not already taken by active peers.
 */
export function pickName(takenNames: string[]): string {
  const taken = new Set(takenNames.map((n) => n.toLowerCase()));
  const available = NAMES.filter((n) => !taken.has(n.toLowerCase()));

  if (available.length === 0) {
    // All names taken — append a number, loop until unique
    const base = NAMES[Math.floor(Math.random() * NAMES.length)];
    for (let i = 2; i < 1000; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
    // Extreme fallback
    return `${base}-${Date.now() % 10000}`;
  }

  return available[Math.floor(Math.random() * available.length)];
}
