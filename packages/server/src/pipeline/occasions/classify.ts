/**
 * Rule classification of an occasion (PLAN "Calendar attendee inference" step 2). Rules first; the LLM step may
 * later override with classified_by='llm', and a user decision ('user') is never overwritten.
 * Precedence: medical (sensitive appointment) → flights/travel → lodging/multi-day all-day → household and service
 * logistics → personal-care appointments → explicit work meetings → social → unknown. Only 'social' feeds attendee
 * inference, interactions, edges and digests.
 */
import type { Mention } from './text';
import { withoutUrls } from './text';

export type OccasionKind = 'social' | 'logistics' | 'appointment' | 'work' | 'lodging' | 'travel' | 'unknown';

export interface ClassifyInput {
  /** Titles of every calendar copy (own event first). */
  titles: string[];
  /** Plain-text notes of every copy. */
  notes: string[];
  location: string | null;
  allDay: boolean;
  startsAt: number;
  endsAt: number | null;
  hasPartiful: boolean;
  hasReservation: boolean;
  mentions: readonly Mention[];
  /** Explicit attendees other than the owner. */
  explicitAttendees: number;
}

export interface Classification {
  kind: OccasionKind;
  isSocial: boolean;
  sensitive: boolean;
  confidence: number;
  rule: string;
}

const DAY = 86_400_000;

const MEDICAL =
  /\b(doctor|dr\.? ?appt|dentist|dental|orthodont\w*|dermatolog\w*|therap(y|ist)|physio\w*|clinic|hospital|urgent care|check-?up|physical exam|annual physical|blood (work|test|draw)|lab work|labs\b|vaccin\w*|flu shot|booster|optometr\w*|ophthalm\w*|eye exam|psychiatr\w*|psycholog\w*|counsel(l?ing|l?or)|medical|surgery|mri|x-?ray|ultrasound|colonoscopy|mammogram|obgyn|ob-gyn|pediatric\w*|prescription|pharmacy|chiropract\w*|acupunct\w*)\b/i;
const FLIGHT = /\b(flight|flights|fly(ing)? to|boarding|layover|airport|airlines?|terminal \d)\b|✈/i;
const FLIGHT_NUMBER = /\b(?:UA|AA|DL|WN|B6|AS|NK|F9|BA|LH|AF|KL|AC|VS|EK)\s?\d{2,4}\b/;
const TRAVEL = /\b(trip|travel(ing|ling)?|vacation|holiday in|road ?trip|train to|amtrak|eurostar|ferry|cruise|drive to|bus to)\b/i;
const LODGING = /\b(hotel|motel|airbnb|vrbo|hostel|resort|inn\b|lodge\b|check-?in|check-?out|stay(ing)? (at|with|in)|booking\.com|expedia)\b/i;
const LOGISTICS =
  /\b(maid|cleaners?|cleaning|housekeep\w*|hoa\b|plumb\w*|electrician|handyman|contractor|repair\w*|install(ation|er)?|service appointment|service call|technician|delivery|deliveries|package|pick ?up|drop ?off|move-?(in|out)|movers?|moving|inspection|inspector|oil change|car service|car wash|mechanic|tires?|dmv|registration|passport|notary|bank|tax(es)?|accountant|insurance|lease|landlord|property manager|super\b|pest|exterminator|landscap\w*|gardener|lawn|laundry|dry clean\w*|tailor|storage|utilit(y|ies)|internet|cable|wifi|router|trash|recycling|bill(s)? due|rent due|pay rent|payment due|autopay|renewal|jury duty|vote|voting|errands?)\b/i;
const CARE = /\b(haircut|hair cut|barber|salon|blowout|nails?|manicure|pedicure|mani|pedi|wax(ing)?|brows?|lashes|facial|massage|spa appointment|vet\b|veterinar\w*|groom(er|ing)|dog walk\w*|pet sitter|personal trainer|pt session)\b/i;
const WORK =
  /\b(stand-?up|1:1|1-on-1|one[- ]on[- ]one|sync\b|meeting|interview|all[- ]hands|offsite|off-site|retro\b|sprint|kick-?off|onboarding|webinar|conference call|office hours|qbr|okrs?|board meeting|performance review|team meeting|staff meeting|client call|customer call|sales call|demo day|demo\b|workshop|training)\b/i;
