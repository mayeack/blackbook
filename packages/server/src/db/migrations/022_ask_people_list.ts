/**
 * 022 (owner: ask/): `ask_turns.people_list`, the structured form of an answer that lists people (AskPeopleList
 * JSON: an intro line, one row per person with the answer's detail plus city / circles / last contact, and any note
 * after the list). The web renders it as a table; NULL for every other answer and for turns stored before 021.
 * A (S) system column like the rest of ask_turns: never journaled.
 */
export const sql = /* sql */ `
ALTER TABLE ask_turns ADD COLUMN people_list TEXT CHECK (people_list IS NULL OR json_valid(people_list));
`;
