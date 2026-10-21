/**
 * Place facts as place names (owner, 2026-10-21: "Places should be restricted to actual place names, such as
 * Los Angeles, CA or New York, NY, or Berlin, Germany"). placeName() turns a location fact's text into one city or
 * town, written "City, ST" in the US and "City, Country" elsewhere ("Singapore" / "Hong Kong" alone), or null when
 * the text doesn't name exactly one. Deterministic and offline (no geocoding, no LLM): a built-in gazetteer of cities
 * with their nicknames and neighborhoods ("LA", "DTLA", "Silver Lake" → "Los Angeles, CA"; "Brooklyn" → "New York,
 * NY"), plus any unlisted town that comes with a state or country ("Lakeside, IA", "Riverton, Macedonia").
 *
 * Not places (null): negations ("does not live in NYC", "left LA"), vague areas ("Bay Area", "SoCal", "upstate"),
 * states and countries on their own ("Colorado", "France"), homes, rooms and addresses ("unit 1 at 7124 Example
 * Blvd", "lives with you"), and text naming two places ("Calabasas or Santa Monica"). A city inside a longer
 * description still counts when it is the only one ("Hollywood townhouse", "LA house, roommate with you"); a friend
 * named like a city ("lives with Madison") or a street named after one ("Hollywood Blvd") does not.
 *
 * Bare names that are ambiguous resolve to the listing below (the owner lives in Los Angeles: "Venice" is the LA
 * neighborhood, "Portland" is Oregon); "Venice, Italy" and "Portland, ME" stay as written. intel/places.ts still
 * does trip matching by metro; it reads these names fine ("Santa Monica, CA" is in the LA metro).
 */
import { normalizePlaceText, US_STATES } from './places';

export interface PlaceName {
  /** "Los Angeles, CA" · "Berlin, Germany" · "Singapore". */
  name: string;
  /** "Los Angeles" (for sentences: "how's life in Los Angeles?"). */
  city: string;
  /** US state / DC code ("CA"), or null outside the US. */
  state: string | null;
  /** ISO 3166-1 alpha-2, lower case ("us", "de"). */
  country: string;
  /** In the gazetteer (false: an unlisted town that came with its state or country). */
  known: boolean;
}

/** The fact types that hold a place (travel_plan is a trip description and keeps its own text). */
export const PLACE_FACT_TYPES: ReadonlySet<string> = new Set(['location_current', 'location_next', 'hometown', 'home_location']);
export const isPlaceFactType = (type: string): boolean => PLACE_FACT_TYPES.has(type);

// ---------------------------------------------------------------------------------------------- countries

/** "cc Display = aliases" (aliases normalized; the display name is an alias too). */
const COUNTRY_LIST = `
us United States = usa|u s|u s a|united states of america|the us|the usa|the states|stateside
gb UK = uk|u k|united kingdom|england|scotland|wales|great britain|britain|northern ireland|the uk
ie Ireland = republic of ireland
fr France
de Germany = deutschland
nl Netherlands = the netherlands|holland
be Belgium
lu Luxembourg
ch Switzerland
at Austria
it Italy = italia
es Spain = espana
pt Portugal
gr Greece
mt Malta
cy Cyprus
dk Denmark
se Sweden
no Norway
fi Finland
is Iceland
pl Poland
cz Czech Republic = czechia
hu Hungary
ro Romania
bg Bulgaria
hr Croatia
si Slovenia
rs Serbia
ba Bosnia and Herzegovina = bosnia
me Montenegro
al Albania
mk North Macedonia = macedonia
ee Estonia
lv Latvia
lt Lithuania
ua Ukraine
ru Russia
tr Turkey = turkiye
mc Monaco
il Israel
lb Lebanon
jo Jordan
ae UAE = united arab emirates|the uae|emirates
qa Qatar
sa Saudi Arabia
eg Egypt
ma Morocco
za South Africa
ke Kenya
ng Nigeria
gh Ghana
tz Tanzania
jp Japan
kr South Korea = korea|republic of korea
cn China
hk Hong Kong = hong kong sar
mo Macau = macao
tw Taiwan
sg Singapore
th Thailand
vn Vietnam = viet nam
kh Cambodia
my Malaysia
id Indonesia
ph Philippines = the philippines
in India
np Nepal
lk Sri Lanka
au Australia
nz New Zealand
ca Canada
mx Mexico
cu Cuba
pr Puerto Rico
do Dominican Republic
jm Jamaica
bs Bahamas = the bahamas
cr Costa Rica
pa Panama
gt Guatemala
bz Belize
co Colombia
pe Peru
cl Chile
ar Argentina
br Brazil = brasil
uy Uruguay
ec Ecuador
bo Bolivia
`;

// ---------------------------------------------------------------------------------------------- the gazetteer

/**
 * One place per line: "ST City = aliases" (a US state or DC code, upper case) or "cc City = aliases" (a country code,
 * lower case). Aliases are normalized (lower case, no punctuation, no diacritics) and include nicknames,
 * neighborhoods and airport codes; the city's own name is always one, except after "!" ("Washington!": the bare
 * word is the state). The first listing of an alias wins for a bare name, so US places come first and only
 * unambiguous namesakes are listed.
 */
