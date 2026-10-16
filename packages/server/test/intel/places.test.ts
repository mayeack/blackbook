import { describe, expect, it } from 'vitest';
import { destinationFromTitle, parsePlace, placeOfFactValue, placeOfTravelPlan, samePlace } from '../../src/intel/places';

const key = (p: ReturnType<typeof parsePlace>) => p?.key ?? null;

describe('places without geocoding', () => {
  it('normalizes cities, neighborhoods, states, ZIP codes and countries onto one metro', () => {
    expect(key(parsePlace('Austin, TX'))).toBe('metro:austin');
    expect(key(parsePlace('100 Example Blvd, Austin, TX 78701, USA', 'address'))).toBe('metro:austin');
    expect(key(parsePlace('Brooklyn, NY'))).toBe('metro:nyc');
    expect(key(parsePlace('New York, NY 10001'))).toBe('metro:nyc');
    expect(key(parsePlace('NYC'))).toBe('metro:nyc');
    expect(key(parsePlace('Washington, DC'))).toBe('metro:dc');
    expect(key(parsePlace('Oakland'))).toBe('metro:sf-bay');
    expect(key(parsePlace('San Francisco SFO'))).toBe('metro:sf-bay');
    expect(key(parsePlace('Lisboa, Portugal'))).toBe('metro:lisbon');
    expect(key(parsePlace('São Paulo'))).toBe('metro:sao-paulo');
    expect(key(parsePlace('LA'))).toBe('metro:la');
    expect(key(parsePlace('New Orleans, LA'))).toBe('metro:new-orleans');
  });

  it('keeps a same-named city abroad apart, and unknown places as plain keys only when the mode allows', () => {
    expect(key(parsePlace('Cambridge, MA'))).toBe('metro:boston');
    expect(key(parsePlace('Cambridge, UK', 'name'))).toBe('place:cambridge|gb');
    expect(parsePlace('Birch Loft')).toBeNull();
    expect(parsePlace('Birch Loft', 'venue')).toBeNull();
    expect(key(parsePlace('Example Inn, Lakeside', 'address'))).toBe('place:lakeside');
    expect(key(parsePlace('Lakeside', 'name'))).toBe('place:lakeside');
    expect(parsePlace('Example Inn', 'address')).toBeNull();
  });

  it('venues: a name that merely contains a city is not that city; the address city slot decides', () => {
    expect(parsePlace('Boston Market', 'venue')).toBeNull();
    expect(key(parsePlace('Boston Market, 1 Example St, Springfield', 'venue'))).toBeNull();
    expect(key(parsePlace('Moss & Fern, 1 Example St, Austin, TX', 'venue'))).toBe('metro:austin');
    expect(parsePlace('The DEN', 'venue')).toBeNull();
    // lodging / Partiful locations: a venue name isn't a city, the city slot is
    expect(key(parsePlace('The Austin Motel, 1 Example St, Lakeside', 'venue_address'))).toBe('place:lakeside');
    expect(key(parsePlace('Example Inn, 100 Example Blvd, Austin, TX 78701', 'venue_address'))).toBe('metro:austin');
    expect(parsePlace('Birch Loft', 'venue_address')).toBeNull();
    // a street named after a city never makes the address that city
    expect(key(parsePlace('1 Austin St, Lakeside', 'address'))).toBe('place:lakeside');
  });

  it('reads destinations from trip-ish titles', () => {
    expect(key(destinationFromTitle('Flight to Austin (UA 1234)'))).toBe('metro:austin');
    expect(key(destinationFromTitle('UA 1234 SFO → AUS'))).toBe('metro:austin');
    expect(key(destinationFromTitle('Flight to SFO'))).toBe('metro:sf-bay');
    expect(key(destinationFromTitle('Lisbon trip ✈️'))).toBe('metro:lisbon');
    expect(key(destinationFromTitle('Weekend in Tahoe'))).toBe('metro:tahoe');
    expect(key(destinationFromTitle('Austin'))).toBe('metro:austin');
    expect(key(destinationFromTitle('Airbnb in Joshua Tree'))).toBe('metro:palm-springs');
    expect(key(destinationFromTitle('Trip to Lakeside'))).toBe('place:lakeside');
    expect(destinationFromTitle('PTO')).toBeNull();
    expect(destinationFromTitle('Out of office')).toBeNull();
    expect(destinationFromTitle('Stay at Example Inn')).toBeNull();
  });

  it('reads location and travel-plan fact values', () => {
    expect(key(placeOfFactValue('lives in Brooklyn'))).toBe('metro:nyc');
    expect(key(placeOfFactValue('Denver area'))).toBe('metro:denver');
    expect(key(placeOfTravelPlan('Austin trip'))).toBe('metro:austin');
    expect(key(placeOfTravelPlan('visiting San Francisco Oct 20–23'))).toBe('metro:sf-bay');
    expect(samePlace(parsePlace('SF'), parsePlace('Palo Alto'))).toBe(true);
    expect(samePlace(parsePlace('SF'), null)).toBe(false);
  });
});
