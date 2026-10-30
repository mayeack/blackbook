<!-- Owner requests 2026-10-22 and 2026-10-25. Amends PLAN.md: yeackbot may search the public web (Anthropic's server-side web search) for this one feature, and may send email to the owner's own Gmail (gmail.send) for it. -->

# Weekly event picks

> "Yeackbot will need to be able to surf the web to find ticket links and events for me to send me the weekly event
> digest. I want a weekly event digest of cool events you think I might like, where I have no event that night in
> my calendar, with links to get the tickets, and suggestions based on prior events ticketed in email and on
> calendar. Regularly check which events I'm going to to refine your recommendations." (owner, 2026-10-22)
>
> "For the weekly digest, send it to me over email every sunday evening." "Check my calendar "Recurring events" for
> cool recurring events happening that week, in addition to what you find online / summarized in my newsletters."
> "Remember to continuously try and improve on your weekly digest based on what events I actually go to, based on
> signals in calendar and email." (owner, 2026-10-25)
>
> "Don't include front matter … Remove [the footer] … Organize the email by day. I'm seeing a ton of events for Mon
> Nov 2. Have 3-5 events per day where it looks like I am free (based on my calendar). If it looks like I'm busy (have
> a calendar event in the evening), print the event." (owner, 2026-10-28, reviewing a preview)

Every Sunday evening (Settings → Agent → Event picks: default Sunday 18:00) yeackbot emails the owner his week ahead
(Monday to Sunday), one section per day. A free day lists 3–5 events, each with a link to buy tickets: from the web,
his event newsletters and his Recurring Events calendar. A busy day lists the plans that fill his evening. It learns
from which events he goes to. Until "Email me" is connected (or with events.channel 'text') it texts the same, by
day.
Code: `packages/server/src/intel/eventPicks/`, `delivery/email.ts`; web: `/picks`, Settings → Email & photos;
migrations 028 and 029 (029 lets a week number up to 60 picks, for the by-day layout).

## 1. The run (`run.ts`, job `event-picks`, every 10 min; acts only on the picks day from events.time to 21:00)

1. **Outcomes first**: which earlier picks he went to (§6), so this week learns from last week.
2. **Free nights** for the week (§2): sent at 16:00 or later, the next 7 nights (a Sunday-evening email covers Monday
   to Sunday); sent earlier, that night and the six after it. None free → the run is `empty`: nothing is searched or
   sent.
3. **Taste** (§3) and the **city** (events.city, else the home city: travel.home_city or his location fact).
4. **Candidates**: one Claude Haiku 5.5 call with the server-side `web_search` tool (~60% of events.max_searches),
   asking for about events.max_picks + 1 events per free night (at most 40).
5. **Newsletters** (§8): the past 9 days of event newsletters in Gmail, one more Haiku call (no search).
6. **Filter**: each must be on a free night inside the window and name a venue (not TBA / Unknown), be a public
   kind (no parties), be one real event (eventKey: date + venue + title words), never one sent in an earlier week,
   and not one already on his Recurring Events calendar that day (`on_calendar`: its ticket link goes to that
   listing instead). Dropped rows stay in `event_picks` with the reason.
7. **Score** (§5), then **ticket pages**: one targeted search per event among each day's best that has no
   event-specific page yet (at most 12, the rest of the search budget). No search is spent on a busy night or a
   duplicate.
8. **Choose** per free day (§5): its Recurring Events listings first (§9, at most 2), then the picks up to
   events.max_picks (default 5), at least 3 when there are enough. Ordinals follow the days (date, then start time).
9. **Send** (§7): one email to his own Gmail (events.channel 'email', the default), else one text (like the brief
   since #84), both by day, purpose `events`, a stable client ref. If nothing can go out yet (Gmail busy, quiet hours,
   the collector down), the run stays `ready` (the web shows it) and a later tick sends it the same day.

A failed web search (API error, budget cap, unreadable answer) is retried every 30 min, at most 3 times a week; the
last attempt goes on with the newsletters and the calendar alone.

## 2. Free nights (`nights.ts`)

A night D is busy when, between 18:00 and 03:00 the next morning, there is any of the following:
- **A calendar plan.** A timed event he hasn't declined, not cancelled, not marked "free". On a non-primary calendar,
  a recurring entry with no invitees is a listing (his "Recurring Events" calendar) and doesn't count.
- **Away.** A multi-day all-day entry (a trip, a stay) or a flight.
- **A ticket.** A ticket event he holds that night.
- **A Partiful RSVP.** Going, maybe, or hosting. With no end time, a Partiful event counts as 2 hours.

Single all-day entries (birthdays) and afternoon plans that end by 18:00 leave the night free. Live data, the week
of Oct 26: one free night out of seven; the busy nights were real plans.

## 3. Taste (`profile.ts`)