const PLACES = `
CA Los Angeles = la|l a|los angeles city|city of los angeles|dtla|downtown la|downtown los angeles|hollywood|east hollywood|north hollywood|noho|hollywood hills|venice|venice beach|silver lake|silverlake|echo park|koreatown|ktown|k town|los feliz|studio city|sherman oaks|encino|van nuys|woodland hills|tarzana|reseda|northridge|granada hills|porter ranch|chatsworth|canoga park|west hills|valley village|toluca lake|brentwood|sawtelle|mar vista|playa vista|playa del rey|playa|westwood|west la|west los angeles|westchester|palms|highland park|eagle rock|atwater village|atwater|glassell park|mount washington|cypress park|lincoln heights|el sereno|boyle heights|little tokyo|arts district|fairfax|fairfax district|hancock park|larchmont|miracle mile|mid city|mid wilshire|pacific palisades|the palisades|bel air|century city|beachwood|beachwood canyon|laurel canyon|cheviot hills|del rey|san pedro|leimert park|thai town|lax
CA Santa Monica
CA West Hollywood = weho
CA Culver City
CA Beverly Hills
CA Pasadena
CA South Pasadena
CA Altadena
CA Burbank
CA Glendale
CA Long Beach
CA Malibu
CA Manhattan Beach
CA Hermosa Beach
CA Redondo Beach
CA Torrance
CA El Segundo
CA Inglewood
CA Marina del Rey = mdr
CA Calabasas
CA Agoura Hills
CA Thousand Oaks
CA Ventura
CA Oxnard
CA Santa Clarita
CA West Covina
CA Pomona
CA Claremont
CA Whittier
CA Downey
CA Alhambra
CA Arcadia
CA Monrovia
CA La Canada Flintridge = la canada
CA Rancho Palos Verdes = palos verdes
CA Topanga
CA Ojai
CA Santa Barbara
CA Montecito
CA Palm Springs
CA Palm Desert
CA Indio = coachella
CA La Quinta
CA Joshua Tree
CA Twentynine Palms
CA Big Bear Lake = big bear
CA Lake Arrowhead
CA Idyllwild
CA Temecula
CA Riverside
CA San Bernardino
CA Rancho Cucamonga
CA Irvine
CA Newport Beach
CA Costa Mesa
CA Huntington Beach
CA Laguna Beach
CA Anaheim
CA Santa Ana
CA Fullerton
CA Tustin
CA Dana Point
CA San Clemente
CA Mission Viejo
CA Seal Beach
CA San Diego = la jolla|pacific beach|ocean beach|north park|hillcrest|gaslamp|mission beach|point loma|san diego city
CA Del Mar
CA Encinitas = leucadia|cardiff|cardiff by the sea
CA Carlsbad
CA Oceanside
CA Coronado
CA Chula Vista
CA Escondido
CA Solana Beach
CA San Luis Obispo = slo
CA Paso Robles
CA Santa Cruz
CA Monterey
CA Carmel-by-the-Sea = carmel
CA Big Sur
CA Mammoth Lakes = mammoth
CA Fresno
CA Bakersfield
CA Sacramento
CA Stockton
CA Modesto
CA Truckee
CA South Lake Tahoe
CA Lake Tahoe = tahoe
CA Tahoe City
CA San Francisco = sf|s f|san fran|the mission|mission district|soma|nob hill|noe valley|the castro|castro|hayes valley|marina district|pacific heights|the presidio|richmond district|sunset district|outer sunset|inner sunset|dogpatch|potrero hill|north beach|russian hill|bernal heights|tenderloin|haight|haight ashbury|lower haight|cole valley|glen park|sfo
CA Oakland
CA Berkeley
CA Alameda
CA Emeryville
CA Walnut Creek
CA Orinda
CA Moraga
CA Danville
CA San Ramon
CA Pleasanton
CA Livermore
CA Fremont
CA Hayward
CA San Leandro
CA Palo Alto
CA Menlo Park
CA Atherton
CA Woodside
CA Mountain View
CA Sunnyvale
CA Cupertino
CA Santa Clara
CA San Jose
CA Los Gatos
CA Campbell
CA Saratoga
CA Milpitas
CA Redwood City
CA San Mateo
CA Burlingame
CA San Carlos
CA Foster City
CA Millbrae
CA South San Francisco = south sf|ssf
CA Daly City
CA Pacifica
CA Half Moon Bay
CA Sausalito
CA Mill Valley
CA Tiburon
CA Larkspur
CA San Rafael
CA Novato
CA Corte Madera
CA San Anselmo
CA Petaluma
CA Santa Rosa
CA Napa = napa valley
CA Sonoma
CA Healdsburg
CA St. Helena = saint helena
CA Calistoga
CA Yountville
CA Vallejo
CA Davis
NY New York = new york city|nyc|ny|n y|manhattan|brooklyn|queens|the bronx|bronx|staten island|williamsburg|bushwick|greenpoint|park slope|dumbo|bed stuy|bedstuy|bedford stuyvesant|crown heights|prospect heights|fort greene|clinton hill|cobble hill|carroll gardens|red hook|astoria|long island city|lic|harlem|east harlem|soho|tribeca|chelsea|east village|west village|greenwich village|lower east side|les|upper west side|uws|upper east side|ues|hells kitchen|financial district|fidi|flatiron|gramercy|murray hill|nolita|ridgewood|jackson heights|flushing|jfk|lga
NY Montauk
NY East Hampton
NY Sag Harbor
NY Ithaca
NY Buffalo
NY Rochester
NY Syracuse
NY Albany
NY Saratoga Springs
NY Woodstock
NY White Plains
NY Yonkers
NY New Rochelle
NY Scarsdale
NY Tarrytown
NJ Hoboken
NJ Jersey City
NJ Newark = ewr
NJ Princeton
NJ Montclair
NJ Morristown
NJ Asbury Park
MA Boston = back bay|south end|south boston|southie|beacon hill|jamaica plain|allston|charlestown|dorchester|fenway|seaport|north end|bos
MA Cambridge
MA Somerville
MA Brookline
MA Newton
MA Medford
MA Salem
MA Nantucket
MA Martha's Vineyard
MA Provincetown = ptown
MA Worcester
MA Amherst
IL Chicago = wicker park|logan square|lincoln park|lakeview|wrigleyville|river north|west loop|the loop|pilsen|bucktown|ukrainian village|andersonville|ord|mdw
IL Evanston
IL Oak Park
IL Naperville
IL Skokie
IL Wilmette
IL Champaign
TX Austin = atx|aus
TX Dallas = dfw
TX Fort Worth = ft worth
TX Houston = iah
TX San Antonio
TX Plano
TX Frisco
TX Irving
TX El Paso
TX Galveston
TX Waco
TX Lubbock
TX Round Rock
TX Marfa
TX Corpus Christi
WA Seattle = ballard|queen anne|wallingford|sea
WA Bellevue
WA Redmond
WA Kirkland
WA Tacoma
WA Spokane
WA Olympia
WA Bellingham
OR Portland = pdx
OR Eugene
OR Bend
OR Hood River
CO Denver = rino|lodo|cherry creek|den
CO Boulder
CO Colorado Springs
CO Fort Collins
CO Aspen
CO Snowmass Village = snowmass
CO Vail
CO Breckenridge = breck
CO Telluride
CO Steamboat Springs = steamboat
CO Crested Butte
CO Silverthorne
CO Durango
CO Estes Park
UT Salt Lake City = slc|salt lake
UT Park City
UT Moab
UT Provo
UT Ogden
NV Las Vegas = vegas|las
NV Reno
AZ Phoenix = phx
AZ Scottsdale
AZ Tempe
AZ Tucson
AZ Sedona
AZ Flagstaff
AZ Mesa
NM Santa Fe
NM Albuquerque = abq
NM Taos
FL Miami = brickell|wynwood|little havana|coconut grove|mia
FL Miami Beach = south beach|sobe
FL Fort Lauderdale = ft lauderdale|fll
FL Orlando = mco
FL Tampa = tpa
FL St. Petersburg = saint petersburg|st pete
FL Jacksonville = jax
FL Tallahassee
FL Gainesville
FL Sarasota
FL Key West
FL West Palm Beach
FL Palm Beach
FL Boca Raton = boca
FL Destin
FL Pensacola
FL Coral Gables
FL Delray Beach
GA Atlanta = atl
GA Savannah
TN Nashville = bna
TN Memphis
TN Knoxville
TN Chattanooga
NC Charlotte = clt
NC Raleigh
NC Durham
NC Chapel Hill
NC Asheville
SC Charleston = chs
SC Greenville
SC Myrtle Beach
SC Hilton Head Island = hilton head
VA Richmond
VA Arlington
VA Alexandria
VA Norfolk
VA Virginia Beach
VA Charlottesville
DC Washington! = washington dc|washington d c|dc|d c|district of columbia|georgetown|capitol hill|dupont circle|adams morgan|dca|iad
MD Baltimore = bwi
MD Bethesda
MD Silver Spring
MD Annapolis
MD Rockville
PA Philadelphia = philly|phl
PA Pittsburgh = pit
OH Columbus
OH Cleveland
OH Cincinnati = cincy
MI Detroit = dtw
MI Ann Arbor
MI Grand Rapids
MI Traverse City
MN Minneapolis = twin cities|msp
MN St. Paul = saint paul
MN Duluth
WI Milwaukee
WI Madison
MO St. Louis = saint louis|stl
MO Kansas City
LA New Orleans = nola|msy
LA Baton Rouge
KY Louisville
KY Lexington
IN Indianapolis = indy
IA Des Moines
IA Iowa City
NE Omaha
OK Oklahoma City = okc
OK Tulsa
KS Wichita
ID Boise
ID Ketchum
MT Bozeman
MT Missoula
MT Big Sky
MT Whitefish
WY Jackson! = jackson hole
AK Anchorage
AK Juneau
HI Honolulu = waikiki|hnl
HI Maui
HI Lahaina
HI Kihei
HI Paia
HI Kauai
HI Oahu
HI Hilo
HI Kailua-Kona = kona
CT New Haven
CT Hartford
CT Stamford
RI Providence
RI Newport
VT Burlington
VT Stowe
AL Huntsville
AR Little Rock
AR Bentonville
ND Fargo
SD Sioux Falls
gb London = shoreditch|hackney|notting hill|brixton|islington|clapham|peckham|kensington|lhr|lgw
gb Manchester
gb Liverpool
gb Birmingham
gb Bristol
gb Leeds
gb Sheffield
gb Newcastle
gb Brighton
gb Oxford
gb Bath
gb York
gb Edinburgh
gb Glasgow
gb Aberdeen
gb Cardiff
gb Belfast
gb Nottingham
ie Dublin = dub
ie Cork
ie Galway
fr Paris = cdg
fr Marseille = marseilles
fr Lyon = lyons
fr Nice
fr Bordeaux
fr Toulouse
fr Montpellier
fr Strasbourg
fr Lille
fr Nantes
fr Cannes
fr Chamonix
fr Biarritz
fr Saint-Tropez = st tropez
fr Antibes
fr Avignon
de Berlin = ber
de Munich = munchen|muenchen|muc
de Hamburg
de Frankfurt = frankfurt am main
de Cologne = koln|koeln
de Dusseldorf = duesseldorf
de Stuttgart
de Leipzig
de Dresden
de Heidelberg
de Nuremberg = nurnberg|nuernberg
nl Amsterdam = ams
nl Rotterdam
nl The Hague = den haag
nl Utrecht
nl Eindhoven
be Brussels = bruxelles
be Antwerp = antwerpen
be Ghent = gent
be Bruges = brugge
ch Zurich
ch Geneva = geneve
ch Basel
ch Bern
ch Lausanne
ch Zermatt
ch St. Moritz = saint moritz
ch Verbier
ch Lucerne = luzern
at Vienna = wien
at Salzburg
at Innsbruck
it Rome = roma|fco
it Milan = milano|mxp
it Florence = firenze
it Naples = napoli
it Turin = torino
it Bologna
it Genoa = genova
it Verona
it Palermo
it Como = lake como
it Capri
it Positano
it Amalfi
it Sorrento
it Siena
it Pisa
it Cortina d'Ampezzo = cortina
it Livigno
it Corvara
it Bormio
it Courmayeur
es Madrid = mad
es Barcelona = bcn
es Valencia
es Seville = sevilla
es Malaga
es Bilbao
es San Sebastian = donostia
es Granada
es Ibiza
es Palma de Mallorca = palma|mallorca|majorca
es Marbella
es Las Palmas
pt Lisbon = lisboa|lis
pt Porto = oporto
pt Sintra
pt Funchal
pt Faro
gr Athens
gr Thessaloniki
gr Mykonos
gr Santorini
dk Copenhagen = kobenhavn|cph
se Stockholm
se Gothenburg = goteborg
se Malmo
no Oslo
no Bergen
fi Helsinki
is Reykjavik = kef
pl Warsaw
pl Krakow = cracow
cz Prague = praha
hu Budapest
ro Bucharest
hr Zagreb
hr Split
hr Dubrovnik
hr Hvar
si Ljubljana
rs Belgrade
me Kotor
me Budva
me Podgorica
me Tivat
al Tirana
mk Skopje
mk Ohrid
bg Sofia
tr Istanbul
tr Bodrum
tr Antalya
ee Tallinn
lv Riga
lt Vilnius
ua Kyiv = kiev
ru Moscow
mt Valletta
cy Limassol
mc Monaco = monte carlo
il Tel Aviv = tlv
il Jerusalem
lb Beirut
jo Amman
ae Dubai = dxb
ae Abu Dhabi
qa Doha
sa Riyadh
eg Cairo
ma Marrakech = marrakesh
ma Casablanca
za Cape Town
za Johannesburg = joburg
ke Nairobi
ng Lagos
gh Accra
jp Tokyo = hnd|nrt
jp Kyoto
jp Osaka
jp Sapporo
jp Niseko
jp Hakuba
kr Seoul = icn
kr Busan
cn Beijing = peking
cn Shanghai
cn Shenzhen
cn Guangzhou
hk Hong Kong = hkg
mo Macau
tw Taipei
sg Singapore = sin
th Bangkok = bkk
th Chiang Mai
th Phuket
vn Hanoi
vn Ho Chi Minh City = saigon
my Kuala Lumpur
id Jakarta
id Bali = ubud|canggu|seminyak
ph Manila
in Mumbai = bombay
in Delhi = new delhi
in Bangalore = bengaluru
np Kathmandu
lk Colombo
au Sydney = syd
au Melbourne
au Brisbane
au Perth
au Adelaide
nz Auckland
nz Wellington
nz Queenstown
ca Toronto = yyz
ca Vancouver = yvr
ca Montreal
ca Calgary
ca Ottawa
ca Quebec City
ca Whistler
ca Banff
ca Victoria
ca Halifax
mx Mexico City = cdmx|ciudad de mexico
mx Guadalajara
mx Monterrey
mx Tulum
mx Cancun
mx Playa del Carmen
mx Oaxaca
mx Puerto Vallarta
mx Cabo San Lucas = cabo
mx San Miguel de Allende
mx Merida
mx Ensenada
mx Tijuana
mx Todos Santos
cu Havana
pr San Juan
cr San Jose
co Bogotá
co Medellín
co Cartagena
pe Lima
pe Cusco = cuzco
cl Santiago
ar Buenos Aires
ar Mendoza
br Rio de Janeiro = rio
br São Paulo
br Florianópolis
uy Montevideo
ec Quito
pa Panama City
`;

