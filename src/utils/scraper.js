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

/**
 * Helper to parse a single title candidate for company, role and opportunity type.
 */
function parseTitleCandidate(titleCandidate, ogSiteName, url) {
  if (!titleCandidate) return null;

  // Decode basic HTML entities in title Candidate
  let decodedTitle = titleCandidate
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");

  let company = '';
  let role = '';
  let opportunityType = 'job'; // Default

  const lowUrl = url.toLowerCase();
  const lowTitle = decodedTitle.toLowerCase();

  // Determine opportunity type
  if (lowUrl.includes('hackathon') || lowTitle.includes('hackathon')) {
    opportunityType = 'hackathon';
  } else if (
    lowUrl.includes('contest') || lowTitle.includes('contest') ||
    lowUrl.includes('competition') || lowTitle.includes('competition') ||
    lowUrl.includes('challenge') || lowTitle.includes('challenge') ||
    lowTitle.includes('ideathon') || lowTitle.includes('quiz')
  ) {
    opportunityType = 'competition';
  }

  // Heuristic patterns:
  // Pattern A: "Role @ Company" or "Role at Company"
  const atMatch = decodedTitle.match(/^([\s\S]+?)\s+@\s+([\s\S]+)$/i) || 
                  decodedTitle.match(/^([\s\S]+?)\s+at\s+([\s\S]+)$/i);
  if (atMatch) {
    role = atMatch[1].trim();
    company = atMatch[2].trim();
  } else {
    // Pattern B: "Company - Role" or "Role - Company"
    const dashParts = decodedTitle.split(/\s+-\s+|\s+\|\s+|\s+::\s+/);
    if (dashParts.length >= 2) {
      const first = dashParts[0].trim();
      const second = dashParts[1].trim();

      if (ogSiteName && second.toLowerCase().includes(ogSiteName.toLowerCase())) {
        role = first;
        company = second;
      } else if (ogSiteName && first.toLowerCase().includes(ogSiteName.toLowerCase())) {
        role = second;
        company = first;
      } else {
        role = first;
        company = second;
      }
    }
  }

  // Strip common garbage suffix from company or role
  if (company) {
    company = company
      .replace(/careers|jobs|job board|hiring portal|job portal|linkedin|lever|greenhouse|ashby|ashbyhq/gi, '')
      .replace(/^[\s\-\|]+|[\s\-\|]+$/g, '')
      .trim();
  }
  if (role) {
    role = role
      .replace(/job description|careers|jobs/gi, '')
      .replace(/^[\s\-\|]+|[\s\-\|]+$/g, '')
      .trim();
  }

  if (company && role && company.length >= 2 && role.length >= 3 && company.length < 50 && role.length < 100) {
    return { company, role, opportunityType };
  }

  return null;
}

/**
 * Tries to parse opportunity metadata directly from webpage HTML without AI.
 * @param {string} url The opportunity URL.
 * @returns {Promise<object|null>} The opportunity details, or null if direct parsing fails/is not confident.
 */
async function parseMetadataDirectly(url) {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/115.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8'
      },
      signal: AbortSignal.timeout(8000)
    });

    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return null;

    const html = await response.text();

    // 1. Extract potential titles
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const htmlTitle = titleMatch ? titleMatch[1].trim() : '';

    const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
                         html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
    const ogTitle = ogTitleMatch ? ogTitleMatch[1].trim() : '';

    const nameTitleMatch = html.match(/<meta[^>]+name=["']title["'][^>]+content=["']([^"']+)["']/i) ||
                           html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']title["']/i);
    const nameTitle = nameTitleMatch ? nameTitleMatch[1].trim() : '';

    const twitterTitleMatch = html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i) ||
                              html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:title["']/i);
    const twitterTitle = twitterTitleMatch ? twitterTitleMatch[1].trim() : '';

    const ogSiteNameMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ||
                            html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);
    const ogSiteName = ogSiteNameMatch ? ogSiteNameMatch[1].trim() : '';

    const ogDescMatch = html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
                        html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) ||
                        html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i);
    const ogDesc = ogDescMatch ? ogDescMatch[1].trim() : '';

    // Test candidates in order of richness
    const candidates = [nameTitle, htmlTitle, twitterTitle, ogTitle];
    let parseResult = null;
    for (const candidate of candidates) {
      if (!candidate) continue;
      parseResult = parseTitleCandidate(candidate, ogSiteName, url);
      if (parseResult) break;
    }

    if (parseResult) {
      // Parse location heuristics from description
      let location = '';
      const lowTitle = (nameTitle + ' ' + htmlTitle + ' ' + ogTitle).toLowerCase();
      const lowDesc = ogDesc.toLowerCase();

      if (lowTitle.includes('remote') || lowDesc.includes('remote')) {
        location = 'Remote';
      } else if (lowTitle.includes('online') || lowDesc.includes('online')) {
        location = 'Online';
      } else {
        const locations = ['bangalore', 'bengaluru', 'noida', 'gurgaon', 'gurugram', 'hyderabad', 'pune', 'mumbai', 'chennai'];
        for (const loc of locations) {
          if (lowDesc.includes(loc) || lowTitle.includes(loc)) {
            location = loc.charAt(0).toUpperCase() + loc.slice(1);
            break;
          }
        }
      }

      // Try to extract batch eligibility
      let batchEligibility = '';
      const batchMatch = ogDesc.match(/\b(202[4-8])\b/);
      if (batchMatch) {
        batchEligibility = `${batchMatch[1]} Batch`;
      }

      return {
        opportunityType: parseResult.opportunityType,
        company: parseResult.company,
        role: parseResult.role,
        applyLink: url,
        deadline: null,
        location,
        salary: '',
        batchEligibility,
        prize: '',
        eventDate: null,
        format: ''
      };
    }

    return null;
  } catch (err) {
    logger.warn(`Direct metadata parsing failed for ${url}: ${err.message}`);
    return null;
  }
}

module.exports = {
  fetchPageContent,
  isBareLink,
  parseMetadataDirectly
};
