/**
 * Extraction Prompt Templates
 * Reusable prompts for AI data extraction
 */

/**
 * Build extraction prompt
 */
function buildExtractionPrompt(fieldSchema, sourceName) {
  const fields = Object.keys(fieldSchema);
  const fieldDescriptions = Object.entries(fieldSchema)
    .map(([key, desc]) => `- ${key}: ${desc}`)
    .join('\n');

  return `Extract structured data from this screenshot of "${sourceName}".

**FIELDS TO EXTRACT:**
${fieldDescriptions}

**CRITICAL RULES:**
1. Return ONLY a JSON array of objects - NO markdown blocks
2. Each object MUST have these exact keys: ${fields.join(', ')}
3. Extract ALL visible rows/records (minimum 10, maximum 50 per page)
4. For long text fields (descriptions, comments), keep under 100 characters and add "..."
5. Use null for missing fields
6. Preserve exact text from image (don't correct spelling)
7. If you see pagination, extract only current page
8. Keep total response under 25KB - prioritize complete objects over quantity

**EXAMPLE OUTPUT:**
[
  {${fields.map(f => `"${f}":"example value"`).join(',')}},
  {${fields.map(f => `"${f}":"example value"`).join(',')}}
]

Extract ALL visible data now:`;
}

module.exports = {
  buildExtractionPrompt
};