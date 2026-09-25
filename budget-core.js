/* Budget core — reads what you type or paste into an expense.
   Shared by the Budget app and the Hub's quick-log box, so both read "chai 20"
   the same way and guess the same category. */
(function () {
  'use strict';

  // Words that point at a category before you've taught the app your own
  var KEYWORDS = {
    food: ['chai', 'tea', 'coffee', 'lunch', 'dinner', 'breakfast', 'snack', 'snacks', 'maggi', 'thali', 'canteen', 'mess',
           'zomato', 'swiggy', 'pizza', 'burger', 'juice', 'milk', 'bread', 'fruit', 'fruits', 'biryani', 'dosa', 'samosa',
           'food', 'blinkit', 'zepto', 'instamart', 'icecream', 'ice', 'cafe', 'restaurant', 'dominos', 'kfc', 'mcd', 'water'],
    travel: ['auto', 'uber', 'ola', 'rapido', 'bus', 'metro', 'train', 'cab', 'taxi', 'petrol', 'fuel', 'diesel', 'rickshaw',
             'toll', 'parking', 'flight', 'irctc', 'ticket', 'travel', 'fare'],
    shopping: ['amazon', 'flipkart', 'myntra', 'ajio', 'meesho', 'clothes', 'shirt', 'shoes', 'jeans', 'tshirt', 'bag',
               'stationery', 'pen', 'notebook', 'book', 'books', 'shopping', 'soap', 'shampoo', 'toiletries'],
    fun: ['movie', 'movies', 'pvr', 'inox', 'game', 'games', 'steam', 'party', 'outing', 'trip', 'concert', 'bowling',
          'netflix', 'spotify', 'prime', 'hotstar', 'youtube', 'gift'],
    bills: ['recharge', 'wifi', 'internet', 'electricity', 'rent', 'bill', 'bills', 'jio', 'airtel', 'vi', 'fees', 'fee',
            'laundry', 'gas', 'emi', 'insurance', 'subscription', 'hostel']
  };

  function words(s) { return String(s || '').toLowerCase().match(/[a-z]+/g) || []; }

  // Your own history wins: the category you used most for the same note, then for its first word
  function guessCat(note, expenses) {
    var n = String(note || '').trim().toLowerCase();
    if (!n) return null;
    var first = words(n)[0];
    var exact = {}, byWord = {};
    (expenses || []).slice(-400).forEach(function (e) {
      var en = String(e.note || '').trim().toLowerCase();
      if (!en || !e.cat) return;
      if (en === n) exact[e.cat] = (exact[e.cat] || 0) + 1;
      if (first && words(en)[0] === first) byWord[e.cat] = (byWord[e.cat] || 0) + 1;
    });
    var top = function (m) { var k = Object.keys(m).sort(function (a, b) { return m[b] - m[a]; })[0]; return k || null; };
    var hit = top(exact) || top(byWord);
    if (hit) return hit;
    var ws = words(n);
    for (var cat in KEYWORDS) {
      if (ws.some(function (w) { return KEYWORDS[cat].indexOf(w) !== -1; })) return cat;
    }
    return null;
  }

  // "chai 20", "80 lunch", "₹1,200 shoes", "dinner 600 split 3"
  function parseEntry(text, expenses) {
    var t = String(text || '').trim();
    if (!t) return null;
    var split = null;
    t = t.replace(/\s*(?:split|÷|\/)\s*(\d{1,2})\s*(?:ways?|people)?\s*$/i, function (_, n) { split = +n; return ''; }).trim();
    var m = t.match(/(?:₹|rs\.?|inr)?\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(?:₹|rs|rupees?)?/i);
    if (!m) return { amt: null, note: t, cat: guessCat(t, expenses), split: split };
    var amt = parseFloat(m[1].replace(/,/g, ''));
    var note = (t.slice(0, m.index) + ' ' + t.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
    note = note.replace(/^(for|on)\s+/i, '');
    return { amt: isFinite(amt) && amt > 0 ? amt : null, note: note, cat: guessCat(note, expenses), split: split && split > 1 ? split : null };
  }

  // Bank and UPI SMS: "Rs.250.00 debited from A/c XX1234 ... to VPA zomato@hdfcbank" and similar
  function parseSMS(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return null;
    var am = t.match(/(?:₹|rs\.?|inr)\s*([\d,]+(?:\.\d{1,2})?)/i) || t.match(/([\d,]+(?:\.\d{1,2})?)\s*(?:₹|rs\.?|inr)\b/i);
    if (!am) return null;
    var amt = parseFloat(am[1].replace(/,/g, ''));
    if (!(amt > 0)) return null;
    var credit = /\b(credited|received|refund(?:ed)?|deposited)\b/i.test(t) && !/\bdebited\b/i.test(t);
    var who = null;
    var vpa = t.match(/\b([a-z0-9._-]{2,})@[a-z]{2,}\b/i);
    // A payment names who it went to; money received names who it came from
    var tail = "\\s+(?:vpa\\s+)?([A-Za-z][A-Za-z0-9 &.'-]{1,30}?)(?=\\s+(?:on|via|ref|upi|using|a\\/c|avl|bal|txn|dated)\\b|[.,;]|$)";
    var preps = credit ? ['from', 'by'] : ['to', 'at', 'towards'];
    var named = null;
    for (var i = 0; i < preps.length && !named; i++) {
      var hit = t.match(new RegExp('\\b' + preps[i] + tail, 'i'));
      if (hit && !/^(a\/c|ac|your|account|xx|upi)/i.test(hit[1])) named = hit;
    }
    if (named) who = named[1];
    else if (vpa) who = vpa[1];
    if (who) {
      who = who.replace(/[._-]+/g, ' ').replace(/\b(pay|payment|upi|ok[a-z]*|ybl|paytm|razorpay)\b/gi, '').replace(/\s+/g, ' ').trim();
      if (who) who = who.charAt(0).toUpperCase() + who.slice(1).toLowerCase();
    }
    return { amt: amt, note: who || '', credit: credit };
  }

  window.BudgetCore = { guessCat: guessCat, parseEntry: parseEntry, parseSMS: parseSMS };
})();
