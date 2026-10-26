<!-- Owner request 2026-10-22. Amends PLAN.md: yeackbot may search the public web (Anthropic's server-side web search) for this one feature. -->

# Weekly event picks

> "Yeackbot will need to be able to surf the web to find ticket links and events for me to send me the weekly event
> digest. I want a weekly event digest of cool events you think I might like, where I have no event that night in
> my calendar, with links to get the tickets, and suggestions based on prior events ticketed in email and on
> calendar. Regularly check which events I'm going to to refine your recommendations." (owner, 2026-10-22)

Once a week (Settings → Agent → Event picks: default Monday 09:30) yeackbot texts the owner up to 5 public events on
the nights of the coming week his calendar is free, each with a link to buy tickets. It learns from which ones he
goes to. Code: `packages/server/src/intel/eventPicks/`; web: `/picks`; migration 027.

## 1. The run (`run.ts`, job `event-picks`, every 10 min; acts only on the picks day from events.time to 21:00)

1. **Outcomes first**: which earlier picks he went to (§6), so this week learns from last week.
2. **Free nights** for the 7 nights starting today (§2). None → the run is `empty`: nothing is searched or sent.
3. **Taste** (§3) and the **city** (events.city, else the home city: travel.home_city or his location fact).
4. **Candidates**: one Claude Haiku 5.5 call with the server-side `web_search` tool (~40% of events.max_searches).
5. **Filter**: each must be on a free night inside the window and name a venue (not TBA / Unknown), be a public
   kind (no parties), be one real event (eventKey: date + venue + title words), and never one sent in an earlier
   week. Dropped rows stay in `event_picks` with the reason.
6. **Score** (§5), then **ticket pages**: one targeted search per top candidate that has no event-specific page yet
   (the rest of the search budget). No search is spent on a busy night or a duplicate.
7. **Choose** ≤ events.max_picks, then **send**: an intro text plus one text per pick, purpose `events`, stable
   client refs. If delivery isn't configured or it's quiet hours, the run stays `ready` (the web shows it) and a
   later tick sends it the same day.

A failed search (API error, budget cap, unreadable answer) is retried every 30 min, at most 3 times a week.

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
- **learned**: one Thompson draw per feature value (kind, genre, venue, performer) from earlier picks. Went is +1
  yes, tapped the link +0.5 yes, "not for me" +1 no, and a night passed untouched +0.25 no.
- **link**: a ticket page scores 1, resale 0.6, a listing 0.2.

Choosing: at most 2 a night and 2 of one kind while others are left. With probability 0.2, the last slot goes to a 🎲
"something different": the best event of a kind he rarely goes to.

## 6. Did he go? (`outcomes.ts`, job `event-picks-outcomes` daily 06:45 and before each run)

A sent pick becomes **going** when one of these shows up for that date:
- a ticket event (same performer, an alike title, or the same venue);
- a calendar entry naming a performer, the title's words or the venue;
- a Partiful RSVP with an alike title or the same venue.

Otherwise it becomes **passed** once the night is over. A late calendar entry or ticket within 3 days still turns
passed into going. His own answers on the web (going / not for me / undo) are never overwritten.

## 7. Texts and the web

- **The texts.** One text per pick, written like the brief:
  "1. Thu Oct 29 · <title>" / "<venue>, 10pm. <why, in the second person>." / "Tickets: yeackbot.com/go/<id>".
  Texts may only carry yeackbot.com links, so `/go/<id>` (behind Cloudflare Access) counts the tap and redirects
  (302) to the stored, re-normalized ticket page. The service worker leaves `/go/` to the browser. Web text passes
  `safeFragment` (no URLs, phones, emails, handles or money) and `checkOutboundText`.
- **The web.** `/picks` shows the latest week: date, venue, the why, a "Get tickets on <site>" link through /go,
  "I'm going" / "Not for me" / Undo, and the running answer counts. Settings → Agent has the toggle, day, time,
  picks per week, city and search cap.

## Not done / follow-ups

- Replying to a pick by text ("going 2", "not for me 2") isn't parsed yet: answers are on the web.
- **The profile is thin until Gmail is connected.** There are no ticket events yet, so performers and genres are
  empty. Until then, ranking mostly follows kinds and venues from the calendar.
- "Remind me a month before <show> and send ticket links" (the 2026-10-22 text) is a separate watchlist feature.
