const { fetchPageContent, isBareLink, parseMetadataDirectly } = require('../src/utils/scraper');
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

  // Test 3: parseMetadataDirectly
  logger.info('\nTest 3: parseMetadataDirectly checks');
  logger.info(`Testing direct parser with ${testUrl} (should return null as it is not a job portal)...`);
  const metaResult = await parseMetadataDirectly(testUrl);
  logger.info(`Result: ${JSON.stringify(metaResult)} (Expected: null)`);

  // Test 3A: LinkedIn Style (Role at Company)
  const linkedinDataUri = 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<html><head><title>Software Engineer Intern at Microsoft</title><meta property="og:title" content="Software Engineer Intern at Microsoft"></head></html>'
  );
  logger.info('Testing direct parser with LinkedIn style (Role at Company)...');
  const linkedinMeta = await parseMetadataDirectly(linkedinDataUri);
  logger.info(`LinkedIn style Result: ${JSON.stringify(linkedinMeta)}`);
  if (linkedinMeta && linkedinMeta.company === 'Microsoft' && linkedinMeta.role === 'Software Engineer Intern') {
    logger.info('✅ LinkedIn style test passed!');
  } else {
    logger.error('❌ LinkedIn style test failed!');
  }

  // Test 3B: Lever Style (Company - Role)
  const leverDataUri = 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<html><head><title>Netflix - Software Engineer Intern</title><meta property="og:title" content="Netflix - Software Engineer Intern"><meta property="og:site_name" content="Netflix"></head></html>'
  );
  logger.info('Testing direct parser with Lever style (Company - Role)...');
  const leverMeta = await parseMetadataDirectly(leverDataUri);
  logger.info(`Lever style Result: ${JSON.stringify(leverMeta)}`);
  if (leverMeta && leverMeta.company === 'Netflix' && leverMeta.role === 'Software Engineer Intern') {
    logger.info('✅ Lever style test passed!');
  } else {
    logger.error('❌ Lever style test failed!');
  }

  // Test 3C: Greenhouse Style (Role - Company)
  const greenhouseDataUri = 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<html><head><title>Software Engineer - Google</title><meta property="og:title" content="Software Engineer - Google"><meta property="og:site_name" content="Google"></head></html>'
  );
  logger.info('Testing direct parser with Greenhouse style (Role - Company)...');
  const greenhouseMeta = await parseMetadataDirectly(greenhouseDataUri);
  logger.info(`Greenhouse style Result: ${JSON.stringify(greenhouseMeta)}`);
  if (greenhouseMeta && greenhouseMeta.company === 'Google' && greenhouseMeta.role === 'Software Engineer') {
    logger.info('✅ Greenhouse style test passed!');
  } else {
    logger.error('❌ Greenhouse style test failed!');
  }

  logger.info('=== SCRAPER TESTS COMPLETED ===');
}

runTests();
