import { describe, expect, it } from 'vitest';
import { parsePlace } from '../../src/intel/places';
import { GAZETTEER, placeFactValue, placeName, placeNameOfNorm } from '../../src/intel/placeNames';

const name = (raw: string) => placeName(raw)?.name ?? null;

describe('place names ("City, ST" / "City, Country")', () => {
  it('spells out nicknames and folds neighborhoods and boroughs into their city', () => {
    expect(name('LA')).toBe('Los Angeles, CA');
    expect(name('L.A.')).toBe('Los Angeles, CA');
    expect(name('los angeles')).toBe('Los Angeles, CA');
    expect(name('DTLA')).toBe('Los Angeles, CA');
    expect(name('Silver Lake')).toBe('Los Angeles, CA');
    expect(name('NYC')).toBe('New York, NY');
    expect(name('New York')).toBe('New York, NY');
    expect(name('Brooklyn')).toBe('New York, NY');
    expect(name('Williamsburg, Brooklyn')).toBe('New York, NY');
    expect(name('SF')).toBe('San Francisco, CA');
    expect(name('the Mission')).toBe('San Francisco, CA');
    expect(name('Vegas')).toBe('Las Vegas, NV');
    expect(name('SLC')).toBe('Salt Lake City, UT');
    expect(name('Washington DC')).toBe('Washington, DC');
    expect(name('Pacific Beach, San Diego')).toBe('San Diego, CA');
    expect(name('Shoreditch, London')).toBe('London, UK');
  });

  it('keeps separate cities separate and writes countries out', () => {
    expect(name('Santa Monica')).toBe('Santa Monica, CA');
    expect(name('West Hollywood')).toBe('West Hollywood, CA');
    expect(name('WeHo')).toBe('West Hollywood, CA');
    expect(name('Berlin')).toBe('Berlin, Germany');
    expect(name('Lisboa')).toBe('Lisbon, Portugal');
    expect(name('London')).toBe('London, UK');
    expect(name('Tokyo')).toBe('Tokyo, Japan');
    expect(name('Singapore')).toBe('Singapore');
    expect(name('Hong Kong')).toBe('Hong Kong');
    expect(name('Bogotá, Colombia')).toBe('Bogotá, Colombia');
  });

  it('accepts an unlisted town that comes with its state or country', () => {
    expect(placeName('Lakeside, IA')).toEqual({ name: 'Lakeside, IA', city: 'Lakeside', state: 'IA', country: 'us', known: false });
    expect(name('lakeside, iowa')).toBe('Lakeside, IA');
    expect(name('Lakeside IA')).toBe('Lakeside, IA');
    expect(name('Springfield, Illinois 62701')).toBe('Springfield, IL');
    expect(name('Riverton, Macedonia')).toBe('Riverton, North Macedonia');
    expect(name('Lakeside, Bay Area')).toBe('Lakeside, CA');
    expect(name('Lakeside, near Walnut Creek')).toBe('Lakeside, CA');
    expect(name('Lakeside')).toBeNull();
    expect(name('Lakeside, USA')).toBeNull(); // a US town needs its state
  });

  it('a qualifier picks the namesake elsewhere', () => {
    expect(name('Portland')).toBe('Portland, OR');
    expect(name('Portland, ME')).toBe('Portland, ME');
    expect(name('Venice')).toBe('Los Angeles, CA');
    expect(name('Venice, Italy')).toBe('Venice, Italy');
    expect(name('Paris, TX')).toBe('Paris, TX');
    expect(name('Paris, France')).toBe('Paris, France');
    expect(name('Cambridge, UK')).toBe('Cambridge, UK');
    expect(name('Hollywood, LA')).toBe('Los Angeles, CA');
    expect(name('Baton Rouge, LA')).toBe('Baton Rouge, LA');
    expect(name('Los Angeles, CA, USA')).toBe('Los Angeles, CA');
  });

  it('a city inside a short description still counts when it is the only one', () => {
    expect(name('Hollywood townhouse')).toBe('Los Angeles, CA');
    expect(name('LA house, roommate with you')).toBe('Los Angeles, CA');
    expect(name('Los Angeles (new house)')).toBe('Los Angeles, CA');
    expect(name('Tokyo (born there)')).toBe('Tokyo, Japan');
    expect(name('lives in Austin')).toBe('Austin, TX');
    expect(name('moving to Denver')).toBe('Denver, CO');
    expect(name('Atlanta for work')).toBe('Atlanta, GA');
    expect(name('Frankfurt area')).toBe('Frankfurt, Germany');
    expect(name('Central LA')).toBe('Los Angeles, CA');
    expect(name('shared house with you in Los Angeles')).toBe('Los Angeles, CA');
    expect(name('Palm Desert house for Coachella')).toBe('Palm Desert, CA');
    expect(name('near LAX')).toBe('Los Angeles, CA');
  });

  it('is not a place: negations, vague areas, states and countries alone, homes, addresses, two cities', () => {
    for (const raw of [
      'does not live in NYC',
      'not in Berlin, friends there',
      'left LA for a family thing',
      'previously lived in LA',
      'out of town, owns property in LA',
      'Bay Area',
      'San Francisco Bay Area',
      'SoCal',
      'east coast',
      'eastside',
      'New York (upstate, near the mountains)',
      'Orange County',
      'Colorado',
      'France',
      'UK',
      'lives with you as roommate',
      'living with parents',
      'unit 2',
      'unit 1 at 100 Example Blvd',
      '100 Hollywood Blvd',
      'new place, April 1 move',
      'Calabasas or Santa Monica',
      'British Columbia or Alberta',
      'coming to America, home July 28',
      '',
    ]) {
      expect([raw, name(raw)]).toEqual([raw, null]);
    }
  });

  it('a first name or an everyday word is not a city inside a description', () => {
    expect(name('lives with Charlotte and Sam')).toBeNull();
    expect(name('staying at Austin and Dana’s place')).toBeNull();
    expect(name('has a nice place by the sea')).toBeNull();
    expect(name('Austin')).toBe('Austin, TX'); // on its own it is the city
    expect(name('moved in with friends in Austin')).toBe('Austin, TX');
  });

  it('every gazetteer name reads back as itself, and as a metro for trips', () => {
    for (const p of GAZETTEER) expect([p.name, name(p.name)]).toEqual([p.name, p.name]);
    for (const p of [...GAZETTEER.slice(0, 60), placeName('Lakeside, IA')!]) expect([p.name, placeName(placeName(p.name)!.name)?.name]).toEqual([p.name, p.name]);
    expect(parsePlace(name('Silver Lake'), 'name')?.key).toBe('metro:la');
    expect(parsePlace(name('Santa Monica'), 'name')?.key).toBe('metro:la');
    expect(parsePlace(name('Brooklyn'), 'name')?.key).toBe('metro:nyc');
    expect(parsePlace(name('Berlin'), 'name')?.key).toBe('metro:berlin');
  });

  it('reads stored value_norms and shows place facts by name', () => {
    expect(placeNameOfNorm('la')?.name).toBe('Los Angeles, CA');
    expect(placeNameOfNorm('los angeles ca')?.name).toBe('Los Angeles, CA');
    expect(placeNameOfNorm('portland me')?.name).toBe('Portland, ME');
    expect(placeNameOfNorm('berlin germany')?.name).toBe('Berlin, Germany');
    expect(placeFactValue('location_current', 'LA')).toBe('Los Angeles, CA');
    expect(placeFactValue('home_location', 'lives in Australia')).toBe('lives in Australia');
    expect(placeFactValue('employer', 'LA Fitness')).toBe('LA Fitness');
  });
});