/**
 * Vague areas: never a place on their own, but they say which state or country an unlisted town is in ("Danville,
 * Bay Area" → "Danville, CA"). "ST: …" or "cc: …"; "-: …" for areas with no single state or country.
 */
const REGION_LIST = `
CA: bay area|sf bay area|san francisco bay area|the bay|east bay|north bay|south bay|the peninsula|peninsula|silicon valley|socal|so cal|southern california|norcal|nor cal|northern california|central california|central coast|central valley|inland empire|orange county|oc|the oc|san fernando valley|the valley|sfv|wine country|marin|marin county|sonoma county|la county|los angeles county|westside|west side|eastside|east side|high desert|coachella valley|the desert|sierra nevada|the sierras|sierras
NY: long island|upstate new york|upstate ny|hudson valley|the hamptons|hamptons|the catskills|catskills|finger lakes|adirondacks|the adirondacks
MA: cape cod|the cape|berkshires|the berkshires
FL: south florida|the keys|florida keys
CO: front range|summit county
HI: big island|the big island
it: tuscany|dolomites|the dolomites|amalfi coast|sicily|sardinia|lombardy|puglia|cinque terre
fr: provence|south of france|french riviera|riviera|the riviera|cote d azur|normandy|brittany|alsace|french alps|burgundy
es: andalusia|catalonia|costa brava|costa del sol|basque country|canary islands|the canaries|balearic islands
pt: algarve|the algarve|madeira|azores|the azores
de: bavaria|black forest
gb: cotswolds|the cotswolds|cornwall|lake district|the lake district|highlands|scottish highlands
gr: crete|greek islands|the greek islands|cyclades
mx: baja|baja california|yucatan|riviera maya
ca: british columbia|bc|alberta|ontario|quebec|nova scotia|manitoba|saskatchewan|new brunswick|newfoundland|yukon
au: new south wales|nsw|queensland|qld|western australia|tasmania|south australia
-: new england|tri state|tristate|tri state area|midwest|the midwest|the south|south|the north|east coast|west coast|pacific northwest|pnw|gulf coast|rockies|the rockies|europe|asia|africa|south america|latin america|central america|north america|caribbean|the caribbean|middle east|the middle east|scandinavia|oceania|southeast asia|east asia|eastern europe|western europe|balkans|the balkans|mediterranean|the mediterranean|alps|the alps|mainland|the city|city|downtown|uptown|midtown|suburbs|town|home
`;

