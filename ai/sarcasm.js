/* CLEAR sarcasm structure. The most common shape of sarcasm is praise with nothing in it
   ("Fantastic", "My day is complete") placed next to a bad situation ("the printer is jammed").
   This file finds the empty-praise clauses. A sentiment model then judges whether the other
   clauses describe something bad (see ai/offscreen.js). No model is needed for the functions here. */
(function (g) {
  const EVAL = '(?:great|fantastic|wonderful|awesome|perfect|brilliant|lovely|nice|amazing|excellent|super|superb|terrific|marvell?ous|splendid|fabulous|beautiful|cool|sweet|delightful|outstanding|incredible|magnificent|genius|good|neat|charming|classy|stellar)';
  const LEAD = "(?:(?:oh|ah|well|wow|yay|ooh|just|how|so|really|absolutely|simply|truly|that's|thats|that is|this is|it's|its|it is|what a|well that's|isn't that|how very)[, ]+)*";
  const BARE = new RegExp('^' + LEAD + EVAL + '(?: (?:job|work|one|stuff|going|start|timing|day|idea|move|touch|way to (?:start|end) (?:the|my) (?:day|week)))?$', 'i');
  const CLOSER = /^(?:(?:and |well |so |now )?(?:my|the) (?:day|week|morning|evening|night|life|weekend) is (?:now |finally )?(?:complete|made|perfect)|best (?:day|week|monday|morning|start) ever|living the dream|(?:just|exactly) what i (?:needed|wanted)(?: today| right now)?|could(?:n'?t| not) be (?:happier|better)|(?:i )?(?:just |really |absolutely )?love (?:it|that|this|my life|mondays?)|love that for (?:me|us)|thanks(?: a lot| so much| for that)?|thank you(?: so much| very much)?|lucky (?:me|us)|can'?t wait|i'?m (?:so |absolutely |totally )?(?:thrilled|delighted|overjoyed|ecstatic)|what a (?:time to be alive|treat|joy|delight|surprise|day)|10\/10|five stars|way to go|well done|good times|so (?:much )?fun|yay|wow|what fun|(?:i'?m )?(?:so |really )?(?:glad|happy) (?:about (?:that|this)|i (?:came|asked|bothered)))$/i;
  const CONTRAST = /^(?:but|however|although|though|yet|except|unfortunately|sadly|still|even though|while|whereas|luckily|fortunately)\b/i;
  /* A clause that says things went well cannot be "the bad situation", however negative its words look.
     A sentiment model reads words, so "the bug is fixed now" scores negative on the word "bug" alone. */
  const GOOD = /\b(?:fixed|resolved|solved|sorted(?: out)?|patched|repaired|restored|recovered|passed|approved|accepted|merged|shipped|launched|deployed|released|arrived|delivered|went (?:well|smoothly|fine|great|through)|smoothly|on time|early|ahead of schedule|under budget|succeeded|success(?:ful|fully)?|back (?:up|online|to normal)|up and running|works? (?:now|again|fine|well)|working (?:now|again|fine|well)|all (?:good|set|clear|sorted|done)|no (?:more )?(?:bugs?|errors?|issues?|problems?|delays?|downtime|changes)|easier|better now|improved|cleared|can ship|can go ahead|good to go|sign(?:ed)? off)\b/i;
  const NOT_GOOD = /\b(?:not|never|n'?t|isn'?t|aren'?t|wasn'?t|weren'?t|hasn'?t|haven'?t|didn'?t|doesn'?t|won'?t|still|yet to be|failed to)\s+(?:\w+\s+){0,2}(?:fixed|resolved|solved|sorted|passed|working|works|approved|merged|shipped|deployed|done|ready|back|through)\b/i;
  const looksGood = (c) => GOOD.test(c) && !NOT_GOOD.test(c);

  function clauses(text) {
    return String(text || '').split(/(?:[.!?;…]+|:)(?:\s+|$)|\s+[-–—]+\s+|,\s+|\n+/)
      .map((c) => c.trim().replace(/^["'“”‘’(]+|["'“”‘’).!?…]+$/g, '').trim()).filter(Boolean).slice(-10);
  }
  const isBare = (c) => { const w = c.replace(/[^\w\s'\/]/g, ' ').replace(/\s+/g, ' ').trim(); return BARE.test(w) || CLOSER.test(w); };

  /* Which clauses are empty praise, and which are candidates for "the situation". */
  function plan(text) {
    const cs = clauses(text);
    const bare = [], rest = [];
    cs.forEach((c, i) => {
      if (isBare(c)) bare.push(i);
      else if (c.split(/\s+/).length >= 2 && !CONTRAST.test(c)) rest.push(i);
    });
    // "Great food, but terrible service" is mixed feedback, not sarcasm
    return { cs, bare, rest, blocked: cs.some((c) => CONTRAST.test(c)) };
  }
  /* neg: {clauseIndex: probability that the clause is negative}, from a sentiment model.
     Returns the praise/bad-news pair when there is one, otherwise null. */
  function contrast(p, neg, min) {
    if (!p.bare.length || p.blocked) return null;
    const floor = min || 0.92;
    let best = null;
    for (const i of p.rest) {
      if (!(neg[i] >= floor) || looksGood(p.cs[i])) continue;
      if (!best || neg[i] > best.neg) best = { neg: neg[i], idx: i };
    }
    if (!best) return null;
    const b = p.bare.reduce((a, i) => (Math.abs(i - best.idx) < Math.abs(a - best.idx) ? i : a), p.bare[0]);
    return { positive: p.cs[b], negative: p.cs[best.idx], strength: best.neg };
  }
  g.CLEAR_SARCASM = { clauses, isBare, looksGood, plan, contrast };
})(globalThis);