const VIDEO = /\b(zoom\.us|meet\.google\.com|teams\.microsoft\.com|webex)\b/i;
const SOCIAL =
  /\b(dinner|lunch|brunch|breakfast|drinks?|happy hour|cocktails?|beers?|wine|coffee|tea time|concert|show|gig|festival|party|parties|birthday|bday|bachelor(ette)?|wedding|engagement|bbq|barbecue|cookout|potluck|picnic|game night|board games|movie|movies|film|cinema|theater|theatre|musical|opera|ballet|comedy|stand-?up comedy|museum|gallery|exhibit\w*|hike|hiking|climb(ing)?|bouldering|ski(ing)?|snowboard\w*|surf(ing)?|tennis|golf|pickleball|soccer|basketball|baseball|football|hockey|volleyball|run club|bike ride|yoga class|game\b|match\b|tickets?|tix|date night|date\b|hang\b|hangout|hang out|catch ?up|reunion|celebrat\w*|karaoke|trivia|dance|dancing|club\b|bar\b|rooftop|tasting|housewarming|shower|gala|fundraiser|meetup|meet up|get-?together|sleepover|friendsgiving|thanksgiving|christmas|xmas|new year|nye|halloween|launch party|book club|supper|feast|dim sum|sushi|pizza|tacos)\b/i;
const BIRTHDAY_REMINDER = /\b(birthday|bday|anniversary)\b/i;
const PARTY = /\b(party|dinner|drinks|celebrat\w*|brunch|bbq|get-?together|festival|wedding)\b/i;

const r2 = (n: number) => Math.round(n * 100) / 100;

export function classifyOccasion(i: ClassifyInput): Classification {
  const title = withoutUrls(i.titles.join(' \n '));
  const notes = withoutUrls(i.notes.join(' \n '));
  const all = `${title}\n${notes}\n${i.location ?? ''}`;
  const out = (kind: OccasionKind, confidence: number, rule: string, sensitive = false): Classification => ({
    kind,
    isSocial: kind === 'social',
    sensitive,
    confidence: r2(confidence),
    rule,
  });
  const companions = i.mentions.some((m) => m.where === 'title' && m.pattern !== 'pair');
  const spanDays = i.endsAt != null ? (i.endsAt - i.startsAt) / DAY : 0;

  if (MEDICAL.test(title)) return out('appointment', 0.85, 'medical_title', true);
  if (MEDICAL.test(notes) && !SOCIAL.test(title)) return out('appointment', 0.6, 'medical_notes', true);
  if (FLIGHT.test(title) || FLIGHT_NUMBER.test(title)) return out('travel', 0.85, 'flight');
  if (LODGING.test(title) && !(SOCIAL.test(title) && !i.allDay)) return out('lodging', 0.8, 'lodging');
  if (i.allDay && spanDays >= 1.5) {
    return LODGING.test(all) ? out('lodging', 0.7, 'multi_day_lodging') : out('travel', 0.6, 'multi_day_all_day');
  }
  if (TRAVEL.test(title) && !companions && !SOCIAL.test(title)) return out('travel', 0.65, 'travel');
  if (LOGISTICS.test(title) && !SOCIAL.test(title)) return out('logistics', 0.8, 'logistics');
  if (CARE.test(title) && !SOCIAL.test(title)) return out('appointment', 0.75, 'personal_care');
  if (WORK.test(title) && !(SOCIAL.test(title) && companions)) return out('work', 0.75, 'work_title');
  if (i.hasPartiful) return out('social', 0.9, 'partiful');
  if (i.hasReservation) return out('social', 0.85, 'reservation');
  if (i.allDay && BIRTHDAY_REMINDER.test(title) && !PARTY.test(title)) return out('unknown', 0.5, 'all_day_reminder');
  if (SOCIAL.test(title)) return out('social', companions ? 0.9 : 0.8, companions ? 'social_with_people' : 'social_title');
  if (companions) return out('social', 0.7, 'people_in_title');
  if (VIDEO.test(all) && i.explicitAttendees > 0) return out('work', 0.6, 'video_call');
  if (SOCIAL.test(notes)) return out('social', 0.6, 'social_notes');
  if (i.mentions.length > 0) return out('social', 0.55, 'people_in_notes');
  if (LOGISTICS.test(notes)) return out('logistics', 0.55, 'logistics_notes');
  return out('unknown', 0.4, 'no_rule');
}
