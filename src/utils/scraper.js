const logger = require('./logger');

/**
 * Strips HTML tags and script/style/nav/header/footer elements, returning readable text
 * @param {string} html The raw HTML string.
 * @returns {string} The cleaned, visible text content.
 */
function cleanHtml(html) {
  if (!html) return '';
  
  // 1. Remove comments
  let clean = html.replace(/<!--[\s\S]*?-->/g, '');
  
  // 2. Remove script, style, head, nav, footer, header, svg elements
  const tagsToRemove = [
    /<script[\s\S]*?<\/script>/gi,
    /<style[\s\S]*?<\/style>/gi,
    /<head[\s\S]*?<\/head>/gi,
    /<nav[\s\S]*?<\/nav>/gi,
    /<footer[\s\S]*?<\/footer>/gi,
    /<header[\s\S]*?<\/header>/gi,
    /<svg[\s\S]*?<\/svg>/gi
  ];
  
  for (const tagPattern of tagsToRemove) {
    clean = clean.replace(tagPattern, ' ');
  }
  
  // 3. Extract text from HTML (remove remaining HTML tag structures)
  clean = clean.replace(/<[^>]+>/g, ' ');
  
  // 4. Decode common HTML entities
  clean = clean
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
    
  // 5. Replace multiple whitespace/newlines with a single space/newline
  clean = clean.replace(/\s+/g, ' ').trim();
  
  return clean;
}

/**
 * Fetches page content from a URL and returns sanitized text.
 * @param {string} url The target URL to fetch.
 * @returns {Promise<string|null>} The cleaned webpage text, or null if fetch fails.
 */
async function fetchPageContent(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(8000) // 8 second timeout
    });
    
    if (!response.ok) {
      logger.warn(`Failed to fetch URL ${url}: ${response.statusText} (Status: ${response.status})`);
      return null;
    }
    
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html') && !contentType.includes('text/plain')) {
      logger.info(`Skipping non-text fetch for ${url} (Content-Type: ${contentType})`);
      return null;
    }
    
    const html = await response.text();
    const cleanedText = cleanHtml(html);
    
    // Limit text to 15,000 characters to keep Gemini prompt tokens reasonable
    return cleanedText.substring(0, 15000);
  } catch (err) {
    logger.warn(`Error fetching web content from ${url}: ${err.message}`);
    return null;
  }
}

/**
 * Determines whether a message is a "bare link" (i.e. contains a URL with very little description).
 * @param {string} text The message text.
 * @param {Array<string>} urls The array of URLs in the message.
 * @returns {boolean} True if the message should trigger scraping, false otherwise.
 */
function isBareLink(text, urls) {
  if (!text || !urls || urls.length === 0) return false;
  
  // Strip the URLs from the text
  let textWithoutUrls = text;
  for (const url of urls) {
    textWithoutUrls = textWithoutUrls.replace(url, '');
  }
  
  // Strip emojis, punctuation, and extra spacing to see how much real description is left
  const cleanText = textWithoutUrls
    .replace(/[^a-zA-Z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  
  // If remaining text is short (less than 60 characters), it's a bare link
  return cleanText.length < 60;
}

module.exports = {
  fetchPageContent,
  isBareLink
};
