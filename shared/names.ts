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
    // All names taken — append a number to a random one
    const base = NAMES[Math.floor(Math.random() * NAMES.length)];
    return `${base}-${Math.floor(Math.random() * 99) + 2}`;
  }

  return available[Math.floor(Math.random() * available.length)];
}
