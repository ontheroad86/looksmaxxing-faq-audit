#!/usr/bin/env node
/**
 * faq-audit.js — looksmaxxing.guide FAQ relevance audit
 *
 * Every article on looksmaxxing.guide ships an FAQ block (visible <section class="faq-section">
 * plus FAQPage JSON-LD). Some are hand-written and article-specific. Some fall back to a shared
 * generic block that has nothing to do with the article.
 *
 * Example: "Is Bonesmashing Dangerous?" — an article about people breaking their own facial bones
 * with hammers — answers "Where did this term originate? / Should I use this terminology?"
 *
 * This measures how many of the ~200 articles are in that state. It reports; it does not rewrite.
 * These are YMYL medical pages: deciding WHICH FAQ is wrong is a measurement, writing a
 * replacement answer about surgery or injectables is not something a script should do.
 *
 * Usage: node faq-audit.js
 * Output: dist/index.html + dist/report.json
 */

const fs = require('fs');
const path = require('path');

const SITEMAP = 'https://looksmaxxing.guide/sitemap-0.xml';
const CONCURRENCY = 8;   // this is someone's live production site, not a load-test target
const THRESHOLD = 0.34;  // min share of title terms that must appear in the FAQ

// Article pillars. /en/glossary/* and /en/influencers/* are also 2-segment paths but are
// term/profile pages, not articles — excluded deliberately.
const PILLARS = new Set([
  'looks', 'fitness', 'style', 'money', 'dating',
  'mindset', 'masculinity', 'creativity', 'charisma',
]);

const STOP = new Set((
  'a an the and or but if of to in on for with without from by at as is are was were be been being ' +
  'this that these those it its you your yours he him his she her they them their we our us do does ' +
  'did done have has had can could should would will shall may might must not no nor so than then ' +
  'there here what which who whom when where why how all any both each few more most other some such ' +
  'only own same too very just about into over under again further once during before after above ' +
  'below up down out off i me my mine now get got make made take does what'
).split(/\s+/));

const words = (s) =>
  (s.toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || []).filter((w) => !STOP.has(w));

const stripTags = (h) =>
  h
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#39;|&rsquo;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&[a-z]+;|&#\d+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        out[i] = { url: items[i], error: String(err && err.message ? err.message : err) };
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function isArticle(url) {
  const m = url.match(/^https:\/\/looksmaxxing\.guide\/en\/([^/]+)\/([^/]+)\/$/);
  return !!(m && PILLARS.has(m[1]));
}

