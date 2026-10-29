/**
 * 027 (owner request 2026-10-25: "Focus on important things. Bringing tomatoes isn't important"):
 * `commitments.stakes`, how much a promise matters ('low' small logistics, 'normal', 'high' money / housing / work /
 * bookings / intros), labeled by the obligations extraction. NULL on rows from before it: readers guess from the
 * description (pipeline/obligations/stakes.ts). Journaled like the rest of the row.
 */
export const sql = /* sql */ `
ALTER TABLE commitments ADD COLUMN stakes TEXT CHECK (stakes IS NULL OR stakes IN ('low','normal','high'));
`;