// ---------------------------------------------------------------------------------------------- tables

interface City {
  name: string;
  city: string;
  state: string | null;
  country: string;
}

/** Where a qualifier ("CA", "Germany", "Bay Area") puts a town: a state (US) or a country. */
interface Where {
  state: string | null;
  country: string | null;
}

const COUNTRY_NAME = new Map<string, string>();
const COUNTRY_BY_ALIAS = new Map<string, string>();
for (const line of COUNTRY_LIST.trim().split('\n')) {
  const m = /^([a-z]{2}) ([^=]+?)\s*(?:=\s*(.*))?$/.exec(line.trim());
  if (!m) continue;
  const [, cc, display, aliases] = m;
  COUNTRY_NAME.set(cc!, display!);
  for (const a of [normalizePlaceText(display!), ...(aliases ?? '').split('|')]) if (a.trim()) COUNTRY_BY_ALIAS.set(a.trim(), cc!);
}

const STATE_BY_ALIAS = new Map<string, string>();
for (const [code, name] of Object.entries(US_STATES)) {
  STATE_BY_ALIAS.set(code, code.toUpperCase());
  STATE_BY_ALIAS.set(name, code.toUpperCase());
}

const REGION_BY_ALIAS = new Map<string, Where>();
for (const line of REGION_LIST.trim().split('\n')) {
  const m = /^([A-Za-z-]{1,2}): (.*)$/.exec(line.trim());
  if (!m) continue;
  const [, code, aliases] = m;
  const where: Where = code === '-' ? { state: null, country: null } : /^[A-Z]{2}$/.test(code!) ? { state: code!, country: 'us' } : { state: null, country: code! };
  for (const a of aliases!.split('|')) if (a.trim() && !REGION_BY_ALIAS.has(a.trim())) REGION_BY_ALIAS.set(a.trim(), where);
}

