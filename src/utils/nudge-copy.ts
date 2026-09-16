/** Witty / banter copy for event RSVP nudges. No LLM — seeded templates. */

function pick<T>(items: T[], seed: string): T {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return items[h % items.length]!;
}

function shortName(raw: string, max = 42): string {
  const t = raw.trim().replace(/\s+/g, ' ');
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1).trimEnd()}…`;
}

type Eventish = { name: string; venue?: string | null };

function vibe(name: string): 'music' | 'food' | 'sports' | 'party' | 'work' | 'generic' {
  const n = name.toLowerCase();
  if (/concert|gig|music|dj|festival|band|rap|indie|jazz|karaoke/.test(n)) return 'music';
  if (/food|brunch|dinner|cafe|coffee|pizza|bar\b|brew|taste|eat/.test(n)) return 'food';
  if (/match|game|cricket|football|soccer|run|marathon|gym|yoga|fit/.test(n)) return 'sports';
  if (/party|night|club|rave|celebrate|birthday|wedding|hangout/.test(n)) return 'party';
  if (/meet|hack|workshop|conference|talk|seminar|office|pitch/.test(n)) return 'work';
  return 'generic';
}

/** Combined daily nudge while status = interested. */
export function interestedNudgeCopy(events: Eventish[], seed: string): {
  title: string;
  body: string;
} {
  const count = events.length;
  const first = shortName(events[0]?.name || 'your event');
  if (count <= 1) {
    const titles = [
      `${first} is still on the maybe pile`,
      `Psst — ${first} wants a decision`,
      `${first}: crush or pass?`,
      `Your calendar’s side-eyeing ${first}`,
    ];
    const bodies = [
      'Tap in, tell a friend, or stop haunting the interested list.',
      'Going? Interested forever is a personality. Commit a little.',
      'Share it, or it’ll keep living rent-free in your maybe folder.',
      'Friends won’t know unless you squeal. Or go.',
    ];
    return { title: pick(titles, seed), body: pick(bodies, seed + 'b') };
  }

  const titles = [
    `${count} events are waiting on your vibe check`,
    `You bookmarked ${count} things. Bold.`,
    `${count} maybes. Zero plot armor.`,
    `Your interested list is throwing a party without you`,
  ];
  const bodies = [
    `Soonest up: ${first}. Go, share, or declutter the guilt.`,
    `Start with ${first} — friends love a decisive text.`,
    `${first} + ${count - 1} more. Pick a main character arc today.`,
    `Don’t let ${first} expire as a screenshot in your camera roll.`,
  ];
  return { title: pick(titles, seed), body: pick(bodies, seed + 'b') };
}

/** Single going reminder ~N hours before start — title varies with event vibe. */
export function goingNudgeCopy(event: Eventish, seed: string): {
  title: string;
  body: string;
} {
  const name = shortName(event.name || 'your event');
  const v = vibe(event.name || '');
  const venue = event.venue?.trim();

  const byVibe: Record<string, string[]> = {
    music: [
      `${name} is warming up`,
      `Doors soon for ${name}`,
      `${name} — headphones off, life on`,
    ],
    food: [
      `${name} is plating up soon`,
      `Hunger countdown: ${name}`,
      `${name} won’t save you a seat forever`,
    ],
    sports: [
      `${name} — lace up`,
      `Game clock’s ticking on ${name}`,
      `${name} wants your A-game`,
    ],
    party: [
      `${name} is about to go off`,
      `Main-character window: ${name}`,
      `${name} — fashionably not late`,
    ],
    work: [
      `${name} is on the clock`,
      `Showtime for ${name}`,
      `${name} — notes ready?`,
    ],
    generic: [
      `${name} is almost here`,
      `Heads up: ${name}`,
      `${name} — you’re on the list`,
      `T-minus soon for ${name}`,
    ],
  };

  const titles = byVibe[v] ?? byVibe.generic!;
  const bodies = [
    venue
      ? `You’re going. ${venue} is waiting — don’t ghost it.`
      : 'You’re going. Show up like you meant it.',
    'Calendar says you’re in. Future-you says thank you.',
    'Funny how “going” feels serious until the alarm hits. This is that alarm.',
    'Plot twist: attending is the whole bit. See you there.',
    venue
      ? `Route check for ${venue}. Quip optional. Presence not.`
      : 'Soft reminder, hard RSVP. Don’t flake on yourself.',
  ];

  return { title: pick(titles, seed + v), body: pick(bodies, seed + 'body') };
}
