const { fetchPageContent, isBareLink } = require('../src/utils/scraper');
const logger = require('../src/utils/logger');

async function runTests() {
  logger.info('=== STARTING SCRAPER TESTS ===');

  // Test 1: isBareLink
  logger.info('Test 1: isBareLink checks');
  
  const msg1 = 'https://careers.google.com/jobs/results/123456';
  const urls1 = [msg1];
  logger.info(`Message 1: "${msg1}" -> isBareLink? ${isBareLink(msg1, urls1)} (Expected: true)`);

  const msg2 = 'Check out this new job: https://careers.google.com/jobs/results/123456';
  const urls2 = ['https://careers.google.com/jobs/results/123456'];
  logger.info(`Message 2: "${msg2}" -> isBareLink? ${isBareLink(msg2, urls2)} (Expected: true)`);

  const msg3 = `Google is hiring a Software Engineering Intern!
Location: Bangalore, India
Eligibility: 2026 Graduates
Apply here: https://careers.google.com/jobs/results/123456
Apply ASAP!`;
  const urls3 = ['https://careers.google.com/jobs/results/123456'];
  logger.info(`Message 3 (long descriptive message) -> isBareLink? ${isBareLink(msg3, urls3)} (Expected: false)`);

  // Test 2: fetchPageContent
  logger.info('\nTest 2: fetchPageContent checks');
  const testUrl = 'https://example.com';
  logger.info(`Fetching and cleaning content from ${testUrl}...`);
  const content = await fetchPageContent(testUrl);
  if (content) {
    logger.info(`Successfully fetched example.com! Content snippet (first 300 chars):`);
    logger.info(`"""\n${content.substring(0, 300)}\n"""`);
  } else {
    logger.error(`Failed to fetch ${testUrl}`);
  }

  logger.info('=== SCRAPER TESTS COMPLETED ===');
}

runTests();
