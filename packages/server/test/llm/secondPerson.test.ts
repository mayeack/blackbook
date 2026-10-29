/** The owner's token read back as "you" in de-tokenized text: possessives and verbs agree. */
import { describe, expect, it } from 'vitest';
import { secondPerson } from '../../src/llm/secondPerson';

describe('secondPerson', () => {
  it('"you\'s" becomes "your" before a noun and "yours" standing alone; verbs agree', () => {
    expect(secondPerson("Halloween party at you's place")).toBe('Halloween party at your place');
    expect(secondPerson('Halloween party at you’s')).toBe('Halloween party at yours');
    expect(secondPerson("Dinner at you's on Friday")).toBe('Dinner at yours on Friday');
    expect(secondPerson("(10/17 at you's)")).toBe('(10/17 at yours)');
    expect(secondPerson("You's turn to host")).toBe('Your turn to host');
    expect(secondPerson('you is hosting; you was there; you has the keys')).toBe('you are hosting; you were there; you have the keys');
    // Text without the swap is untouched.
    expect(secondPerson("Sam's place, and you're invited")).toBe("Sam's place, and you're invited");
  });
});