const cityName = (city: string, state: string | null, country: string): string => {
  if (state) return `${city}, ${state}`;
  const c = COUNTRY_NAME.get(country) ?? country.toUpperCase();
  return normalizePlaceText(c) === normalizePlaceText(city) ? city : `${city}, ${c}`;
};

/** Bare alias → city (first listing wins); "alias|ST" and "alias|cc" → city for qualified names. */
const CITY_BY_ALIAS = new Map<string, City>();
const CITY_BY_ALIAS_IN = new Map<string, City>();
/** Every gazetteer city (tests: each name must read back as itself). */
export const GAZETTEER: readonly PlaceName[] = [];
for (const line of PLACES.trim().split('\n')) {
  const m = /^([A-Za-z]{2}) ([^=!]+?)(!?)\s*(?:=\s*(.*))?$/.exec(line.trim());
  if (!m) continue;
  const [, code, display, noBare, aliases] = m;
  const us = /^[A-Z]{2}$/.test(code!);
  const c: City = { city: display!, state: us ? code! : null, country: us ? 'us' : code!, name: '' };
  c.name = cityName(c.city, c.state, c.country);
  (GAZETTEER as PlaceName[]).push({ ...c, known: true });
  const own = noBare ? [] : [normalizePlaceText(display!)];
  for (const raw of [...own, ...(aliases ?? '').split('|')]) {
    const a = raw.trim();
    if (!a) continue;
    if (!CITY_BY_ALIAS.has(a)) CITY_BY_ALIAS.set(a, c);
    for (const where of [c.state?.toLowerCase(), c.country]) if (where && !CITY_BY_ALIAS_IN.has(`${a}|${where}`)) CITY_BY_ALIAS_IN.set(`${a}|${where}`, c);
  }
  // "Washington, DC": the city name with its own state reads back even when the bare word is not an alias.
  const self = `${normalizePlaceText(display!)}|${(c.state ?? c.country).toLowerCase()}`;
  if (!CITY_BY_ALIAS_IN.has(self)) CITY_BY_ALIAS_IN.set(self, c);
}
const MAX_ALIAS_WORDS = Math.max(...[...CITY_BY_ALIAS.keys()].map((a) => a.split(' ').length));