- **Inputs.** Ticket events from Gmail (holding 1, gave away 0.5, sold 0.3). Calendar get-togethers with a
  public-event title (concert, club night, festival, comedy, theater, sports, talk: 0.6). Partiful events he went to
  as a guest (0.2, the "party" kind only). Picks he went to (1). Recency half-life 180 days, over the last 18 months.
- **What may be sent to Claude.** Public kinds as shares, performer and genre names (from tickets and picks), venue
  names, and titles of public events.
- **What is never sent.** A calendar title or venue that contains any first or last name of someone in his people,
  a possessive ("Sam's …"), anything that looks like an address or a URL, and anything from Partiful. The prompt
  also goes through the egress choke point.

## 4. Finding events on the web (`discover.ts`, `links.ts`)

- **Pricing.** Anthropic's web search costs $0.01 per search plus the result tokens (~10–15K per search). Two calls
  a week at the default of 10 searches: measured $0.10 on live data (9 searches, 69K + 41K input tokens, each call
  under Haiku's 100K price step).
- **Output.** Web search can't be combined with structured output (its citations are always on). Each answer is a
  free-text JSON array, read item by item, so a bad item is dropped, not the answer. If an answer has no array at
  all, one structured call without search (`events_extract`) re-reads it. URLs become refs into the numbered result
  pages.
- **Links are never trusted from the model.** A URL is kept only when it is a page the search returned in the same
  call (normalized: https, no tracking params). It is then classified:
  - **ticket**: one event's own page, e.g. `/event/<id>` or `/events/123`;
  - **resale**: StubHub and similar;
  - **listing**: a city, genre or day listing, or an encyclopedia.

  Picks need a ticket or resale link, unless fewer than 2 have one.
- **Measured on live data (week of Oct 26).** 14 events found, 5 picked, with event pages on Ticketmaster, AXS,
  Academy LA and DICE. One "ticket" link was really a day listing (`/events/2026/10/29`); fixed: date-only paths
  are listings.

## 5. Scoring and choosing (`rank.ts`)

score = 0.4·taste + 0.25·kind + 0.25·learned + 0.1·link
- **taste**: similarity (`intel/similarity.ts`) to the 3 most alike past events, recency-weighted. A performer he
  has seen counts most.
- **kind**: the share of his going-out that this kind of event takes.
- **learned**: one Thompson draw per feature value (kind, genre, venue, performer, and the source: web, newsletter or
  Recurring Events) from earlier picks. Went is +1 yes, tapped the link +0.5 yes, "not for me" +1 no, and a night
  passed untouched +0.25 no (nothing for a night he had other plans).
- **link**: a ticket page scores 1, resale 0.6, a listing 0.2.

Choosing (`choosePerDay`), for each free day: best score first, up to events.max_picks less the day's listings, at
most 2 of one kind while others are left, events with a ticket or resale page first; one with only a listing page
just to reach 3. With probability 0.2 a week, one slot goes to a 🎲 "something different": the best event of a kind
he rarely goes to (it replaces the weakest pick of a full day).

## 6. Did he go? (`outcomes.ts`, job `event-picks-outcomes` daily 06:45 and before each run)

The owner asked for the picks to improve "based on what events I actually go to, based on signals in calendar and
email". A sent pick becomes **going** when one of these shows up for that date:
- **email**: a ticket event from Gmail ticket, RSVP or registration mail (same performer, an alike title, or the same
  venue);
- **calendar**: a plan naming a performer, the title's words or the venue. A Recurring Events listing is not a plan:
  it only says the happening exists, so it never counts (a pick taken from that calendar needs a real plan, ticket
  or RSVP);
- a Partiful RSVP with an alike title or the same venue.

Otherwise it becomes **passed** once the night is over: `date`, or `busy` when he had other plans that night (he
couldn't have gone, so the ranker learns nothing from it). A late calendar entry or ticket within 3 days still turns
passed into going. His own answers on the web (going / not for me / undo) are never overwritten. Taps on the email's
links count as interest (§5). The email's "Last week" line shows what was learned: which picks he went to and how
yeackbot knew, what he tapped, what he waved off.

## 7. The email, texts and the web

- **The email** (`email.ts`, `delivery/email.ts`). Subject "Your week: 9 event picks (Mon Oct 26 – Sun Nov 1)". One
  message, no front matter and no footer, a section per day:
  - **a free day**: its picks in time order: title (🎲 for the wildcard), venue and time, the why, where it came from
    ("From one of your newsletters", "On your Recurring Events calendar"), "Get tickets on dice.fm →". A free day with
    nothing found says "Free, but nothing stood out.";
  - **a busy day**: "Busy: <plan> · 7pm" per plan (his calendar, Partiful RSVPs, tickets; "Away: <trip>"), at most 4
    and then "and N more". A Partiful event that is also on his calendar ("… | Partiful", "[Pending] …") is one line
    (`nights.ts` `eveningPlans`);
  - **Last week** (§6) at the end, from the second week.

  Links are only `https://yeackbot.com/go/<id>` (the tap counts); web and newsletter text passes `safeFragment` and
  everything is HTML-escaped.
  - **Sending.** Google product `gmail_send`: its own consent (gmail.send + openid email), refresh token and the
    account's verified address (secret `gmail_send.address`, from the id_token). The only recipient is that address
    (From = To); no `to` parameter exists. guardedFetch allows `POST …/messages/send` only on the gmail_send client;
    the read-only Gmail client still can't send, and nothing can draft, modify or trash.
  - **Idempotent.** `email_state` 'sending' is written before the call: a run that finds it still 'sending' (the
    process stopped mid-call) never sends again. Gmail busy (5xx, 429, network) → the next tick tries again until
    20:30, then texts. Not connected, or refused → texts at once, with a line saying how to get it by email.
  - **Settings → Email & photos → Email me**: Connect (consent), the address, the last email, "Send a test email",
    Disconnect (the Google grant is revoked only when nothing else is connected).
- **The text.** One text for the whole week, like the brief since #84 (owner, 2026-10-25: everything in the text),
  laid out by day like the email: "Thu Oct 29: busy (Dinner 7pm; +2 more)" or "away (<trip>)", or the day and its
  picks as "1. <title> · <venue>, 10pm · yeackbot.com/go/<id>" ("(Recurring Events)" after a listing's title). Web text
  and plan titles pass `safeFragment`; a text that still fails the outbound rules falls back to counts per day and
  yeackbot.com/picks.
  Texts may only carry yeackbot.com links, so `/go/<id>` (behind Cloudflare Access) counts the tap and redirects
  (302) to the stored, re-normalized ticket page. The service worker leaves `/go/` to the browser. Web text passes
  `safeFragment` (no URLs, phones, emails, handles or money) and `checkOutboundText`.
- **The web.** `/picks` shows the latest week: date, venue, the why, a "Get tickets on <site>" link through /go,
  "I'm going" / "Not for me" / Undo, and the running answer counts. Settings → Agent has the toggle, day, time,
  events per free day, city and search cap.

## 8. Newsletters (`newsletters.ts`)

Through the read-only Gmail grant (nothing when Gmail isn't connected or events.newsletters is off):
- **Which.** `newer_than:9d … unsubscribe (events OR "this week" OR lineup OR …)`, then by From / Subject: a ticketing
  vendor's marketing mail, or any sender whose subject reads like events and not like an order or a retail sale.
  Ticket, RSVP and order mail is the ticket source's, never read here. The newest 8 are fetched in full.
- **What Claude sees.** The text, each useful link swapped for a ref ([L3]; the URL stays local; unsubscribe,
  preferences and social links dropped), his names and greetings masked, emails, phone numbers and @handles removed,
  ≤ 6,000 characters each, through the egress choke point. One structured call (route `events_newsletter`,
  `NewsletterEvents`) → events on the free nights with the ref of their ticket / RSVP link.
- **Links.** A ref becomes the URL that newsletter carried, never one the model wrote. Newsletter links are mostly
  click-tracking redirects, so a link whose words say "Get tickets" / "RSVP" counts as a ticket link.
- Cost: one Haiku call, ~10–20K input tokens a week (≈ $0.02).

## 9. The Recurring Events calendar (`listings.ts`)

His "Recurring Events" calendar holds weekly happenings (jazz nights, comedy, night markets) as listings, not plans.
- **Which.** Timed instances in the week on a non-primary calendar whose name says "recurring", recurring with no
  invitees.
- **When he's free.** Only on a free day (§2): a busy day's section shows his plans instead. A daytime one (a weekend
  market) also needs 2 hours of it clear of plans (a 10–6 market with a 3 pm plan still has the morning).
- **Which ones.** One instance per series (the earliest free one), scored like any pick (taste, kind, learned), at
  most 2 a day; they take the day's first slots and the picks fill the rest. A series shown in the last 21 days that
  he didn't act on (no going, no tap) rests.
  The kind comes from the title, else the venue ("… Comedy Theater"), else music words ("Jazz", "Sounds").
- Live data (DB copies, nothing sent by yeackbot): the week of Oct 26 had 22 listings and one free night. For the week
  of Oct 29 (2026-10-28 preview), Monday was the only free evening: Monday's jazz night plus two web picks with ticket
  pages; the other six days listed his plans (Halloween weekend: 9 plans on Saturday, shown as 4 + "and 5 more").

## Not done / follow-ups

- Replying to a pick by text ("going 2", "not for me 2") isn't parsed yet: answers are on the web.
- **The profile is thin until Gmail is connected.** There are no ticket events yet, so performers and genres are
  empty, and no newsletters are read. Until then, ranking mostly follows kinds and venues from the calendar.
- "Email me" needs the owner's one-time consent (Settings → Email & photos), and the Gmail API enabled in the GCP
  project (the same step Gmail reading needs). Until then the picks come by text, saying so.
- "Remind me a month before <show> and send ticket links" (the 2026-10-22 text) is a separate watchlist feature.
