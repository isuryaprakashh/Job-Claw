require('dotenv').config();
const { extractJobDetails } = require('../src/services/ai');
const logger = require('../src/utils/logger');

async function test() {
  const sampleMessage = `
    Here are two new opportunities for you:

    1. Google SWE Intern
    Apply: https://careers.google.com/jobs/results/1234567890
    Deadline: June 20, 2026
    Location: Bangalore, India
    Salary: ₹1,00,000/month
    Batch: 2027 grads

    2. Microsoft Coding Expert
    Apply: https://careers.microsoft.com/jobs/results/0987654321
    Deadline: June 30, 2026
    Location: Remote
    Salary: $120 per hour
    Batch: All college students
  `;

  logger.info('Starting Gemini extraction test...');
  const result = await extractJobDetails(sampleMessage);
  logger.info('Extraction result: %o', result);
}

test();