/**
 * In free text (not a whole segment), these aliases need "in / at / to / near / from" before them: they are also
 * first names ("lives with Madison") or common words ("a nice place", "bend over backwards").
 */
const GUARDED = new Set('austin charlotte florence madison savannah sydney victoria dallas phoenix orlando jackson eugene salem davis columbus cleveland newton chelsea paris lima nice bath split cork reading bend boulder aspen mesa palms playa venice york'.split(' '));
/** Airport codes count only when written in capitals ("near LAX"), never as the words "sea", "den" or "mad". */
const AIRPORTS = new Set('lax sfo jfk lga ewr bos ord mdw aus dfw iah sea pdx den las phx mia fll mco tpa bna clt chs dca iad bwi phl pit dtw msp msy hnl lhr lgw dub cdg ber muc ams fco mxp mad bcn lis cph kef tlv dxb hnd nrt icn hkg sin bkk syd yyz yvr'.split(' '));
const LOCATIVE = new Set(['in', 'at', 'to', 'near', 'from', 'around', 'into', 'visiting']);
const STREET = new Set('st street ave avenue blvd boulevard rd road dr drive ln lane way pl place ct court pkwy parkway hwy highway ter terrace cir circle fwy freeway alley'.split(' '));
/** Words that make a segment a description rather than a place name (homes, rooms, people, plans). */
const JUNK = new Set(
  'you your yours yall me my mine his her hers their theirs our ours with roommate roommates roomie roomies parents parent mom moms dad dads family friend friends house houses home homes apartment apartments apt flat unit room rooms bedroom guest couch place building loft townhouse condo sublet sublease airbnb vrbo hotel motel hostel office lab space dorm campus street ave avenue blvd boulevard road lane block corner across nearby minutes mins walking walk walks distance town moving moved movers move shared shares share rental rent renting lease property tenants construction trip trips visiting visit visits vacation conference work job stay stays staying housesitting housesit extended temporarily temporary indefinitely possibly maybe probably unclear unknown or then and either between event venue party county district province state neighborhood area region downtown uptown midtown somewhere to coming going back heading'.split(
    ' ',
  ),
);
/** Text about where someone is not, or was. */
const NEGATION = /\b(?:not|no longer|never|isnt|doesnt|didnt|wasnt|arent|wont|cant|does not|did not|is not|was not|left|leaving|moved out|moving out|moved away|moving away|out of town|away|formerly|previously|used to|former|ex)\b/;
const VAGUE = /\b(?:upstate|downstate|outskirts|suburbs?|suburban|countryside|somewhere|anywhere|everywhere|overseas|abroad|rural|outside)\b/;
const LEAD =
  /^(?:(?:currently|now|still|just|also|lives?|living|based|located|resides?|residing|staying|settled|moved|moving|relocat(?:ed|ing)|head(?:ed|ing)|going|originally|born|raised|grew\s+up|is|was|from|in|to|at|near|around|into|close\s+to)\s+)+/i;
const TRAIL =
  /\s+(?:(?:for|with|until|till|since|through|thru|during|starting|beginning|then|next|because|after|before|while|but|plus)\b|in\s+(?:january|february|march|april|june|july|august|september|october|november|december|jan|feb|apr|aug|sept?|oct|nov|dec)\b|(?:january|february|march|april|june|july|august|september|october|november|december)\b).*$/i;
const DIRECTION = /^(?:west side|east side|westside|eastside|north|south|east|west|central|greater|inner|outer|metro|northern|southern|eastern|western|upper|lower|coastal) /;
const SUFFIX = / (?:metro area|metro|area|proper|region|vicinity)$/;
/** Two-letter state codes that are also everyday words: a trailing one counts only when written in capitals. */
const WORDY_STATES = new Set(['in', 'me', 'or', 'oh', 'ok', 'hi', 'id', 'de', 'co', 'pa', 'ma', 'al', 'la']);