function analyse(url, html) {
  const titleM = html.match(/<h1 class="article__title"[^>]*>([\s\S]*?)<\/h1>/);
  const eyebrowM = html.match(/<span class="article__eyebrow"[^>]*>([\s\S]*?)<\/span>/);
  const title = titleM ? stripTags(titleM[1]) : '';
  const cluster = eyebrowM ? stripTags(eyebrowM[1]) : '';

  const bodyStart = html.indexOf('id="article-body"');
  const faqStart = html.indexOf('<section class="faq-section"');
  const articleEnd = html.indexOf('</article>');

  const bodyHtml =
    bodyStart === -1
      ? ''
      : html.slice(bodyStart, faqStart > bodyStart ? faqStart : articleEnd > bodyStart ? articleEnd : undefined);
  const body = stripTags(bodyHtml);

  const faqHtml = faqStart === -1 ? '' : html.slice(faqStart, html.indexOf('</section>', faqStart));
  const faqText = stripTags(faqHtml);

  const questions = [...faqHtml.matchAll(/faq-item__question[^>]*>([\s\S]*?)<\/summary>/g)].map((m) =>
    stripTags(m[1])
  );

  const hasFaq = questions.length > 0;

  // Signal 1 — does the FAQ mention what the article is actually about?
  const titleTerms = [...new Set(words(title))];
  const faqWordSet = new Set(words(faqText));
  const titleHits = titleTerms.filter((t) => faqWordSet.has(t));
  const titleOverlap = titleTerms.length ? titleHits.length / titleTerms.length : 0;

  // Signal 2 — is the FAQ's vocabulary drawn from this article at all?
  const faqTerms = [...new Set(words(faqText))];
  const bodyWordSet = new Set(words(body));
  const bodyOverlap = faqTerms.length
    ? faqTerms.filter((t) => bodyWordSet.has(t)).length / faqTerms.length
    : 0;

  // Bug: markdown link syntax rendered as literal text inside answers
  const markdownLeak = /\[[^\]\n]{2,}\]\([^)\s]+\)/.test(faqText);

  return {
    url,
    title,
    cluster,
    hasFaq,
    faqCount: questions.length,
    questions,
    fingerprint: questions.join(' | '),
    titleOverlap: +titleOverlap.toFixed(3),
    bodyOverlap: +bodyOverlap.toFixed(3),
    titleTerms,
    titleHits,
    markdownLeak,
    bodyWords: words(body).length,
    offTopic: hasFaq && titleOverlap < THRESHOLD,
  };
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function renderHtml(rows, stats, dupes) {
  const flagged = rows.filter((r) => r.offTopic).sort((a, b) => a.titleOverlap - b.titleOverlap);
  const clean = rows.filter((r) => r.hasFaq && !r.offTopic).sort((a, b) => a.titleOverlap - b.titleOverlap);
  const noFaq = rows.filter((r) => !r.hasFaq);
  const leaks = rows.filter((r) => r.markdownLeak);

  const row = (r) => `<tr${r.offTopic ? ' class="bad"' : ''}>
    <td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title || r.url)}</a>
      <span class="cluster">${esc(r.cluster)}</span></td>
    <td class="num">${r.faqCount}</td>
    <td class="num">${r.titleOverlap.toFixed(2)}</td>
    <td class="num">${r.bodyOverlap.toFixed(2)}</td>
    <td class="q">${esc(r.questions.slice(0, 2).join(' · '))}</td>
  </tr>`;

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>FAQ relevance audit — looksmaxxing.guide</title>
<style>
:root{--bg:#0f1115;--fg:#e6e8ec;--mut:#8b93a1;--acc:#D19C14;--bad:#E5443B;--line:#242833}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1080px;margin:0 auto;padding:48px 24px 96px}
h1{font-size:28px;margin:0 0 8px;letter-spacing:-.01em}
h2{font-size:18px;margin:48px 0 12px;color:var(--acc)}
p{color:var(--mut);margin:0 0 16px;max-width:70ch}
.lede{color:var(--fg);font-size:17px}
.cards{display:flex;gap:12px;flex-wrap:wrap;margin:28px 0}
.card{flex:1 1 160px;border:1px solid var(--line);border-radius:10px;padding:16px}
.card b{display:block;font-size:32px;font-weight:600;line-height:1.1}
.card span{color:var(--mut);font-size:13px}
.card.hot b{color:var(--bad)}
table{width:100%;border-collapse:collapse;margin:12px 0 0;font-size:14px}
th{text-align:left;color:var(--mut);font-weight:500;border-bottom:1px solid var(--line);padding:8px 10px;font-size:12px;text-transform:uppercase;letter-spacing:.04em}
td{border-bottom:1px solid var(--line);padding:10px;vertical-align:top}
td.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
tr.bad td{background:rgba(229,68,59,.06)}
a{color:var(--acc);text-decoration:none}a:hover{text-decoration:underline}
.cluster{display:block;color:var(--mut);font-size:12px}
.q{color:var(--mut);font-size:13px}
.note{border-left:2px solid var(--acc);padding:2px 0 2px 14px;margin:20px 0;color:var(--mut)}
code{background:#181b22;padding:1px 5px;border-radius:4px;font-size:13px}
footer{margin-top:64px;color:var(--mut);font-size:13px;border-top:1px solid var(--line);padding-top:16px}
</style></head><body><main>

<h1>FAQ relevance audit — looksmaxxing.guide</h1>
<p class="lede">Every article ships an FAQ block. Some are written for the article. Some fall back
to a shared generic block. This measures which is which across the whole English catalogue.</p>

<div class="cards">
  <div class="card${stats.offTopic ? ' hot' : ''}"><b>${stats.offTopic}</b><span>articles with an off-topic FAQ</span></div>
  <div class="card"><b>${stats.withFaq}</b><span>articles with an FAQ block</span></div>
  <div class="card"><b>${stats.noFaq}</b><span>articles with no FAQ at all</span></div>
  <div class="card"><b>${stats.leaks}</b><span>with raw markdown in answers</span></div>
</div>

<p>Scanned <strong>${stats.scanned}</strong> article URLs from
<code>sitemap-0.xml</code> (${stats.sitemapTotal} total URLs; glossary terms, influencer profiles,
pillar indexes and legal pages excluded).</p>

<h2>The clearest case</h2>
<div class="note"><strong>Is Bonesmashing Dangerous?</strong> — an article about people striking their
own facial bones to break them. Its FAQ asks <em>“Where did this term originate?”</em>,
<em>“Is this term used seriously?”</em>, <em>“Should I use this terminology?”</em>
On a site that positions itself as harm-reduction, a reader asking whether something is dangerous
is answered with vocabulary questions.</div>

<h2>How this is measured</h2>
<p><strong>Title overlap</strong> — the share of the article title's content words that appear
anywhere in its FAQ. An FAQ written for the article uses the article's nouns; a generic fallback
does not mention them at all. Flagged below <code>${THRESHOLD}</code>.</p>
<p><strong>Body overlap</strong> — the share of the FAQ's own vocabulary that also occurs in the
article body. Reported as a second, independent view rather than merged into one score, so a
disagreement between the two is visible instead of averaged away.</p>

${
  dupes.length
    ? `<h2>Shared FAQ blocks (${dupes.length})</h2>
<p>These exact FAQ question sets appear on more than one article — direct evidence that the block is
injected rather than authored per article. The same text is duplicated in both the rendered HTML and
the <code>FAQPage</code> JSON-LD.</p>
${dupes
  .map(
    (d) => `<div class="note"><strong>${d.count} articles</strong> share:<br>${esc(
      d.questions.slice(0, 3).join(' · ')
    )}<br><br>${d.urls.map((u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u.replace('https://looksmaxxing.guide', ''))}</a>`).join('<br>')}</div>`
  )
  .join('')}`
    : ''
}

<h2>Flagged — FAQ does not match the article (${flagged.length})</h2>
<table><thead><tr><th>Article</th><th class="num">FAQ n</th><th class="num">Title</th><th class="num">Body</th><th>First two questions</th></tr></thead>
<tbody>${flagged.map(row).join('')}</tbody></table>

${
  leaks.length
    ? `<h2>Raw markdown rendered as text (${leaks.length})</h2>
<p>FAQ answers are emitted as plain strings, so markdown link syntax reaches the reader literally —
brackets, parentheses and the raw path. It is also duplicated into the JSON-LD.</p>
<table><thead><tr><th>Article</th><th class="num">FAQ n</th><th class="num">Title</th><th class="num">Body</th><th>First two questions</th></tr></thead>
<tbody>${leaks.map(row).join('')}</tbody></table>`
    : ''
}

${
  noFaq.length
    ? `<h2>No FAQ block (${noFaq.length})</h2>
<table><thead><tr><th>Article</th><th class="num">FAQ n</th><th class="num">Title</th><th class="num">Body</th><th>First two questions</th></tr></thead>
<tbody>${noFaq.map(row).join('')}</tbody></table>`
    : ''
}

<h2>Passing (${clean.length})</h2>
<p>Lowest-scoring first, so the boundary of the threshold is inspectable rather than hidden.</p>
<table><thead><tr><th>Article</th><th class="num">FAQ n</th><th class="num">Title</th><th class="num">Body</th><th>First two questions</th></tr></thead>
<tbody>${clean.map(row).join('')}</tbody></table>

<h2>What this deliberately does not do</h2>
<p>It does not write replacement FAQs. Deciding that an FAQ is off-topic is a measurement.
Authoring a new answer about jaw surgery, fat-dissolving injections or GLP-1 dosing is an editorial
and medical act, and a script has no business doing it on YMYL pages. The output is a work list for
the editorial team, not a patch.</p>
<p>It also does not touch the two other defects found while reading the source: hreflang clusters
that are non-reciprocal and missing their self-reference, and a <code>lastmod</code> value identical
across every URL in the sitemap because a build timestamp is leaking into it. Both are real; neither
belongs in this scan.</p>

<footer>Generated by <a href="https://github.com/ontheroad86/looksmaxxing-faq-audit">faq-audit.js</a>
· fetched live, concurrency capped at ${CONCURRENCY} · raw data in
<a href="./report.json">report.json</a></footer>
</main></body></html>`;
}

(async () => {
  const t0 = Date.now();
  process.stdout.write('fetching sitemap… ');
  const xml = await (await fetch(SITEMAP)).text();
  const all = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
  const urls = all.filter(isArticle);
  console.log(`${all.length} urls, ${urls.length} articles`);

  process.stdout.write(`fetching ${urls.length} articles (concurrency ${CONCURRENCY})… `);
  const rows = (
    await mapLimit(urls, CONCURRENCY, async (url) => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return analyse(url, await res.text());
    })
  ).filter((r) => r && !r.error);
  console.log(`${rows.length} ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  const byPrint = new Map();
  for (const r of rows) {
    if (!r.hasFaq) continue;
    if (!byPrint.has(r.fingerprint)) byPrint.set(r.fingerprint, []);
    byPrint.get(r.fingerprint).push(r);
  }
  const dupes = [...byPrint.values()]
    .filter((g) => g.length > 1)
    .sort((a, b) => b.length - a.length)
    .map((g) => ({ count: g.length, questions: g[0].questions, urls: g.map((r) => r.url) }));

  const stats = {
    sitemapTotal: all.length,
    scanned: rows.length,
    withFaq: rows.filter((r) => r.hasFaq).length,
    noFaq: rows.filter((r) => !r.hasFaq).length,
    offTopic: rows.filter((r) => r.offTopic).length,
    leaks: rows.filter((r) => r.markdownLeak).length,
    sharedBlocks: dupes.length,
    threshold: THRESHOLD,
  };

  console.log('\n--- result ---');
  console.log(stats);
  console.log('\noff-topic:');
  rows
    .filter((r) => r.offTopic)
    .sort((a, b) => a.titleOverlap - b.titleOverlap)
    .forEach((r) => console.log(`  ${r.titleOverlap.toFixed(2)}  n=${r.faqCount}  ${r.title}`));

  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'dist', 'index.html'), renderHtml(rows, stats, dupes));
  fs.writeFileSync(
    path.join(__dirname, 'dist', 'report.json'),
    JSON.stringify({ stats, dupes, rows }, null, 2)
  );
  console.log('\nwrote dist/index.html and dist/report.json');
})();
