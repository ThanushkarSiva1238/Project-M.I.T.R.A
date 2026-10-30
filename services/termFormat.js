/** Turns a dictionary entry into the same Markdown layout the tutor uses. */
function termToMarkdown(t, aiGenerated) {
  const parts = [];
  parts.push(`## ${t.term}${t.pronunciation ? `  ${t.pronunciation}` : ''}`);
  if (t.simple_english) parts.push(`## Simple English\n${t.simple_english}`);
  if (t.tamil) parts.push(`## தமிழ் விளக்கம் (Tamil)\n${t.tamil}`);
  if (t.definition) parts.push(`## Psychology definition\n${t.definition}`);
  if (t.example) parts.push(`## Example sentence\n${t.example}`);
  if (t.everyday_example) parts.push(`## Everyday example\n${t.everyday_example}`);
  let related = t.related;
  if (typeof related === 'string') {
    try {
      related = JSON.parse(related);
    } catch (_) {
      related = [];
    }
  }
  if (Array.isArray(related) && related.length) parts.push(`**Related terms:** ${related.join(', ')}`);
  parts.push(
    aiGenerated
      ? '_AI-generated and not verified. Please check important definitions against your lecture notes or textbook. It was added to your dictionary as an unverified entry._'
      : '_From your MITRA dictionary (no AI request was made)._'
  );
  return parts.join('\n\n');
}

module.exports = { termToMarkdown };