// ---------------------------------------------------------------------------------------------- reading

type Head = { kind: 'city'; city: City; alias: string } | { kind: 'name'; display: string } | { kind: 'vague' } | { kind: 'junk' };

const tokensOf = (norm: string) => norm.split(' ').filter(Boolean);
const hasJunk = (norm: string) => tokensOf(norm).some((t) => JUNK.has(t) || /\d/.test(t));

/** A whole qualifier ("CA", "California 94110", "Germany", "Bay Area") → where it puts a town, else null. */
function qualifierOf(norm: string): Where[] | null {
  const zipless = norm.replace(/ \d{5}(?: \d{4})?$/, '');
  for (const s of [zipless, zipless.replace(SUFFIX, '')]) {
    const out: Where[] = [];
    const st = STATE_BY_ALIAS.get(s);
    if (st) out.push({ state: st, country: 'us' });
    const cc = COUNTRY_BY_ALIAS.get(s);
    if (cc) out.push({ state: null, country: cc });
    const region = REGION_BY_ALIAS.get(s);
    if (region && (region.state || region.country)) out.push(region);
    if (out.length) return out;
  }
  return null;
}

const isVague = (norm: string) => STATE_BY_ALIAS.has(norm) || COUNTRY_BY_ALIAS.has(norm) || REGION_BY_ALIAS.has(norm);

/** A head segment ("Los Angeles", "West Hollywood area", "Central LA", "Lakeside", "LA house"). */
function headOf(orig: string): Head {
  const norm = normalizePlaceText(orig).replace(/,/g, ' ');
  if (!norm) return { kind: 'junk' };
  const capitals = orig.trim() === orig.trim().toUpperCase();
  const suffixless = norm.replace(SUFFIX, '');
  for (const v of [norm, suffixless, norm.replace(DIRECTION, ''), suffixless.replace(DIRECTION, '')]) {
    const city = AIRPORTS.has(v) && !capitals ? undefined : CITY_BY_ALIAS.get(v);
    if (city) return { kind: 'city', city, alias: v };
    if (isVague(v)) return { kind: 'vague' };
  }
  if (hasJunk(norm) || !/^\p{L}[\p{L}'’ .-]*$/u.test(orig.trim()) || norm.split(' ').length > 4 || orig.trim().length > 40) return { kind: 'junk' };
  return { kind: 'name', display: displayOf(orig) };
}

/** "lakeside" → "Lakeside"; text the model or the owner capitalized stays as written. */
function displayOf(orig: string): string {
  const s = orig.trim().replace(/\s+/g, ' ').replace(/\.$/, '');
  return s === s.toLowerCase() || s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep: string, c: string) => sep + c.toUpperCase()) : s;
}

/** "Portland OR", "Berlin Germany", "Albany New York": a trailing qualifier without a comma becomes its own segment. */
function splitTrailing(orig: string): string[] {
  const head = headOf(orig);
  if (head.kind === 'city' || head.kind === 'vague') return [orig];
  const words = orig.trim().split(/\s+/);
  for (let k = Math.min(4, words.length - 1); k >= 1; k--) {
    const tail = words.slice(-k).join(' ');
    const tn = normalizePlaceText(tail);
    if (k === 1 && WORDY_STATES.has(tn) && tail !== tail.toUpperCase()) continue;
    if (STATE_BY_ALIAS.has(tn) || COUNTRY_BY_ALIAS.has(tn)) return [words.slice(0, -k).join(' '), tail];
  }
  return [orig];
}

/** Cities named inside a description, with the guards from the header (one segment). */
function citiesIn(orig: string): Set<City> {
  const found = new Set<City>();
  const tokens = tokensOf(normalizePlaceText(orig).replace(/,/g, ' '));
  const upper = new Set([...orig.matchAll(/\b[A-Z][A-Z.]{1,4}\b/g)].map((m) => normalizePlaceText(m[0]).replace(/ /g, '')));
  for (let i = 0; i < tokens.length; ) {
    let matched = 0;
    for (let n = Math.min(MAX_ALIAS_WORDS, tokens.length - i); n >= 1 && !matched; n--) {
      const phrase = tokens.slice(i, i + n).join(' ');
      const city = CITY_BY_ALIAS.get(phrase);
      if (!city) continue;
      const prev = tokens[i - 1];
      const next = tokens[i + n];
      if ((prev && /^\d/.test(prev)) || (next && STREET.has(next))) continue;
      const short = phrase.replace(/ /g, '').length <= 3;
      if (AIRPORTS.has(phrase) && !upper.has(phrase)) continue;
      const guarded = short || GUARDED.has(phrase);
      const whole = i === 0 && n === tokens.length;
      if (guarded && !whole && !(prev && LOCATIVE.has(prev)) && !(short && upper.has(phrase.replace(/ /g, '')))) continue;
      found.add(city);
      matched = n;
    }
    i += matched || 1;
  }
  return found;
}

const where = (w: Where) => (w.state ?? w.country)!.toLowerCase();

/** A known city qualified by `ws`: the listing in that state/country, the same city, or null (a namesake). */
function qualify(city: City, alias: string, ws: Where[]): City | null {
  for (const w of ws) {
    const hit = CITY_BY_ALIAS_IN.get(`${alias}|${where(w)}`);
    if (hit) return hit;
    if ((w.state && w.state === city.state) || (!w.state && w.country === city.country)) return city;
  }
  return null;
}

const named = (display: string, w: Where): City | null => {
  const country = w.state ? 'us' : w.country;
  // A US town needs its state ("City, ST"); "Springfield, USA" says too little.
  if (!country || (country === 'us' && !w.state)) return null;
  return { city: display, state: w.state, country, name: cityName(display, w.state, country) };
};

const result = (c: City, known: boolean): PlaceName => ({ name: c.name, city: c.city, state: c.state, country: c.country, known });

/**
 * The one city or town a location fact names, as "City, ST" / "City, Country", or null. See the module header.
 */
export function placeName(raw: string | null | undefined): PlaceName | null {
  const text = (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!text) return null;
  const full = normalizePlaceText(text).replace(/,/g, ' ');
  if (!full || NEGATION.test(full) || VAGUE.test(full)) return null;
  const segments = text
    .replace(/\([^)]*\)?|\[[^\]]*\]?/g, ' ')
    .split(/\s*(?:[,;/|]|\s[-–—]\s)\s*/)
    .flatMap((s) => {
      const near = /^\s*(?:near|close to|by)\s/i.test(s);
      const full = s.replace(LEAD, '').trim();
      const cleaned = full.replace(TRAIL, '').trim();
      return cleaned ? splitTrailing(cleaned).map((part) => ({ orig: part.trim(), full, near })) : [];
    })
    .filter((s) => s.orig);
  if (!segments.length) return null;

  // "Washington, DC": the first two segments can be one name.
  let start = 0;
  let head: Head | null = null;
  if (segments.length >= 2) {
    const joined = CITY_BY_ALIAS.get(`${normalizePlaceText(segments[0]!.orig)} ${normalizePlaceText(segments[1]!.orig)}`);
    if (joined) {
      head = { kind: 'city', city: joined, alias: `${normalizePlaceText(segments[0]!.orig)} ${normalizePlaceText(segments[1]!.orig)}` };
      start = 1;
    }
  }
  if (!head) {
    for (let i = 0; i < segments.length; i++) {
      const h = headOf(segments[i]!.orig);
      if (h.kind === 'city' || h.kind === 'name') {
        head = h;
        start = i;
        break;
      }
    }
  }
  if (head) {
    for (const seg of segments.slice(start + 1)) {
      const norm = normalizePlaceText(seg.orig);
      // "near Walnut Creek" only says which state the head town is in.
      const inner = seg.near ? (CITY_BY_ALIAS.get(norm) ?? null) : null;
      const ws = inner ? [{ state: inner.state, country: inner.country }] : qualifierOf(norm);
      if (ws) {
        if (head.kind === 'city') {
          // "Hollywood, LA": a qualifier that is also a name for the head's own city.
          if (CITY_BY_ALIAS.get(norm) === head.city) return result(head.city, true);
          const q = qualify(head.city, head.alias, ws);
          if (q) return result(q, true);
          // A namesake elsewhere ("Portland, ME", "Venice, Italy", "Hollywood, FL").
          const display = head.alias === normalizePlaceText(head.city.city) ? head.city.city : displayOf(segments[start]!.orig.replace(/\s+(?:metro area|metro|area|proper|region|vicinity)$/i, ''));
          const n = named(display, ws[0]!);
          return n ? result(n, false) : null;
        }
        const n = named(head.display, ws[0]!);
        return n ? result(n, false) : null;
      }
      const city = CITY_BY_ALIAS.get(norm);
      if (city) return result(head.kind === 'city' ? head.city : city, true);
    }
    if (head.kind === 'city') return result(head.city, true);
  }
  // A description: the first segment that names exactly one city (two cities in one segment: not a place). Its
  // trailing clause counts only when the rest names none ("shared house with you in Los Angeles").
  for (const seg of segments) {
    if (headOf(seg.orig).kind === 'vague') continue;
    let found = citiesIn(seg.orig);
    if (!found.size && seg.full !== seg.orig) found = citiesIn(seg.full);
    if (found.size === 1) return result([...found][0]!, true);
    if (found.size > 1) return null;
  }
  return null;
}

/** How a place fact reads: its place name when it has one, else the text as stored (owner-entered values). */
export function placeFactValue(type: string, value: string): string {
  if (!isPlaceFactType(type)) return value;
  return placeName(value)?.name ?? value;
}

/**
 * The place a stored value_norm ("los angeles ca", "portland me", "la") names: commas are gone there, so a trailing
 * state or country is split off first. For fact_blocks written before place names were normalized.
 */
export function placeNameOfNorm(valueNorm: string): PlaceName | null {
  const words = valueNorm.trim().split(/\s+/);
  for (let k = Math.min(4, words.length - 1); k >= 1; k--) {
    const tail = words.slice(-k).join(' ');
    if (STATE_BY_ALIAS.has(tail) || COUNTRY_BY_ALIAS.has(tail)) return placeName(`${words.slice(0, -k).join(' ')}, ${tail}`);
  }
  return placeName(valueNorm);
}
